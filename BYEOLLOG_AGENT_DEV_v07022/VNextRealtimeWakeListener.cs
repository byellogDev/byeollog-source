using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace HurogiCollector;

/// <summary>
/// Supabase private Broadcast는 작업 내용을 전달하지 않고 "다시 claim 하라"는
/// 힌트만 보낸다. 실행 선택·장치 비밀 검증·lease 획득은 기존 agent-runtime RPC가
/// 계속 단독으로 담당하므로 WebSocket 유실·중복은 안전한 재조회로 수렴한다.
/// </summary>
internal sealed class VNextRealtimeWakeListener : IDisposable
{
    private static readonly TimeSpan HeartbeatInterval = TimeSpan.FromSeconds(20);
    private static readonly TimeSpan ReceiveSilenceTimeout = TimeSpan.FromSeconds(35);
    private static readonly TimeSpan SessionRefreshInterval = TimeSpan.FromMinutes(40);
    private const int MaximumMessageBytes = 64 * 1024;

    private readonly Func<CancellationToken, Task<VNextRealtimeCredentials>> _credentials;
    private readonly Action _wake;
    private readonly Action _wallpaperWake;
    private readonly Action<string> _log;
    private readonly CancellationTokenSource _stop = new();
    private readonly object _connectionGate = new();
    private CancellationTokenSource? _connectionReset;
    private Task? _loop;
    private int _connected;
    private int _disposed;

    public VNextRealtimeWakeListener(
        Func<CancellationToken, Task<VNextRealtimeCredentials>> credentials,
        Action wake,
        Action wallpaperWake,
        Action<string> log)
    {
        _credentials = credentials;
        _wake = wake;
        _wallpaperWake = wallpaperWake;
        _log = log;
    }

    public bool Connected => Volatile.Read(ref _connected) != 0;

