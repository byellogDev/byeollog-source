using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace HurogiCollector;

// One authority per signed-in workspace. OBS is a read-only projection, never a drawing client.
internal sealed class DrawBoard : IDisposable
{
    internal sealed record Prize(string Name, int Count);
    internal sealed record Result(int Number, string Prize, string Actor, string SourceId, long RevealAt);
    internal sealed record Board(string Id, string Title, string Mode, string SessionId, int Columns,
        int Amount, int Draws, string[] Slots, List<Result> Results, long Cursor, bool Ended = false);
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private readonly string _path;
    private readonly Func<bool> _signedIn;
    private readonly Func<JsonElement?, CancellationToken, Task<JsonElement>> _send;
    private readonly Action _changed;
    private readonly TimeProvider _clock;
    private readonly SemaphoreSlim _gate = new(1, 1), _wake = new(0, 1);
    private readonly CancellationTokenSource _stop = new();
    private readonly object _viewLock = new();
    private List<Board> _boards = [];
    private Board? _published;
    private JsonElement _view;
    private string _error = "";
    private bool _corrupt;
    private long _version;
    private int _started;
    private Task _worker = Task.CompletedTask;
    internal DrawBoard(string root, Func<bool> signedIn,
        Func<JsonElement?, CancellationToken, Task<JsonElement>> send, Action changed,
        bool startWorker = true, TimeProvider? clock = null)
    {
        _path = Path.Combine(root, "draw-board-v1.json");
        _signedIn = signedIn; _send = send; _changed = changed; _clock = clock ?? TimeProvider.System;
        if (File.Exists(_path))
        {
            try
            {
                if (new FileInfo(_path).Length > 16 * 1024 * 1024) throw new InvalidDataException();
                _boards = JsonSerializer.Deserialize<List<Board>>(File.ReadAllBytes(_path), Json) ?? throw new InvalidDataException();
                Validate(_boards);
            }
            catch { _boards = []; _corrupt = true; _error = "뽑기판 저장 파일을 읽지 못했습니다. 원본을 보존하고 추첨을 중단했습니다."; }
        }
        Publish();
        if (startWorker) Start();
    }
    internal void Start()
    {
        if (!_stop.IsCancellationRequested && Interlocked.CompareExchange(ref _started, 1, 0) == 0)
            _worker = Task.Run(ObserveAsync);
    }
    internal void Notify() { try { _wake.Release(); } catch (SemaphoreFullException) { } }
    internal JsonElement View { get { lock (_viewLock) return _view.Clone(); } }
    private static object Project(Board b, IEnumerable<Result> results) => new
    {
        b.Id, b.Title, b.Mode, b.SessionId, b.Columns, b.Amount, b.Draws, size = b.Slots.Length,
        b.Ended, results = results.ToArray()
    };
    private void Publish()
    {
        lock (_viewLock)
        {
            _published = _boards.LastOrDefault();
            _view = JsonSerializer.SerializeToElement(new
            {
                version = ++_version, error = _error,
                board = _published is null ? null : Project(_published, _published.Results),
                history = _boards.Take(Math.Max(0, _boards.Count - 1)).Reverse()
                    .Select(b => new { b.Id, b.Title, size = b.Slots.Length, count = b.Results.Count }).ToArray()
            }, Json);
        }
        _changed();
    }
    internal JsonElement PublicView()
    {
        lock (_viewLock)
        {
            var b = _signedIn() && !_stop.IsCancellationRequested ? _published : null;
            long now = _clock.GetUtcNow().ToUnixTimeMilliseconds();
            return JsonSerializer.SerializeToElement(new
            {
                board = b is null ? null : new
                {
                    b.Id, b.Title, b.Columns, size = b.Slots.Length,
                    results = b.Results.Where(r => r.RevealAt <= now).Select(r => new { r.Number, r.Prize, r.Actor }).ToArray()
                },
                highlighting = b?.Results.FirstOrDefault(r => r.RevealAt > now && r.RevealAt <= now + 1000)?.Number,
                error = b is null ? "" : _error
            }, Json);
        }
    }
    internal JsonElement Decorate(JsonElement source)
    {
        var root = JsonNode.Parse(source.GetRawText())!.AsObject();
        var view = View;
        root["drawBoard"] = JsonNode.Parse(view.GetRawText());
        root["displayKey"] = (root["displayKey"]?.GetValue<string>() ?? "") + ":draw:" + view.GetProperty("version").GetInt64();
        return JsonSerializer.SerializeToElement(root);
    }
    private void Check(CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        _stop.Token.ThrowIfCancellationRequested();
        if (!_signedIn()) throw new InvalidDataException("로그인한 계정에서 뽑기판을 사용해주세요.");
        if (_corrupt) throw new InvalidDataException(_error);
    }
    internal async Task<JsonElement> HistoryAsync(JsonElement body, CancellationToken token)
    {
        await _gate.WaitAsync(token);
        try
        {
            Check(token);
            var id = body.GetProperty("id").GetString();
            var board = _boards.SingleOrDefault(b => b.Id == id) ?? throw new InvalidDataException("기록을 찾을 수 없습니다.");
            return JsonSerializer.SerializeToElement(Project(board, board.Results), Json);
        }
        finally { _gate.Release(); }
    }
    internal async Task ControlAsync(JsonElement body, CancellationToken token)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(token, _stop.Token);
        token = linked.Token;
        await _gate.WaitAsync(token);
        try
        {
            Check(token);
            var action = body.GetProperty("action").GetString();
            var id = body.GetProperty("id").GetString() ?? "";
            if (!Guid.TryParse(id, out _)) throw new InvalidDataException("뽑기판 식별자가 올바르지 않습니다.");
            var current = _boards.LastOrDefault();
            var next = new List<Board>(_boards);
            if (action == "draw-board-create")
            {
                // Retrying an uncertain response must not replace an already created board.
                if (_boards.Any(b => b.Id == id)) return;
                if (current is { Ended: false }) throw new InvalidDataException("진행 중인 뽑기판을 종료한 뒤 새로 만들어주세요.");
                if (current?.Results.LastOrDefault() is { } last && last.RevealAt + 700 > _clock.GetUtcNow().ToUnixTimeMilliseconds())
                    throw new InvalidDataException("이전 뽑기판의 결과 공개가 끝난 뒤 새로 시작해주세요.");
                var size = body.GetProperty("size").GetInt32();
                var columns = body.GetProperty("columns").GetInt32();
                var mode = body.GetProperty("mode").GetString() ?? "";
                var title = body.GetProperty("title").GetString()?.Trim() ?? "";
                var amount = body.GetProperty("amount").GetInt32();
                var draws = body.GetProperty("draws").GetInt32();
                var session = body.GetProperty("sessionId").GetString() ?? "";
                var prizes = body.GetProperty("prizes").Deserialize<Prize[]>(Json) ?? [];
                if (_boards.Count >= 100 || size is < 1 or > 500 || columns < 1 || columns > Math.Min(20, size)
                    || title.Length is < 1 or > 60 || mode is not ("random" or "manual")
                    || amount is < 1 or > 1_000_000 || draws is < 1 or > 20 || draws > size
                    || prizes.Length > 100 || prizes.Any(p => p is null || string.IsNullOrWhiteSpace(p.Name) || p.Name.Length > 60 || p.Count is < 1 or > 500)
                    || prizes.Sum(p => (long)p.Count) > size)
                    throw new InvalidDataException("이름 60자·1~500칸·최대 20열, 상품 수량과 후원당 1~20회 설정을 확인해주세요. 보관은 100판까지 가능합니다.");
                long cursor = 0;
                if (mode == "random")
                {
                    if (!Guid.TryParse(session, out _)) throw new InvalidDataException("자동 추첨할 방송을 선택해주세요.");
                    // Drain the existing log once. Only subsequent receipt sequences qualify.
                    for (int page = 0; ; page++)
                    {
                        if (page >= 1000) throw new InvalidDataException("후원 기록이 너무 많습니다. 새 방송에서 시작해주세요.");
                        var response = await ReadAsync(session, cursor, token);
                        Check(token);
                        if (response.GetProperty("sessionId").GetString() != session) throw new InvalidDataException("방송 범위가 일치하지 않습니다.");
                        if (response.GetProperty("closed").GetBoolean()) throw new InvalidDataException("진행 중인 방송에서 자동 뽑기판을 시작해주세요.");
                        var nextCursor = response.GetProperty("nextSequence").GetInt64();
                        if (nextCursor < cursor) throw new InvalidDataException("후원 순서를 확인하지 못했습니다.");
                        if (!response.GetProperty("hasMore").GetBoolean()) { cursor = nextCursor; break; }
                        if (nextCursor == cursor) throw new InvalidDataException("후원 기록 조회가 진행되지 않았습니다.");
                        cursor = nextCursor;
                    }
                }
                else session = "";
                var slots = prizes.SelectMany(p => Enumerable.Repeat(p.Name.Trim(), p.Count)).ToList();
                while (slots.Count < size) slots.Add("");
                for (int i = slots.Count - 1; i > 0; i--) { int j = RandomNumberGenerator.GetInt32(i + 1); (slots[i], slots[j]) = (slots[j], slots[i]); }
                next.Add(new Board(id, title, mode, session, columns, amount, draws, slots.ToArray(), [], cursor));
            }
            else
            {
                if (current is null || current.Id != id) throw new InvalidDataException("현재 뽑기판을 다시 확인해주세요.");
                if (action == "draw-board-stop") next[^1] = current with { Ended = true };
                else if (action == "draw-board-reveal")
                {
                    if (current.Mode != "manual" || current.Ended) throw new InvalidDataException("수동 모드로 진행 중일 때만 번호를 열 수 있습니다.");
                    int number = body.GetProperty("number").GetInt32();
                    if (number < 1 || number > current.Slots.Length) throw new InvalidDataException("판 안의 번호를 입력해주세요.");
                    if (current.Results.Any(r => r.Number == number)) return;
                    next[^1] = AddResult(current, number, "", "manual:" + number);
                }
                else throw new InvalidDataException("뽑기판 요청이 올바르지 않습니다.");
            }
            await CommitAsync(next, token);
            Notify();
        }
        finally { _gate.Release(); }
    }
    private Board AddResult(Board b, int number, string actor, string source)
    {
        long at = Math.Max(_clock.GetUtcNow().ToUnixTimeMilliseconds() + 1500, (b.Results.LastOrDefault()?.RevealAt ?? 0) + 2500);
        var results = new List<Result>(b.Results) { new(number, b.Slots[number - 1], actor, source, at) };
        return b with { Results = results, Ended = results.Count == b.Slots.Length };
    }
    private Task<JsonElement> ReadAsync(string session, long cursor, CancellationToken token) =>
        _send(JsonSerializer.SerializeToElement(new { action = "baekdusan-log", sessionId = session, afterSequence = cursor }), token);
    internal async Task<bool> PollOnceAsync(CancellationToken token)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(token, _stop.Token);
        token = linked.Token;
        Board? original;
        await _gate.WaitAsync(token);
        try
        {
            if (!_signedIn() || _corrupt) return false;
            original = _boards.LastOrDefault();
            if (original is not { Ended: false, Mode: "random" }) return false;
        }
        finally { _gate.Release(); }
        var response = await ReadAsync(original.SessionId, original.Cursor, token);
        await _gate.WaitAsync(token);
        try
        {
            Check(token);
            if (!ReferenceEquals(original, _boards.LastOrDefault())) return false;
            var tips = response.GetProperty("tiles").Deserialize<WallpaperBaekdusan.Tip[]>(Json) ?? throw new InvalidDataException();
            long cursor = response.GetProperty("nextSequence").GetInt64();
            bool more = response.GetProperty("hasMore").GetBoolean();
            if (response.GetProperty("sessionId").GetString() != original.SessionId
                || tips.Length > 200 || cursor != (tips.Length == 0 ? original.Cursor : tips.Max(t => t.SequenceNo)) || (more && cursor == original.Cursor)
                || tips.Any(t => t.SessionId != original.SessionId || !Guid.TryParse(t.Id, out _) || t.SequenceNo <= original.Cursor || t.SequenceNo > cursor
                    || t.Amount < 1 || t.ActorName.Length > 120)
                || tips.Select(t => t.SequenceNo).Distinct().Count() != tips.Length
                || tips.Select(t => t.Id).Distinct().Count() != tips.Length)
                throw new InvalidDataException("후원 순서 또는 방송 범위 검증에 실패했습니다.");
            var updated = original;
            foreach (var tip in tips.OrderBy(t => t.SequenceNo))
            {
                if (updated.Ended) break;
                if (tip.Amount != updated.Amount || updated.Results.Any(r => r.SourceId == tip.Id)) continue;
                for (int i = 0; i < updated.Draws && !updated.Ended; i++)
                {
                    var unopened = Enumerable.Range(1, updated.Slots.Length).Where(n => updated.Results.All(r => r.Number != n)).ToArray();
                    updated = AddResult(updated, unopened[RandomNumberGenerator.GetInt32(unopened.Length)], tip.ActorName, tip.Id);
                }
            }
            updated = updated with { Cursor = cursor, Ended = updated.Ended || (response.GetProperty("closed").GetBoolean() && !more) };
            if (updated.Cursor != original.Cursor || updated.Ended != original.Ended || updated.Results.Count != original.Results.Count)
            {
                var next = new List<Board>(_boards); next[^1] = updated;
                await CommitAsync(next, token);
            }
            else if (_error.Length > 0) { _error = ""; Publish(); }
            return more && !updated.Ended;
        }
        finally { _gate.Release(); }
    }
    private async Task CommitAsync(List<Board> next, CancellationToken token)
    {
        Validate(next);
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        string temp = _path + ".tmp";
        try
        {
            using (var file = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                await JsonSerializer.SerializeAsync(file, next, Json, token);
                if (file.Length > 16 * 1024 * 1024) throw new InvalidDataException("뽑기판 보관 용량을 초과했습니다. 기존 기록은 유지됩니다.");
                file.Flush(true);
            }
            Check(token);
            File.Move(temp, _path, true);
            _boards = next; _error = ""; Publish();
        }
        finally { if (File.Exists(temp)) File.Delete(temp); }
    }
    private static void Validate(List<Board> boards)
    {
        if (boards.Count > 100 || boards.Select(b => b.Id).Distinct().Count() != boards.Count) throw new InvalidDataException();
        foreach (var b in boards)
        {
            if (!Guid.TryParse(b.Id, out _) || b.Title.Length is < 1 or > 60 || b.Mode is not ("manual" or "random")
                || (b.Mode == "random" && !Guid.TryParse(b.SessionId, out _)) || b.Slots.Length is < 1 or > 500
                || b.Slots.Any(s => s is null || s.Length > 60) || b.Columns < 1 || b.Columns > Math.Min(20, b.Slots.Length)
                || b.Amount is < 1 or > 1_000_000 || b.Draws is < 1 or > 20 || b.Draws > b.Slots.Length || b.Cursor < 0
                || b.Results.Count > b.Slots.Length || b.Results.Select(r => r.Number).Distinct().Count() != b.Results.Count
                || b.Results.Any(r => r.Number < 1 || r.Number > b.Slots.Length || r.Prize != b.Slots[r.Number - 1]
                    || r.Actor.Length > 120 || r.SourceId.Length > 80 || r.RevealAt < 0)
                || b.Results.Zip(b.Results.Skip(1)).Any(p => p.First.RevealAt >= p.Second.RevealAt)) throw new InvalidDataException();
        }
        if (boards.Take(Math.Max(0, boards.Count - 1)).Any(b => !b.Ended)) throw new InvalidDataException();
    }
    private async Task ObserveAsync()
    {
        while (!_stop.IsCancellationRequested)
        {
            bool more = false;
            try { more = await PollOnceAsync(_stop.Token); }
            catch (OperationCanceledException) when (_stop.IsCancellationRequested) { return; }
            catch
            {
                await _gate.WaitAsync();
                try { _error = "후원 갱신이 지연되고 있습니다. 연결 복구 후 저장된 순서부터 이어갑니다."; Publish(); }
                finally { _gate.Release(); }
            }
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(5), _stop.Token);
                if (!more) await _wake.WaitAsync(TimeSpan.FromSeconds(10), _stop.Token);
            }
            catch (OperationCanceledException) { return; }
        }
    }
    public void Dispose() => _stop.Cancel();
    internal async Task DrainAsync()
    {
        Dispose(); try { await _worker; } catch (OperationCanceledException) { }
        await _gate.WaitAsync(); _gate.Release();
    }
}
