using System.Net;
using System.Text.Json;

namespace HurogiCollector;

internal static partial class Program
{
    private static async Task WallpaperEmergencyRecoveryTestsAsync(string root)
    {
        var png = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlCIAAAAASUVORK5CYII=");
        JsonElement Snapshot(long revision, params string[] keys) => JsonSerializer.SerializeToElement(new {
            schemaVersion = 1, revision, canvasWidth = 1920, canvasHeight = 1080,
            tiles = keys.Select((key, i) => new { id = $"00000000-0000-4000-8000-{i+1:D12}",
                imageKey = key, imageUrl = $"https://stimg.sooplive.com/{key}.png", groupKey = "donation:33", amount = 33, actorName = "fixture" })
        });
        async Task WaitFor(Func<bool> condition)
        {
            for (var i = 0; i < 100 && !condition(); i++) await Task.Delay(10);
            True(condition(), "condition reached within bounded fixture wait");
        }

        using (var blocked = new AuditBlockedImageStream(png))
        {
            var handler = new ScriptedWallpaperHandler(uri => new HttpResponseMessage(HttpStatusCode.OK) {
                Content = uri.AbsolutePath.Contains("slow") ? new StreamContent(blocked) : new ByteArrayContent(png) });
            using var wallpaper = new WallpaperOverlayState(Path.Combine(root,"deadline"), _=>{}, handler, null,
                imageDownloadTimeout: TimeSpan.FromMilliseconds(350));
            var apply = wallpaper.ApplyAsync(new(true, 20, false, Snapshot(20,"slow","healthy")), CancellationToken.None);
            await blocked.Started.Task.WaitAsync(TimeSpan.FromSeconds(1));
            await WaitFor(() => { using var value = JsonDocument.Parse(wallpaper.SnapshotBytes()); return value.RootElement.GetProperty("tiles").GetArrayLength()==2 && value.RootElement.GetProperty("tiles")[1].GetProperty("imageUrl").ValueKind==JsonValueKind.String; });
            True(await apply.WaitAsync(TimeSpan.FromSeconds(2)), "body deadline completes partial apply without waiting for the server body");
            True(wallpaper.HasPendingAssets, "timed-out image remains repairable");
        }

        var clock = new EditorTestClock();var failing=true;var logs = new List<string>();
        var failureHandler = new ScriptedWallpaperHandler(uri => failing && uri.AbsolutePath.Contains("missing")
            ? new HttpResponseMessage(HttpStatusCode.NotFound)
            : new HttpResponseMessage(HttpStatusCode.OK){Content=new ByteArrayContent(png)});
        using (var wallpaper = new WallpaperOverlayState(Path.Combine(root,"backoff"),logs.Add,failureHandler,null,clock))
        {
            var sync = new VNextWallpaperSync(true,30,false,Snapshot(30,"missing","healthy"));
            await wallpaper.ApplyAsync(sync,CancellationToken.None);
            var before=wallpaper.SnapshotBytes();
            await wallpaper.ApplyAsync(sync,CancellationToken.None);await wallpaper.ApplyAsync(sync,CancellationToken.None);
            Equal(2,failureHandler.Requests.Count,"failed image is not redownloaded during cooldown; healthy image cached");
            True(before.SequenceEqual(wallpaper.SnapshotBytes()),"unchanged retries preserve bytes and display revision");
            Equal(1,logs.Count,"same failure is not repeatedly logged");
            Equal(TimeSpan.FromSeconds(60),wallpaper.PendingAssetRetryDelay,"permanent miss has a bounded cooldown");
            clock.Advance(61);await wallpaper.ApplyAsync(sync,CancellationToken.None);
            Equal(TimeSpan.FromSeconds(120),wallpaper.PendingAssetRetryDelay,"repeated permanent miss backs off");
            failing=false;clock.Advance(121);await wallpaper.ApplyAsync(sync,CancellationToken.None);
            False(wallpaper.HasPendingAssets,"same revision recovers after cooldown");
            Equal(30L,wallpaper.Revision,"recovered cursor advances only after all images ready");
        }

        using (var blocked = new AuditBlockedImageStream(png))
        {
            var handler = new ScriptedWallpaperHandler(uri=>new HttpResponseMessage(HttpStatusCode.OK){
                Content=uri.AbsolutePath.Contains("slow")?new StreamContent(blocked):new ByteArrayContent(png)});
            using var wallpaper = new WallpaperOverlayState(Path.Combine(root,"latest-donation"),_=>{},handler);
            var completed=new List<long>();int active=0,maximum=0;
            using var queue = new WallpaperApplicationQueue(async(sync,generation,stop)=>{
                active++;maximum=Math.Max(maximum,active);
                try{await wallpaper.ApplyAsync(sync,stop);completed.Add(sync.Revision);}finally{active--;}
            });
            queue.Enqueue(new(true,40,false,Snapshot(40,"slow")),1,CancellationToken.None);
            await blocked.Started.Task.WaitAsync(TimeSpan.FromSeconds(1));
            queue.Enqueue(new(true,41,false,Snapshot(41,"healthy")),2,CancellationToken.None);
            await queue.WhenIdle.WaitAsync(TimeSpan.FromSeconds(2));
            Equal(1,maximum,"latest-snapshot handoff never overlaps applies");
            Equal(41L,wallpaper.Revision,"new donation does not wait for old image timeout");
            True(completed.SequenceEqual(new[]{41L}),"superseded snapshot is not acknowledged as complete");
            queue.Enqueue(new(true,39,false,Snapshot(39,"healthy")),3,CancellationToken.None);
            await queue.WhenIdle.WaitAsync(TimeSpan.FromSeconds(2));
            Equal(41L,wallpaper.Revision,"older late arrival cannot replace newest state");
        }

        // A burst of selection/donation snapshots must finish at the LAST
        // (empty) selection, never replay a superseded non-empty snapshot.
        using (var blocked = new AuditBlockedImageStream(png))
        {
            var handler = new ScriptedWallpaperHandler(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(blocked) });
            using var wallpaper = new WallpaperOverlayState(Path.Combine(root,"burst-empty"), _=>{}, handler);
            using var queue = new WallpaperApplicationQueue(async (sync, _, stop) => { await wallpaper.ApplyAsync(sync, stop); });
            queue.Enqueue(new(true,100,false,Snapshot(100,"slow")),100,CancellationToken.None);
            await blocked.Started.Task.WaitAsync(TimeSpan.FromSeconds(1));
            for (var i=101;i<=150;i++)
                queue.Enqueue(new(true,i,false,i%2==0?Snapshot(i):Snapshot(i,"slow")),i,CancellationToken.None);
            await queue.WhenIdle.WaitAsync(TimeSpan.FromSeconds(3));
            using var final = JsonDocument.Parse(wallpaper.SnapshotBytes());
            Equal(150L, wallpaper.Revision, "50 rapid changes finish at latest revision without cooldown");
            Equal(0,final.RootElement.GetProperty("tiles").GetArrayLength(),"last uncheck clears real overlay tiles");
            False(wallpaper.HasPendingAssets,"empty selection has no lingering asset repair");
        }

