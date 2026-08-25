using System.Buffers;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace HurogiCollector;

internal sealed record ObsServerInfo(
    string ObsStudioVersion,
    string ObsWebSocketVersion,
    IReadOnlySet<string> AvailableRequests);

internal sealed record ObsInputSummary(
    string InputName,
    string InputKind,
    string UnversionedInputKind);

internal sealed record ObsSourceFilterSummary(
    string FilterName,
    string FilterKind,
    bool FilterEnabled,
    int FilterIndex);

internal sealed class ObsAuthenticationException : Exception
{
    public ObsAuthenticationException(string message) : base(message) { }
}

internal sealed class ObsProtocolException : Exception
{
    public int CloseCode { get; }

    public ObsProtocolException(int closeCode) : base("OBS WebSocket protocol negotiation failed")
    {
        CloseCode = closeCode;
    }
}

internal sealed class ObsRequestException : Exception
{
    public int Code { get; }

    public ObsRequestException(int code, string message) : base(message)
    {
        Code = code;
    }
}

/// <summary>
/// OBS WebSocket 5.x의 최소 로컬 전용 클라이언트입니다.
/// 임의 URL과 임의 request passthrough를 허용하지 않고 127.0.0.1만 사용합니다.
/// </summary>
internal sealed class ObsWebSocketClient : IAsyncDisposable
{
    private const int MaxMessageBytes = 1024 * 1024;
    private readonly ClientWebSocket _socket = new();
    private bool _identified;

    private ObsWebSocketClient()
    {
        _socket.Options.AddSubProtocol("obswebsocket.json");
        _socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
    }

    public static async Task<ObsWebSocketClient> ConnectAsync(
        ObsConnectionSettings settings,
        CancellationToken cancellationToken)
    {
        if (settings.Port is < 1 or > 65535)
            throw new ArgumentOutOfRangeException(nameof(settings), "OBS 포트 범위가 올바르지 않습니다.");

        var client = new ObsWebSocketClient();
        try
        {
            // 첫 릴리스는 같은 PC의 OBS만 제어합니다. LAN/인터넷 주소는 입력받지 않습니다.
            await client._socket.ConnectAsync(
                new Uri($"ws://127.0.0.1:{settings.Port}"),
                cancellationToken);
            await client.IdentifyAsync(settings.Password ?? "", cancellationToken);
            return client;
        }
        catch
        {
            await client.DisposeAsync();
            throw;
        }
    }

    private async Task IdentifyAsync(string password, CancellationToken cancellationToken)
    {
        var hello = await ReceiveJsonAsync(cancellationToken);
        if (!TryGetOpcode(hello, out var opcode) || opcode != 0
            || !hello.TryGetProperty("d", out var data)
            || data.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException("OBS Hello 응답 형식이 올바르지 않습니다.");

        var rpcVersion = data.TryGetProperty("rpcVersion", out var rpcValue)
            && rpcValue.TryGetInt32(out var parsedRpc)
            ? parsedRpc
            : 0;
        if (rpcVersion < 1)
            throw new InvalidDataException("OBS WebSocket RPC 1을 지원하지 않습니다.");

        string? authentication = null;
        if (data.TryGetProperty("authentication", out var auth)
            && auth.ValueKind == JsonValueKind.Object)
        {
            if (string.IsNullOrEmpty(password))
                throw new ObsAuthenticationException("OBS WebSocket 비밀번호가 필요합니다.");
            var challenge = RequiredString(auth, "challenge");
            var salt = RequiredString(auth, "salt");
            authentication = CreateAuthentication(password, salt, challenge);
        }

        object identifyData = authentication is null
            ? new { rpcVersion = 1, eventSubscriptions = 0 }
            : new { rpcVersion = 1, authentication, eventSubscriptions = 0 };
        await SendJsonAsync(new { op = 1, d = identifyData }, cancellationToken);

        var identified = await ReceiveJsonAsync(cancellationToken);
        if (!TryGetOpcode(identified, out opcode) || opcode != 2)
            throw new ObsAuthenticationException("OBS WebSocket 인증 또는 버전 협상에 실패했습니다.");
        _identified = true;
    }

    public async Task<ObsServerInfo> GetVersionAsync(CancellationToken cancellationToken)
    {
        var response = await RequestAsync("GetVersion", null, cancellationToken);
        var obsVersion = OptionalString(response, "obsVersion");
        var webSocketVersion = OptionalString(response, "obsWebSocketVersion");
        var available = new HashSet<string>(StringComparer.Ordinal);
        if (response.TryGetProperty("availableRequests", out var requests)
            && requests.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in requests.EnumerateArray())
            {
                if (item.ValueKind == JsonValueKind.String && item.GetString() is { Length: > 0 } name)
                    available.Add(name);
            }
        }
        return new ObsServerInfo(obsVersion, webSocketVersion, available);
    }

