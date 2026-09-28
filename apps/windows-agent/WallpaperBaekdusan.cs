using System.Text.Json;
using System.Text.Json.Nodes;

namespace HurogiCollector;

// Workspace-scoped, local presentation only. The original ledger and layouts
// remain untouched, so removing a run restores ordinary rendering immediately.
internal sealed class WallpaperBaekdusan : IDisposable
{
    internal sealed record Tip(string Id, string SessionId, long SequenceNo, string ActorName, int Amount, string ReceivedAt);
    internal sealed record Run(string Id, string SessionId, int Start, int Target, List<Tip> Members,
        int X = 40, int Y = 40, int Width = 960, int Height = 560, int Columns = 10,
        bool Closed = false, long ScanCursor = 0);
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private readonly string _path;
    private readonly Func<JsonElement?, CancellationToken, Task<JsonElement>> _send;
    private readonly Func<bool> _signedIn;
    private readonly Action _changed;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly CancellationTokenSource _stop = new();
    private readonly Task _worker;
    private readonly SemaphoreSlim _wake = new(0, 1);
    private List<Run> _runs = [];
    private string[] _selected = [];
    private string _error = "";
    private long _version;
    private readonly object _viewLock = new();
    private JsonElement _view = JsonSerializer.SerializeToElement(new { runs = Array.Empty<object>(), version = 0, error = "" });

    internal WallpaperBaekdusan(string root, Func<bool> signedIn,
        Func<JsonElement?, CancellationToken, Task<JsonElement>> send, Action changed, bool startWorker = true)
    {
        _path = Path.Combine(root, "wallpaper-baekdusan-v1.json");
        _send = send; _signedIn = signedIn; _changed = changed;
        if (File.Exists(_path))
        {
            try
            {
                if (new FileInfo(_path).Length > 1024 * 1024) throw new InvalidDataException();
                using var doc = JsonDocument.Parse(File.ReadAllBytes(_path));
                _runs = doc.RootElement.GetProperty("runs").Deserialize<List<Run>>(Json) ?? [];
                _selected = doc.RootElement.GetProperty("selected").Deserialize<string[]>() ?? [];
                Validate(_runs);
            }
            catch { _runs = []; _selected = []; _error = "백두산 저장 파일을 읽지 못했습니다. 원본 파일은 보존됩니다."; }
        }
        Publish();
        _worker = startWorker ? Task.Run(ObserveAsync) : Task.CompletedTask;
    }

