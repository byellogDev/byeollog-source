using System.Text.Json;
using System.Text.Json.Nodes;

namespace HurogiCollector;

internal static partial class Program
{
    private sealed class DrawClock : TimeProvider
    {
        internal DateTimeOffset Now = DateTimeOffset.Parse("2026-10-04T00:00:00Z");
        public override DateTimeOffset GetUtcNow() => Now;
    }
    private static async Task DrawBoardTestsAsync(string root)
    {
        JsonElement Body(object o) => JsonSerializer.SerializeToElement(o, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
        var clock = new DrawClock(); var session = Guid.NewGuid().ToString(); bool signedIn = true, closed = false, badScope = false;
        var tips = new List<WallpaperBaekdusan.Tip>(); int reads = 0;
        TaskCompletionSource? pending = null, release = null;
        async Task<JsonElement> Feed(JsonElement? query, CancellationToken token)
        {
            reads++;
            var q = query!.Value;
            Equal("baekdusan-log", q.GetProperty("action").GetString(), "draw uses read-only donation log");
            Equal(session, q.GetProperty("sessionId").GetString(), "draw reads bound broadcast only");
            var page = tips.Where(t => t.SequenceNo > q.GetProperty("afterSequence").GetInt64()).OrderBy(t => t.SequenceNo).Take(200).ToArray();
            if (pending is not null) { pending.TrySetResult(); await release!.Task.WaitAsync(token); }
            return Body(new {sessionId = badScope ? Guid.NewGuid().ToString() : session, tiles = page, closed,
                nextSequence = page.LastOrDefault()?.SequenceNo ?? q.GetProperty("afterSequence").GetInt64(),
                hasMore = tips.Count(t => t.SequenceNo > q.GetProperty("afterSequence").GetInt64()) > 200});
        }
        string Add(int amount, long seq, string? id = null) { id ??= Guid.NewGuid().ToString(); tips.Add(new(id, session, seq, "시험 후원자", amount, clock.Now.ToString("O"))); return id; }
        JsonElement Create(string id, string mode = "manual", int size = 9, int draws = 1) => Body(new {action = "draw-board-create", id, mode, size, title = "시험 뽑기판", columns = 3, amount = 100, draws, sessionId = session, prizes = new[] {new {name = "상품", count = 3}}});
        async Task Reject(Func<Task> f, string label) { bool rejected = false; try { await f(); } catch (Exception e) when (e is InvalidDataException or OperationCanceledException or IOException or UnauthorizedAccessException) { rejected = true; } True(rejected, label); }
        int Count(DrawBoard b) => b.View.GetProperty("board").GetProperty("results").GetArrayLength();
        var path = Path.Combine(root, "draw-manual");
        using (var board = new DrawBoard(path, () => signedIn, Feed, () => {}, false, clock))
        {
            await board.PollOnceAsync(default); Equal(0, reads, "no active board makes no API calls");
            string id = Guid.NewGuid().ToString(); await board.ControlAsync(Create(id), default);
            True(!board.View.GetRawText().Contains("slots"), "editor never receives hidden placement");
            True(!board.PublicView().GetRawText().Contains("상품"), "public never receives unopened prize");
            await board.ControlAsync(Create(id), default); Equal(0, Count(board), "create retry doesn't reroll");
            await Reject(() => board.ControlAsync(Create(Guid.NewGuid().ToString()), default), "cannot replace running board");
            await Reject(() => board.ControlAsync(Body(new{action="draw-board-reveal",id,number=10}), default), "reject out of board number");
            var reveal = Body(new {action="draw-board-reveal",id,number=3});
            await Task.WhenAll(Enumerable.Range(0, 10).Select(_ => board.ControlAsync(reveal, default)));
            Equal(1, Count(board), "concurrent repeated reveal commits once");
            Equal(0, board.PublicView().GetProperty("board").GetProperty("results").GetArrayLength(), "saved result is hidden during reveal lead-in");
            clock.Now = clock.Now.AddMilliseconds(600);
            Equal(3, board.PublicView().GetProperty("highlighting").GetInt32(), "highlight precedes result without exposing prize");
            clock.Now = clock.Now.AddSeconds(2);
            Equal(1, board.PublicView().GetProperty("board").GetProperty("results").GetArrayLength(), "result opens after scheduled time");
            await board.PollOnceAsync(default); Equal(0, reads, "manual board has no donation polling");
            using var restart = new DrawBoard(path, () => signedIn, Feed, () => {}, false, clock);
            Equal(board.View.GetProperty("board").GetRawText(), restart.View.GetProperty("board").GetRawText(), "restart preserves exact result and map identity");
            signedIn = false; Equal(JsonValueKind.Null, board.PublicView().GetProperty("board").ValueKind, "signed out overlay clears");
            await Reject(() => board.ControlAsync(reveal, default), "signed out mutation blocked"); signedIn = true;
            await Reject(() => board.ControlAsync(Body(new{action="draw-board-reveal",id=Guid.NewGuid().ToString(),number=1}), default), "old document board ID cannot mutate current");
            var cts = new CancellationTokenSource(); cts.Cancel();
            await Reject(() => board.ControlAsync(Body(new{action="draw-board-reveal",id,number=1}), cts.Token), "cancelled operation preserves result");
            Equal(1, Count(board), "cancelled operation didn't publish");
            await board.ControlAsync(Body(new{action="draw-board-stop",id}), default);
            await board.ControlAsync(Create(Guid.NewGuid().ToString()), default);
            Equal(1, board.View.GetProperty("history").GetArrayLength(), "previous board history preserved");
            True(!board.View.GetProperty("history")[0].TryGetProperty("results", out _), "idle snapshot excludes archived result payload");
            var archived = await board.HistoryAsync(Body(new{id}),default);
            Equal(1,archived.GetProperty("results").GetArrayLength(),"archive loaded on explicit request");
            True(!archived.TryGetProperty("slots",out _),"archive never reveals unopened placement");
        }
        var randomPath = Path.Combine(root, "draw-random");
        for(int i=1;i<=205;i++) Add(100,i);
        using (var board = new DrawBoard(randomPath, () => signedIn, Feed, () => {}, false, clock))
        {
            string id = Guid.NewGuid().ToString(); await board.ControlAsync(Create(id,"random",9,2), default);
            Equal(0, Count(board), "historical donations across pages are not drawn"); Equal(2, reads, "initial log drained through pagination");
            await Reject(() => board.ControlAsync(Body(new{action="draw-board-reveal",id,number=1}), default), "random mode rejects manual reveal");
            Add(200,206); var duplicate = Add(100,207);
            await board.PollOnceAsync(default); Equal(2, Count(board), "exact 100 donation gives two, 200 gives none");
            await board.PollOnceAsync(default); Equal(2, Count(board), "cursor replay doesn't redraw");
            Add(100,208,duplicate); await board.PollOnceAsync(default); Equal(2, Count(board), "same donation new sequence doesn't duplicate");
            var results = board.View.GetProperty("board").GetProperty("results");
            True(results[1].GetProperty("revealAt").GetInt64() > results[0].GetProperty("revealAt").GetInt64(), "burst results serialized");
            badScope = true; Add(100,209);
            await Reject(async () => {await board.PollOnceAsync(default);}, "wrong response broadcast blocked"); Equal(2, Count(board), "wrong scope cannot publish"); badScope = false;
            await board.PollOnceAsync(default); Equal(4, Count(board), "retry still processes cursor not advanced on failure");
            using(var other = new DrawBoard(Path.Combine(root,"draw-other"),()=>true,Feed,()=>{},false,clock))
                Equal(JsonValueKind.Null,other.PublicView().GetProperty("board").ValueKind,"different account gets no board");
            pending = new(); release = new(); Add(100,210); var inFlight = board.PollOnceAsync(default); await pending.Task;
            await board.ControlAsync(Body(new{action="draw-board-stop",id}),default); release.SetResult(); await inFlight;
            Equal(4,Count(board),"late network response cannot resurrect stopped board"); pending=null; release=null;
            clock.Now=clock.Now.AddMinutes(1); await board.ControlAsync(Create(Guid.NewGuid().ToString(),"random",3,2),default);
            Add(100,211);Add(100,212);await board.PollOnceAsync(default);
            Equal(3,Count(board),"short remaining board capped without repeated numbers");
            var final=board.View.GetProperty("board");True(final.GetProperty("ended").GetBoolean(),"full board ends");
            Equal(3,final.GetProperty("results").EnumerateArray().Select(r=>r.GetProperty("number").GetInt32()).Distinct().Count(),"all selected numbers unique");
            await Reject(()=>board.ControlAsync(Create(Guid.NewGuid().ToString()),default),"new board waits for final queued reveal");
            clock.Now=clock.Now.AddMinutes(1);
            True(!board.PublicView().GetRawText().Contains("sourceId")&&!board.PublicView().GetRawText().Contains("sessionId"),"public excludes internal donation/session identifiers");
            await board.ControlAsync(Create(Guid.NewGuid().ToString(),"random"),default);
            closed=true;Add(100,213);await board.PollOnceAsync(default);Equal(1,Count(board),"last donation before broadcast close is included");
            True(board.View.GetProperty("board").GetProperty("ended").GetBoolean(),"broadcast closure ends random board");
        }
        var broken=Path.Combine(root,"draw-corrupt");Directory.CreateDirectory(broken);File.WriteAllText(Path.Combine(broken,"draw-board-v1.json"),"broken");
        using(var board=new DrawBoard(broken,()=>true,Feed,()=>{},false,clock))
        {
            await Reject(()=>board.ControlAsync(Create(Guid.NewGuid().ToString()),default),"corrupt persisted map blocks replacement");
            Equal("broken",File.ReadAllText(Path.Combine(broken,"draw-board-v1.json")),"corrupt evidence preserved");
        }
        var failing=Path.Combine(root,"draw-save-failure");Directory.CreateDirectory(failing);
        using(var board=new DrawBoard(failing,()=>true,Feed,()=>{},false,clock))
        {
            Directory.CreateDirectory(Path.Combine(failing,"draw-board-v1.json"));
            await Reject(()=>board.ControlAsync(Create(Guid.NewGuid().ToString()),default),"failed atomic commit rejected");
            Equal(JsonValueKind.Null,board.PublicView().GetProperty("board").ValueKind,"failed save never published");
        }
    }
}