    public async Task<IReadOnlyList<ObsInputSummary>> GetInputListAsync(
        CancellationToken cancellationToken)
    {
        var response = await RequestAsync("GetInputList", null, cancellationToken);
        if (!response.TryGetProperty("inputs", out var inputs)
            || inputs.ValueKind != JsonValueKind.Array)
            throw new InvalidDataException("OBS 입력 목록 응답이 올바르지 않습니다.");

        var result = new List<ObsInputSummary>();
        foreach (var input in inputs.EnumerateArray())
        {
            if (input.ValueKind != JsonValueKind.Object) continue;
            var name = OptionalString(input, "inputName");
            if (name.Length == 0) continue;
            result.Add(new ObsInputSummary(
                name,
                OptionalString(input, "inputKind"),
                OptionalString(input, "unversionedInputKind")));
        }
        return result;
    }

    public async Task<JsonElement> GetInputSettingsAsync(
        string inputName,
        CancellationToken cancellationToken)
    {
        var response = await RequestAsync(
            "GetInputSettings",
            new { inputName },
            cancellationToken);
        if (!response.TryGetProperty("inputSettings", out var settings)
            || settings.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException("OBS 입력 설정 응답이 올바르지 않습니다.");
        return settings.Clone();
    }

    public async Task SetInputSettingsOverlayAsync(
        string inputName,
        object inputSettings,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(inputName))
            throw new ArgumentException("OBS 입력 이름이 비어 있습니다.", nameof(inputName));
        ArgumentNullException.ThrowIfNull(inputSettings);
        await RequestAsync(
            "SetInputSettings",
            new { inputName, inputSettings, overlay = true },
            cancellationToken);
    }

