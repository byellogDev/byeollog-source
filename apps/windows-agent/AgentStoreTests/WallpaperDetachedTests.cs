using System.Text.Json;

namespace HurogiCollector;

internal static partial class Program
{
    private static async Task WallpaperDetachedTestsAsync(string root)
    {
        var path = Path.Combine(root, "detached-a"); Directory.CreateDirectory(path);
        const string id = "11111111-1111-4111-8111-111111111111";
        const string other = "22222222-2222-4222-8222-222222222222";
        JsonElement Body(object value) => JsonSerializer.SerializeToElement(value);
        var settings = new WallpaperDetachedCards(path);
        var initial = new { x = 500, y = 100, width = 240, height = 226 };
        settings.Apply(Body(new { action = "detached-ranges", ranges = new[] { new { min = 1000, max = 1000 } }, positions = new Dictionary<string, object> { [id] = initial } }), CancellationToken.None);
        Equal(1000, settings.View.GetProperty("ranges")[0].GetProperty("min").GetInt32(), "single amount range saved");
        Equal(500, settings.View.GetProperty("positions").GetProperty(id).GetProperty("x").GetInt32(), "existing card keeps visual position");
        settings.Apply(Body(new { action = "detached-layout", id, position = new { x = 1680, y = 854, width = 240, height = 226 } }), CancellationToken.None);
        var restored = new WallpaperDetachedCards(path);
        Equal(1680, restored.View.GetProperty("positions").GetProperty(id).GetProperty("x").GetInt32(), "restart restores independent right edge position");
        Equal(false, restored.View.GetProperty("positions").TryGetProperty(other, out _), "new donation never inherits another card position");
        Equal(0, new WallpaperDetachedCards(Path.Combine(root,"detached-b")).View.GetProperty("ranges").GetArrayLength(), "different workspace has no ranges");
        var bytes = File.ReadAllText(Path.Combine(path,"wallpaper-detached-v1.json"));
        foreach (var invalid in new object[] {
            new { action="detached-ranges",ranges=new[]{new{min=1000,max=999}} },
            new { action="detached-ranges",ranges=new[]{new{min=1,max=1000},new{min=1000,max=2000}} },
            new { action="detached-layout",id,position=new{x=1681,y=0,width=240,height=226} }
        })
        {
            try {restored.Apply(Body(invalid),CancellationToken.None);throw new Exception("Invalid settings accepted");}
            catch(InvalidDataException){_assertions++;}
            Equal(bytes,File.ReadAllText(Path.Combine(path,"wallpaper-detached-v1.json")),"invalid input does not overwrite saved settings");
        }
        using var cancelled = new CancellationTokenSource();cancelled.Cancel();
        try {restored.Apply(Body(new{action="detached-ranges",ranges=Array.Empty<object>()}),cancelled.Token);throw new Exception("Cancelled save accepted");}
        catch(OperationCanceledException){_assertions++;}
        using var overlay = new WallpaperOverlayState(path,_=>{});
        var sends = 0;
        using var coordinator = new WallpaperEditorCoordinator(()=>false,(_,_)=>{sends++;throw new Exception("No remote calls expected");},()=>0,overlay,path,_=>{},scheduleInitialBackup:false);
        var rawBefore = Convert.ToHexString(overlay.SnapshotBytes());
        using var before = JsonDocument.Parse(overlay.DisplaySnapshotBytes());
        var beforeRevision = before.RootElement.GetProperty("displayRevision").GetString();
        var result = await coordinator.ApplyAsync(Body(new{action="detached-layout",id,position=new{x=150,y=50,width=240,height=226}}),CancellationToken.None);
        Equal(150,result.GetProperty("detached").GetProperty("positions").GetProperty(id).GetProperty("x").GetInt32(),"editor response includes local position");
        using var display = JsonDocument.Parse(overlay.DisplaySnapshotBytes());
        Equal(150,display.RootElement.GetProperty("detached").GetProperty("positions").GetProperty(id).GetProperty("x").GetInt32(),"OBS uses same saved position");
        Equal(false,beforeRevision==display.RootElement.GetProperty("displayRevision").GetString(),"local move invalidates OBS display revision");
        Equal(rawBefore,Convert.ToHexString(overlay.SnapshotBytes()),"source tiles and grouped layouts untouched");
        Equal(0,sends,"detaching does not call server");
        await coordinator.ApplyAsync(Body(new{action="detached-ranges",ranges=Array.Empty<object>()}),CancellationToken.None);
        Equal(0,new WallpaperDetachedCards(path).View.GetProperty("ranges").GetArrayLength(),"cleared ranges remain cleared after restart");
        var broken = Path.Combine(root,"detached-broken");Directory.CreateDirectory(broken);
        File.WriteAllText(Path.Combine(broken,"wallpaper-detached-v1.json"),"broken");
        var damaged = new WallpaperDetachedCards(broken);
        try{damaged.Apply(Body(new{action="detached-ranges",ranges=Array.Empty<object>()}),CancellationToken.None);throw new Exception("Corrupt file overwritten");}
        catch(InvalidDataException){_assertions++;}
        Equal("broken",File.ReadAllText(Path.Combine(broken,"wallpaper-detached-v1.json")),"damaged settings preserved for recovery");
    }
}