        // Bound concurrent network bodies even on a cold 20-image snapshot.
        var streams = Enumerable.Range(0,20).Select(_=>new AuditBlockedImageStream(png)).ToArray();
        using (var stop = new CancellationTokenSource())
        {
            var requested=0;
            var handler=new ScriptedWallpaperHandler(_=>new HttpResponseMessage(HttpStatusCode.OK) {Content=new StreamContent(streams[Interlocked.Increment(ref requested)-1])});
            using var wallpaper=new WallpaperOverlayState(Path.Combine(root,"concurrency-cap"),_=>{},handler);
            var apply=wallpaper.ApplyAsync(new(true,200,false,Snapshot(200,Enumerable.Range(0,20).Select(i=>$"asset{i}").ToArray())),stop.Token);
            await WaitFor(()=>Volatile.Read(ref requested)==4);
            await Task.Delay(60);
            Equal(4,requested,"cold images use at most four concurrent requests");
            stop.Cancel();
            try { await apply.WaitAsync(TimeSpan.FromSeconds(2)); throw new Exception("canceled apply unexpectedly completed"); }
            catch(OperationCanceledException) { }
            True(wallpaper.HasPendingAssets,"shutdown preserves repairable partial state");
        }
        foreach(var stream in streams) stream.Dispose();

        var noticePath=Path.Combine(root,"update-notice.json");
        await File.WriteAllTextAsync(noticePath,"{\"lastStatus\":\"failed_kept_current\"}");
        True(AgentUpdateNotice.Read(noticePath,"1.0.0.26").Contains("적용하지 못해"),"failed update is visibly distinguished from current version");
        await File.WriteAllTextAsync(noticePath,"{\"lastStatus\":\"current\"}");
        Equal("",AgentUpdateNotice.Read(noticePath,"1.0.0.26"),"successful check has no warning");
        var readCount=0;var updateClock=new EditorTestClock();
        var noticeCache=new AgentUpdateNoticeCache(()=>{readCount++;return AgentUpdateNotice.Read(noticePath,"1.0.0.26");},updateClock);
        Equal("",noticeCache.Get(),"notice cache starts from current updater state");
        await File.WriteAllTextAsync(noticePath,"{\"lastStatus\":\"failed_kept_current\"}");
        for(var i=0;i<100;i++)noticeCache.Get();
        Equal(1,readCount,"UI status ticks do not repeatedly read update state file");
        updateClock.Advance(11);
        True(noticeCache.Get().Contains("적용하지 못해"),"background update failure becomes visible without restarting");
        await File.WriteAllTextAsync(noticePath,"{\"lastStatus\":\"installed_restart_required\",\"availableVersion\":\"1.0.0.27\"}");
        True(AgentUpdateNotice.Read(noticePath,"1.0.0.26").Contains("다시 실행"),"pending newer update requests restart");
        Equal("",AgentUpdateNotice.Read(noticePath,"1.0.0.27"),"current installed version does not request another restart");
        var logRoot=Path.Combine(root,"bounded-log");Directory.CreateDirectory(logRoot);
        var logPath=Path.Combine(logRoot,"collector.log");
        for(var i=0;i<4;i++){await File.WriteAllBytesAsync(logPath,new byte[10*1024*1024]);BoundedDiagnosticLog.Append(logPath,"fixture");}
        True(File.Exists(logPath+".3")&&!File.Exists(logPath+".4"),"diagnostic rotation retains only three archives");
        Console.WriteLine("PASS: body deadlines, progressive healthy cards, per-image backoff, unchanged state/log suppression, newest donation preemption, update notice, bounded logs");
    }
}
