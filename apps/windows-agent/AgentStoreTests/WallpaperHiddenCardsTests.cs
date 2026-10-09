using System.Text.Json;

namespace HurogiCollector;

internal static partial class Program
{
    private static async Task WallpaperHiddenCardsTestsAsync(string root)
    {
        const string id = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
        JsonElement Body(object x) => JsonSerializer.SerializeToElement(x);
        var path = Path.Combine(root, "hidden-a"); Directory.CreateDirectory(path);
        var source = Body(new {revision=1, groups=new[]{new{id="g",cards=new[]{new{id,actorName="시험 후원자",amount=1000,receivedAt="2026-10-09T01:00:00Z"},new{id=other,actorName="시험 후원자",amount=1000,receivedAt="2026-10-09T01:00:01Z"}}}}});
        var settings = new WallpaperHiddenCards(path);
        var hide = Body(new {action="card-hide",id,actorName="untrusted override"});
        settings.Apply(hide,source,CancellationToken.None);
        Equal(1,settings.View.GetProperty("cards").EnumerateObject().Count(),"one card hidden, same amount sibling unaffected");
        Equal("시험 후원자",settings.View.GetProperty("cards").GetProperty(id).GetProperty("actorName").GetString(),"metadata comes from source only");
        var version=settings.View.GetProperty("version").GetInt64();
        settings.Apply(hide,source,CancellationToken.None);
        Equal(version,settings.View.GetProperty("version").GetInt64(),"hide retries are idempotent");
        settings = new WallpaperHiddenCards(path);
        True(settings.View.GetProperty("cards").TryGetProperty(id,out _),"hidden choice survives restart");
        Equal(0,new WallpaperHiddenCards(Path.Combine(root,"hidden-b")).View.GetProperty("cards").EnumerateObject().Count(),"workspace isolation");
        var sourceBefore=source.GetRawText();settings.Decorate(source);
        Equal(sourceBefore,source.GetRawText(),"source layout/donations are immutable");
        var file=Path.Combine(path,"wallpaper-hidden-cards-v1.json");var bytes=File.ReadAllText(file);
        foreach(var bad in new[]{"not-a-card","33333333-3333-4333-8333-333333333333"})
        {
            try{settings.Apply(Body(new{action="card-hide",id=bad}),source,CancellationToken.None);throw new Exception("Unknown card accepted");}
            catch(InvalidDataException){_assertions++;}
            Equal(bytes,File.ReadAllText(file),"invalid hide preserves disk state");
        }
        using(var cancelled=new CancellationTokenSource()){
            cancelled.Cancel();try{settings.Apply(Body(new{action="card-restore",id}),source,cancelled.Token);throw new Exception("Cancelled restore accepted");}
            catch(OperationCanceledException){_assertions++;}
            Equal(bytes,File.ReadAllText(file),"cancelled restore preserves state");
        }
        using var overlay=new WallpaperOverlayState(path,_=>{});
        var sends=0;
        using var coordinator=new WallpaperEditorCoordinator(()=>false,(_,_)=>{sends++;throw new Exception("No network expected");},()=>0,overlay,path,_=>{},scheduleInitialBackup:false);
        using var before=JsonDocument.Parse(overlay.DisplaySnapshotBytes());
        True(before.RootElement.GetProperty("hiddenCards").GetProperty("cards").TryGetProperty(id,out _),"overlay receives saved hide state");
        var rawBefore=Convert.ToHexString(overlay.SnapshotBytes());
        var result=await coordinator.ApplyAsync(Body(new{action="card-restore",id}),CancellationToken.None);
        Equal(0,result.GetProperty("hiddenCards").GetProperty("cards").EnumerateObject().Count(),"restore works even after original broadcast leaves current snapshot");
        using var display=JsonDocument.Parse(overlay.DisplaySnapshotBytes());
        Equal(false,before.RootElement.GetProperty("displayRevision").GetString()==display.RootElement.GetProperty("displayRevision").GetString(),"hide revision invalidates overlay cache");
        Equal(rawBefore,Convert.ToHexString(overlay.SnapshotBytes()),"restoring never mutates raw donations/layout");
        Equal(0,sends,"offline restore does not call server");
        Equal(0,new WallpaperHiddenCards(path).View.GetProperty("cards").EnumerateObject().Count(),"restore survives restart");
        var baek=Body(new{baekdusan=new{selectedSessionIds=new[]{"s"},runs=new[]{new{sessionId="s",members=new[]{new{id,amount=1,actorName="백두산 시험"}}}}}});
        settings=new WallpaperHiddenCards(path);settings.Apply(hide,baek,CancellationToken.None);
        Equal(1,baek.GetProperty("baekdusan").GetProperty("runs")[0].GetProperty("members").GetArrayLength(),"baekdusan member/progress retained");
        File.WriteAllText(file,"broken");settings=new WallpaperHiddenCards(path);
        True(settings.View.GetProperty("error").GetString()!.Length>0,"corrupt settings reported");
        try{settings.Apply(Body(new{action="card-restore",id}),source,CancellationToken.None);throw new Exception("Corrupt file overwritten");}
        catch(InvalidDataException){_assertions++;}
        Equal("broken",File.ReadAllText(file),"corrupt settings preserved");
    }
}