    public async Task PressInputPropertiesButtonAsync(
        string inputName,
        string propertyName,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(inputName) || string.IsNullOrWhiteSpace(propertyName))
            throw new ArgumentException("OBS 입력 또는 속성 이름이 비어 있습니다.");
        await RequestAsync(
            "PressInputPropertiesButton",
            new { inputName, propertyName },
            cancellationToken);
    }

    public async Task<bool> GetInputMuteAsync(string inputName, CancellationToken cancellationToken)
    {
        var response = await RequestAsync(
            "GetInputMute",
            new { inputName },
            cancellationToken);
        if (!response.TryGetProperty("inputMuted", out var muted)
            || muted.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            throw new InvalidDataException("OBS 음소거 상태 응답이 올바르지 않습니다.");
        return muted.GetBoolean();
    }

    public async Task SetInputMuteAsync(
        string inputName,
        bool muted,
        CancellationToken cancellationToken)
    {
        await RequestAsync(
            "SetInputMute",
            new { inputName, inputMuted = muted },
            cancellationToken);
    }

    public async Task<IReadOnlyList<ObsSourceFilterSummary>> GetSourceFilterListAsync(
        string sourceName,
        CancellationToken cancellationToken)
    {
        ValidateObsName(sourceName, nameof(sourceName));
        var response = await RequestAsync(
            "GetSourceFilterList",
            new { sourceName },
            cancellationToken);
        if (!response.TryGetProperty("filters", out var filters)
            || filters.ValueKind != JsonValueKind.Array)
            throw new InvalidDataException("OBS 필터 목록 응답이 올바르지 않습니다.");

        var result = new List<ObsSourceFilterSummary>();
        foreach (var filter in filters.EnumerateArray())
        {
            if (filter.ValueKind != JsonValueKind.Object) continue;
            var filterName = OptionalString(filter, "filterName");
            var filterKind = OptionalString(filter, "filterKind");
            if (filterName.Length == 0 || filterKind.Length == 0) continue;
            if (!filter.TryGetProperty("filterEnabled", out var enabled)
                || enabled.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                continue;
            var index = filter.TryGetProperty("filterIndex", out var indexValue)
                && indexValue.TryGetInt32(out var parsedIndex)
                ? parsedIndex
                : -1;
            result.Add(new ObsSourceFilterSummary(
                filterName,
                filterKind,
                enabled.GetBoolean(),
                index));
        }
        return result;
    }

    public async Task<ObsSourceFilterSummary> GetSourceFilterAsync(
        string sourceName,
        string filterName,
        CancellationToken cancellationToken)
    {
        ValidateObsName(sourceName, nameof(sourceName));
        ValidateObsName(filterName, nameof(filterName));
        var response = await RequestAsync(
            "GetSourceFilter",
            new { sourceName, filterName },
            cancellationToken);
        var returnedName = OptionalString(response, "filterName");
        var kind = OptionalString(response, "filterKind");
        if (!string.Equals(returnedName, filterName, StringComparison.Ordinal)
            || kind.Length == 0
            || !response.TryGetProperty("filterEnabled", out var enabled)
            || enabled.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            throw new InvalidDataException("OBS 필터 상태 응답이 올바르지 않습니다.");
        var index = response.TryGetProperty("filterIndex", out var indexValue)
            && indexValue.TryGetInt32(out var parsedIndex)
            ? parsedIndex
            : -1;
        return new ObsSourceFilterSummary(returnedName, kind, enabled.GetBoolean(), index);
    }

    public async Task SetSourceFilterEnabledAsync(
        string sourceName,
        string filterName,
        bool filterEnabled,
        CancellationToken cancellationToken)
    {
        ValidateObsName(sourceName, nameof(sourceName));
        ValidateObsName(filterName, nameof(filterName));
        await RequestAsync(
            "SetSourceFilterEnabled",
            new { sourceName, filterName, filterEnabled },
            cancellationToken);
    }

    private static void ValidateObsName(string value, string parameterName)
    {
        if (string.IsNullOrWhiteSpace(value)
            || value.Length > 128
            || value.Any(char.IsControl))
            throw new ArgumentException("OBS 소스 또는 필터 이름이 올바르지 않습니다.", parameterName);
    }

    private async Task<JsonElement> RequestAsync(
        string requestType,
        object? requestData,
        CancellationToken cancellationToken)
    {
        if (!_identified) throw new InvalidOperationException("OBS 연결이 식별되지 않았습니다.");
        var requestId = Guid.NewGuid().ToString("D");
        object data = requestData is null
            ? new { requestType, requestId }
            : new { requestType, requestId, requestData };
        await SendJsonAsync(new { op = 6, d = data }, cancellationToken);

        while (true)
        {
            var message = await ReceiveJsonAsync(cancellationToken);
            if (!TryGetOpcode(message, out var opcode))
                throw new InvalidDataException("OBS 응답에 opcode가 없습니다.");
            if (opcode == 5) continue;
            if (opcode != 7
                || !message.TryGetProperty("d", out var body)
                || body.ValueKind != JsonValueKind.Object)
                throw new InvalidDataException("OBS 요청 응답 형식이 올바르지 않습니다.");

            if (!string.Equals(OptionalString(body, "requestId"), requestId, StringComparison.Ordinal))
                continue;
            if (!string.Equals(OptionalString(body, "requestType"), requestType, StringComparison.Ordinal))
                throw new InvalidDataException("OBS 요청 종류가 응답과 일치하지 않습니다.");
            if (!body.TryGetProperty("requestStatus", out var status)
                || status.ValueKind != JsonValueKind.Object
                || !status.TryGetProperty("result", out var result)
                || result.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                throw new InvalidDataException("OBS 요청 상태 형식이 올바르지 않습니다.");

            var code = status.TryGetProperty("code", out var codeValue)
                && codeValue.TryGetInt32(out var parsedCode)
                ? parsedCode
                : 0;
            if (!result.GetBoolean())
            {
                var comment = OptionalString(status, "comment");
                throw new ObsRequestException(code, SafeObsError(comment, code));
            }

            if (body.TryGetProperty("responseData", out var responseData)
                && responseData.ValueKind == JsonValueKind.Object)
                return responseData.Clone();
            using var empty = JsonDocument.Parse("{}");
            return empty.RootElement.Clone();
        }
    }

    private async Task SendJsonAsync(object value, CancellationToken cancellationToken)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(value);
        await _socket.SendAsync(bytes, WebSocketMessageType.Text, true, cancellationToken);
    }

    private async Task<JsonElement> ReceiveJsonAsync(CancellationToken cancellationToken)
    {
        var rented = ArrayPool<byte>.Shared.Rent(8192);
        try
        {
            using var output = new MemoryStream();
            while (true)
            {
                var result = await _socket.ReceiveAsync(rented.AsMemory(0, rented.Length), cancellationToken);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    var status = _socket.CloseStatus is null ? 0 : (int)_socket.CloseStatus.Value;
                    if (status == 4009)
                        throw new ObsAuthenticationException("OBS WebSocket 인증에 실패했습니다.");
                    if (status is >= 4000 and <= 4012)
                        throw new ObsProtocolException(status);

                    // OBS가 정의한 식별/세션 오류가 아닌 연결 종료는 일시 장애일 수 있습니다.
                    // 절대 상태 지정 액션은 같은 값으로 안전하게 재시도할 수 있게 transport 오류로 분류합니다.
                    throw new WebSocketException(WebSocketError.ConnectionClosedPrematurely);
                }
                if (result.MessageType != WebSocketMessageType.Text)
                    throw new InvalidDataException("OBS가 텍스트가 아닌 응답을 보냈습니다.");
                if (output.Length + result.Count > MaxMessageBytes)
                    throw new InvalidDataException("OBS 응답 크기 제한을 초과했습니다.");
                output.Write(rented, 0, result.Count);
                if (result.EndOfMessage) break;
            }
            output.Position = 0;
            using var document = await JsonDocument.ParseAsync(output, cancellationToken: cancellationToken);
            return document.RootElement.Clone();
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(rented);
        }
    }

    private static string CreateAuthentication(string password, string salt, string challenge)
    {
        var secretHash = SHA256.HashData(Encoding.UTF8.GetBytes(password + salt));
        var secret = Convert.ToBase64String(secretHash);
        var authHash = SHA256.HashData(Encoding.UTF8.GetBytes(secret + challenge));
        return Convert.ToBase64String(authHash);
    }

    private static bool TryGetOpcode(JsonElement value, out int opcode)
    {
        opcode = 0;
        return value.ValueKind == JsonValueKind.Object
            && value.TryGetProperty("op", out var op)
            && op.TryGetInt32(out opcode);
    }

    private static string RequiredString(JsonElement value, string name)
    {
        var result = OptionalString(value, name);
        return result.Length > 0
            ? result
            : throw new InvalidDataException($"OBS {name} 값이 없습니다.");
    }

    private static string OptionalString(JsonElement value, string name) =>
        value.TryGetProperty(name, out var item) && item.ValueKind == JsonValueKind.String
            ? item.GetString() ?? ""
            : "";

    private static string SafeObsError(string comment, int code)
    {
        var safe = new string((comment ?? "").Where(ch => !char.IsControl(ch)).Take(240).ToArray());
        return safe.Length == 0
            ? $"OBS 요청이 거부되었습니다. (code {code})"
            : $"OBS 요청이 거부되었습니다. (code {code}: {safe})";
    }

    public async ValueTask DisposeAsync()
    {
        try
        {
            if (_socket.State == WebSocketState.Open)
            {
                using var closeTimeout = new CancellationTokenSource(TimeSpan.FromMilliseconds(500));
                await _socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "byeollog action complete", closeTimeout.Token);
            }
        }
        catch { }
        _socket.Dispose();
    }
}