    public void Start()
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);
        if (_loop is not null) return;
        _loop = Task.Run(() => RunAsync(_stop.Token));
    }

    public void Reconnect()
    {
        if (Volatile.Read(ref _disposed) != 0) return;
        lock (_connectionGate)
        {
            try { _connectionReset?.Cancel(); }
            catch (ObjectDisposedException) { }
        }
        _wake();
    }

    private async Task RunAsync(CancellationToken cancellationToken)
    {
        var failures = 0;
        while (!cancellationToken.IsCancellationRequested)
        {
            using var reset = new CancellationTokenSource();
            lock (_connectionGate) _connectionReset = reset;
            using var connection = CancellationTokenSource.CreateLinkedTokenSource(
                cancellationToken,
                reset.Token);
            connection.CancelAfter(SessionRefreshInterval);
            try
            {
                await RunConnectionAsync(connection.Token);
                failures = 0;
            }
            catch (OperationCanceledException) when (connection.IsCancellationRequested)
            {
                failures = 0;
            }
            catch (Exception error)
            {
                failures++;
                if (failures == 1 || failures % 6 == 0)
                    _log("Realtime 깨우기 재연결 · type=" + error.GetType().Name);
            }
            finally
            {
                SetConnected(false);
                lock (_connectionGate)
                {
                    if (ReferenceEquals(_connectionReset, reset)) _connectionReset = null;
                }
            }

            if (cancellationToken.IsCancellationRequested) break;
            var retrySeconds = Math.Min(10, failures <= 1 ? 1 : 1 << Math.Min(failures - 1, 3));
            try { await Task.Delay(TimeSpan.FromSeconds(retrySeconds), cancellationToken); }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { break; }
        }
    }

    private async Task RunConnectionAsync(CancellationToken cancellationToken)
    {
        var credentials = await _credentials(cancellationToken);
        if (!Guid.TryParseExact(credentials.WorkspaceId, "D", out var workspaceId))
            throw new InvalidDataException("Realtime 워크스페이스 식별값이 올바르지 않습니다.");

        var endpoint = VNextDevelopmentClient.SupabaseUrl.Replace(
            "https://",
            "wss://",
            StringComparison.OrdinalIgnoreCase)
            + "/realtime/v1/websocket?apikey="
            + Uri.EscapeDataString(VNextDevelopmentClient.PublishableKey)
            + "&vsn=1.0.0";
        var channel = "realtime:agent-wake:" + workspaceId.ToString("D");
        const string joinRef = "1";
        using var socket = new ClientWebSocket();
        socket.Options.KeepAliveInterval = Timeout.InfiniteTimeSpan;
        await socket.ConnectAsync(new Uri(endpoint), cancellationToken);
        await SendAsync(socket, new
        {
            topic = channel,
            @event = "phx_join",
            payload = new
            {
                config = new
                {
                    broadcast = new { ack = false, self = false },
                    presence = new { enabled = false },
                    postgres_changes = Array.Empty<object>(),
                    @private = true
                },
                access_token = credentials.AccessToken
            },
            @ref = joinRef,
            join_ref = joinRef
        }, cancellationToken);

        using var heartbeatStop = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var heartbeat = HeartbeatAsync(socket, heartbeatStop.Token);
        try
        {
            await ReceiveAsync(socket, channel, joinRef, cancellationToken);
        }
        finally
        {
            heartbeatStop.Cancel();
            try { await heartbeat; }
            catch (OperationCanceledException) when (heartbeatStop.IsCancellationRequested) { }
            catch (WebSocketException) { }
        }
    }

    private async Task ReceiveAsync(
        ClientWebSocket socket,
        string channel,
        string joinRef,
        CancellationToken cancellationToken)
    {
        var buffer = new byte[8 * 1024];
        using var message = new MemoryStream();
        while (socket.State == WebSocketState.Open && !cancellationToken.IsCancellationRequested)
        {
            message.SetLength(0);
            WebSocketReceiveResult result;
            do
            {
                using var receiveDeadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                receiveDeadline.CancelAfter(ReceiveSilenceTimeout);
                try
                {
                    result = await socket.ReceiveAsync(
                        new ArraySegment<byte>(buffer),
                        receiveDeadline.Token);
                }
                catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
                {
                    throw new WebSocketException(
                        "Supabase Realtime heartbeat 응답이 지연됐습니다.");
                }
                if (result.MessageType == WebSocketMessageType.Close)
                    throw new WebSocketException("Supabase Realtime 연결이 종료됐습니다.");
                if (result.MessageType != WebSocketMessageType.Text)
                    continue;
                if (message.Length + result.Count > MaximumMessageBytes)
                    throw new InvalidDataException("Realtime 메시지가 허용 크기를 초과했습니다.");
                message.Write(buffer, 0, result.Count);
            } while (!result.EndOfMessage);

            if (message.Length == 0 || result.MessageType != WebSocketMessageType.Text) continue;
            using var document = JsonDocument.Parse(message.ToArray());
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) continue;
            var eventName = StringProperty(root, "event");
            var topic = StringProperty(root, "topic");
            if (eventName == "phx_reply" && StringProperty(root, "ref") == joinRef)
            {
                if (!root.TryGetProperty("payload", out var reply)
                    || StringProperty(reply, "status") != "ok")
                    throw new UnauthorizedAccessException("Supabase Realtime private 채널 참여가 거부됐습니다.");
                SetConnected(true);
                _wake();
                // Broadcast는 내구 큐가 아닌 깨우기 힌트다. 연결이 끊긴
                // 사이 wallpaper_changed를 놓쳤을 수 있으므로 채널 재가입
                // 직후 현재 revision을 한 번 대조한다. 실제 payload는
                // 별도 PostgREST 경로에서 받아 액션 claim을 막지 않는다.
                _wallpaperWake();
                continue;
            }
            if (eventName is "phx_error" or "phx_close")
                throw new WebSocketException("Supabase Realtime 채널이 종료됐습니다.");
            if (eventName != "broadcast" || !string.Equals(topic, channel, StringComparison.Ordinal))
                continue;
            if (!root.TryGetProperty("payload", out var broadcast)
                || broadcast.ValueKind != JsonValueKind.Object)
                continue;
            var broadcastEvent = StringProperty(broadcast, "event");
            if (broadcastEvent == "wallpaper_changed")
            {
                // 액션 wake와 달리 풍벽지 변경은 snapshot throttle 사이에서도
                // 유실되지 않도록 Agent의 pending 세대에 먼저 기록한다.
                _wallpaperWake();
                continue;
            }
            if (broadcastEvent != "execution_changed") continue;
            DateTimeOffset? notBefore = null;
            if (broadcast.TryGetProperty("payload", out var payload)
                && payload.ValueKind == JsonValueKind.Object
                && payload.TryGetProperty("notBefore", out var due)
                && due.ValueKind == JsonValueKind.String
                && DateTimeOffset.TryParse(due.GetString(), out var parsed))
                notBefore = parsed;
            // 세션 토큰을 주기적으로 갱신해도 이미 받은 retry 예약은 잃지 않는다.
            ScheduleWake(notBefore, _stop.Token);
        }
    }

    private void ScheduleWake(DateTimeOffset? notBefore, CancellationToken cancellationToken)
    {
        var delay = notBefore.GetValueOrDefault() - DateTimeOffset.UtcNow;
        if (!notBefore.HasValue || delay <= TimeSpan.FromMilliseconds(250))
        {
            _wake();
            return;
        }
        if (delay > TimeSpan.FromHours(6)) delay = TimeSpan.FromHours(6);
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(delay, cancellationToken);
                _wake();
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
        }, CancellationToken.None);
    }

    private async Task HeartbeatAsync(ClientWebSocket socket, CancellationToken cancellationToken)
    {
        var sequence = 2L;
        while (!cancellationToken.IsCancellationRequested && socket.State == WebSocketState.Open)
        {
            await Task.Delay(HeartbeatInterval, cancellationToken);
            await SendAsync(socket, new
            {
                topic = "phoenix",
                @event = "heartbeat",
                payload = new { },
                @ref = Interlocked.Increment(ref sequence).ToString(),
                join_ref = (string?)null
            }, cancellationToken);
        }
    }

    private static async Task SendAsync(
        ClientWebSocket socket,
        object value,
        CancellationToken cancellationToken)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(value);
        await socket.SendAsync(bytes, WebSocketMessageType.Text, true, cancellationToken);
    }

    private void SetConnected(bool connected)
    {
        var value = connected ? 1 : 0;
        if (Interlocked.Exchange(ref _connected, value) == value) return;
        _log(connected
            ? "Realtime 깨우기 연결됨 · 이벤트 즉시 수신 · 10분 누락 복구"
            : "Realtime 깨우기 연결 해제 · 액션 2초 · 풍벽지 5초 안전 재조회");
        _wake();
        if (!connected) _wallpaperWake();
    }

    private static string StringProperty(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? ""
            : "";

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        _stop.Cancel();
        lock (_connectionGate)
        {
            try { _connectionReset?.Cancel(); }
            catch (ObjectDisposedException) { }
        }
        try { _loop?.Wait(TimeSpan.FromSeconds(2)); } catch { }
        lock (_connectionGate)
        {
            _connectionReset?.Dispose();
            _connectionReset = null;
        }
        _stop.Dispose();
    }
}