    internal void Notify() { try { _wake.Release(); } catch (SemaphoreFullException) { } }
    internal JsonElement View { get { lock (_viewLock) return _view.Clone(); } }
    private void Publish()
    {
        lock (_viewLock) _view = JsonSerializer.SerializeToElement(new
        {
            runs = _runs, selectedSessionIds = _selected, version = ++_version, error = _error
        }, Json);
        _changed();
    }
    internal JsonElement Decorate(JsonElement source)
    {
        var root = JsonNode.Parse(source.GetRawText())!.AsObject();
        var view = View;
        root["baekdusan"] = JsonNode.Parse(view.GetRawText());
        root["displayKey"] = (root["displayKey"]?.GetValue<string>() ?? "") + ":baek:" + view.GetProperty("version").GetInt64();
        return JsonSerializer.SerializeToElement(root);
    }
    internal async Task SelectAsync(JsonElement source, CancellationToken token)
    {
        if (!source.TryGetProperty("selectedSessionIds", out var ids)) return;
        var selected = ids.EnumerateArray().Select(x => x.GetString()!).ToArray();
        await _gate.WaitAsync(token);
        try
        {
            if (_error.StartsWith("백두산 저장 파일") || _selected.SequenceEqual(selected)) return;
            await SaveAsync(_runs, selected, token);
            _selected = selected; Publish();
        }
        finally { _gate.Release(); }
    }
    internal async Task<JsonElement> ControlAsync(JsonElement body, CancellationToken token)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(token, _stop.Token);
        token = linked.Token;
        var action = body.GetProperty("action").GetString();
        if (action == "baekdusan-log") return await _send(body, token);
        await _gate.WaitAsync(token);
        try
        {
            if (_error.StartsWith("백두산 저장 파일")) throw new InvalidDataException(_error);
            var next = _runs.Select(r => r with { Members = [..r.Members] }).ToList();
            if (action == "baekdusan-create")
            {
                var sessionId = body.GetProperty("sessionId").GetString();
                var id = body.GetProperty("tileId").GetString();
                var target = body.GetProperty("target").GetInt32();
                if (!Guid.TryParse(sessionId, out _) || !Guid.TryParse(id, out _) || target is < 1 or > 1_000_000)
                    throw new InvalidDataException("시작 후원과 목표 숫자를 확인해주세요.");
                if (next.Any(r => r.SessionId == sessionId)) throw new InvalidDataException("이 방송에는 이미 백두산이 있습니다. 기존 묶기를 해제한 뒤 다시 설정해주세요.");
                var response = await _send(JsonSerializer.SerializeToElement(new { action = "baekdusan-log", sessionId, tileId = id }), token);
                var tips = response.GetProperty("tiles").Deserialize<List<Tip>>(Json)!;
                var first = tips.SingleOrDefault(t => t.Id == id && t.SessionId == sessionId)
                    ?? throw new InvalidDataException("시작 후원 기록이 없거나 보관 기간이 지났습니다.");
                if (target < first.Amount || target - first.Amount + 1 > 500)
                    throw new InvalidDataException("목표는 시작 숫자 이상, 최대 500칸까지 설정할 수 있습니다.");
                next.Add(new Run(Guid.NewGuid().ToString("D"), sessionId!, first.Amount, target, [first]));
            }
            else
            {
                var id = body.GetProperty("id").GetString();
                var index = next.FindIndex(r => r.Id == id);
                if (index < 0) throw new InvalidDataException("백두산을 찾을 수 없습니다.");
                if (action == "baekdusan-remove") next.RemoveAt(index);
                else if (action == "baekdusan-layout")
                    next[index] = next[index] with
                    {
                        X = body.GetProperty("x").GetInt32(), Y = body.GetProperty("y").GetInt32(),
                        Width = body.GetProperty("width").GetInt32(), Height = body.GetProperty("height").GetInt32(),
                        Columns = body.GetProperty("columns").GetInt32()
                    };
                else throw new InvalidDataException("백두산 요청이 올바르지 않습니다.");
            }
            Validate(next);
            await SaveAsync(next, _selected, token);
            _runs = next; _error = ""; Publish(); Notify();
            return View;
        }
        finally { _gate.Release(); }
    }
    internal static void Validate(List<Run> runs)
    {
        if (runs.Count > 10 || runs.Sum(r => (long)r.Target - r.Start + 1) > 1000
            || runs.Select(r => r.SessionId).Distinct().Count() != runs.Count)
            throw new InvalidDataException("백두산은 방송당 하나, 전체 10묶음·1,000칸까지 보관할 수 있습니다.");
        var used = new HashSet<string>();
        foreach (var r in runs)
        {
            if (!Guid.TryParse(r.Id, out _) || !Guid.TryParse(r.SessionId, out _) || r.Start < 1 || r.Target < r.Start
                || r.Target > 1_000_000 || r.Target - r.Start >= 500 || r.Members.Count < 1 || r.Members.Count > r.Target - r.Start + 1
                || r.X < 0 || r.Y < 0 || r.Width < 240 || r.Height < 160 || (long)r.X + r.Width > 1920 || (long)r.Y + r.Height > 1080
                || r.Columns < 1 || r.Columns > 25) throw new InvalidDataException("백두산 범위 또는 배치가 올바르지 않습니다.");
            long previous = 0;
            for (var i = 0; i < r.Members.Count; i++)
            {
                var tip = r.Members[i];
                if (!Guid.TryParse(tip.Id, out _) || !used.Add(tip.Id) || tip.SessionId != r.SessionId
                    || tip.Amount != r.Start + i || tip.SequenceNo <= previous || tip.ActorName.Length > 120)
                    throw new InvalidDataException("백두산 후원 순서가 올바르지 않습니다.");
                previous = tip.SequenceNo;
            }
        }
    }
    internal static Run Advance(Run run, IEnumerable<Tip> tips, bool closed, bool hasMore, long cursor)
    {
        var members = new List<Tip>(run.Members);
        foreach (var tip in tips.OrderBy(t => t.SequenceNo))
        {
            var last = members[^1];
            if (last.Amount >= run.Target) break;
            if (tip.SessionId == run.SessionId && tip.SequenceNo > last.SequenceNo && tip.Amount == last.Amount + 1
                && !members.Any(t => t.Id == tip.Id)) members.Add(tip);
        }
        return run with { Members = members, Closed = closed && !hasMore,
            ScanCursor = hasMore ? cursor : 0 };
    }
    internal async Task PollOnceAsync(CancellationToken token)
    {
        if (!_signedIn()) return;
        Run[] snapshot;
        await _gate.WaitAsync(token);
        try
        {
            if (_error.StartsWith("백두산 저장 파일")) return;
            snapshot = _runs.Where(r => !r.Closed && r.Members[^1].Amount < r.Target).ToArray();
        }
        finally { _gate.Release(); }
        var failed = false;
        foreach (var run in snapshot)
        {
            try
            {
                var response = await _send(JsonSerializer.SerializeToElement(new
                {
                    action = "baekdusan-log", sessionId = run.SessionId,
                    afterSequence = Math.Max(run.ScanCursor, run.Members[^1].SequenceNo)
                }), token);
                token.ThrowIfCancellationRequested();
                if (!_signedIn()) throw new OperationCanceledException();
                var updated = Advance(run, response.GetProperty("tiles").Deserialize<List<Tip>>(Json)!,
                    response.GetProperty("closed").GetBoolean(), response.GetProperty("hasMore").GetBoolean(),
                    response.GetProperty("nextSequence").GetInt64());
                await _gate.WaitAsync(token);
                try
                {
                    // A user can ungroup or move while the read is in flight.
                    // Never resurrect or overwrite that newer local transaction.
                    var index = _runs.FindIndex(r => ReferenceEquals(r, run));
                    if (index < 0 || (updated.Members.Count == run.Members.Count && updated.Closed == run.Closed && updated.ScanCursor == run.ScanCursor)) continue;
                    var next = new List<Run>(_runs); next[index] = updated;
                    Validate(next); await SaveAsync(next, _selected, token); _runs = next; Publish();
                }
                finally { _gate.Release(); }
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
            catch { failed = true; }
        }
        await _gate.WaitAsync(token);
        try
        {
            var error = failed ? "일부 백두산의 후원 갱신이 지연되고 있습니다. 원본 기록이 보관 중인지 확인해주세요." : "";
            if (_error != error) { _error = error; Publish(); }
        }
        finally { _gate.Release(); }
    }
    private async Task ObserveAsync()
    {
        while (!_stop.IsCancellationRequested)
        {
            try { await PollOnceAsync(_stop.Token); }
            catch (OperationCanceledException) when (_stop.IsCancellationRequested) { return; }
            catch
            {
                await _gate.WaitAsync(_stop.Token);
                try { if (_error.Length == 0) { _error = "백두산 후원 갱신 대기 중입니다. 연결되면 이어서 확인합니다."; Publish(); } }
                finally { _gate.Release(); }
            }
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(5), _stop.Token);
                if (!_runs.Any(r => r.ScanCursor > 0)) await _wake.WaitAsync(TimeSpan.FromSeconds(55), _stop.Token);
            }
            catch (OperationCanceledException) { return; }
        }
    }
    private async Task SaveAsync(List<Run> runs, string[] selected, CancellationToken token)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(new { runs, selected }, Json);
        var temporary = _path + ".tmp";
        try
        {
            await File.WriteAllBytesAsync(temporary, bytes, token);
            token.ThrowIfCancellationRequested();
            File.Move(temporary, _path, true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
    public void Dispose() => _stop.Cancel();
    internal async Task DrainAsync()
    {
        Dispose(); try { await _worker; } catch (OperationCanceledException) { }
        await _gate.WaitAsync(); _gate.Release();
    }
}
