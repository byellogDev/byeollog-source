using System.Text.Json;
using System.Text.Json.Nodes;

namespace HurogiCollector;

internal static partial class Program
{
    private static async Task WallpaperAppearanceTestsAsync(string root)
    {
        var path = Path.Combine(root, "appearance-a");
        JsonElement Body(object value) => JsonSerializer.SerializeToElement(value);
        var style = new { enabled = true, fontUrl = "", nameColor = "#2367ab", textColor = "#ffffff", backgroundColor = "#102030", fontSize = 12 };
        var settings = new WallpaperAppearance(path);
        settings.Apply(Body(new { action = "appearance-save", appearance = style }), CancellationToken.None);
        var restored = new WallpaperAppearance(path);
        Equal("#2367ab", restored.View.GetProperty("nameColor").GetString(), "nickname color persists after restart");
        Equal(12, restored.View.GetProperty("fontSize").GetInt32(), "font size persists after restart");
        Equal(false, new WallpaperAppearance(Path.Combine(root,"appearance-b")).View.GetProperty("enabled").GetBoolean(), "other workspace keeps default appearance");
        var file = Path.Combine(path,"wallpaper-appearance-v1.json");
        var bytes = File.ReadAllText(file);
        foreach (var (key, value) in new (string, object)[] {
            ("fontUrl", "javascript:alert(1)"), ("fontUrl", "https://example.com/font.css"),
            ("fontUrl", "https://user:pass@example.com/a.woff2"), ("fontUrl", "https://127.0.0.1/a.woff2"),
            ("nameColor", "red;background:url(test)"), ("fontSize", 0), ("fontSize", 73)
        })
        {
            var modified = JsonSerializer.SerializeToNode(style)!.AsObject(); modified[key] = JsonSerializer.SerializeToNode(value);
            try { restored.Apply(Body(new { action="appearance-save", appearance=modified }), CancellationToken.None); throw new Exception("Invalid appearance accepted"); }
            catch (InvalidDataException) { _assertions++; }
            Equal(bytes,File.ReadAllText(file),"invalid appearance does not overwrite saved settings");
        }
        using var cancelled = new CancellationTokenSource(); cancelled.Cancel();
        try { restored.Apply(Body(new{action="appearance-reset"}),cancelled.Token); throw new Exception("Cancelled appearance accepted"); }
        catch(OperationCanceledException) { _assertions++; }
        Equal(bytes,File.ReadAllText(file),"cancellation preserves settings");
        using var overlay = new WallpaperOverlayState(path,_=>{});
        var sends=0;
        using var coordinator = new WallpaperEditorCoordinator(()=>false,(_,_)=>{sends++;throw new Exception("Unexpected remote request");},()=>0,overlay,path,_=>{},scheduleInitialBackup:false);
        var rawBefore=Convert.ToHexString(overlay.SnapshotBytes());
        using var before=JsonDocument.Parse(overlay.DisplaySnapshotBytes());
        var result=await coordinator.ApplyAsync(Body(new{action="appearance-save",appearance=style}),CancellationToken.None);
        Equal(12,result.GetProperty("appearance").GetProperty("fontSize").GetInt32(),"editor receives local appearance");
        using var display=JsonDocument.Parse(overlay.DisplaySnapshotBytes());
        Equal("#2367ab",display.RootElement.GetProperty("appearance").GetProperty("nameColor").GetString(),"OBS receives same appearance");
        Equal(false,before.RootElement.GetProperty("displayRevision").GetString()==display.RootElement.GetProperty("displayRevision").GetString(),"style-only save invalidates OBS revision");
        Equal(rawBefore,Convert.ToHexString(overlay.SnapshotBytes()),"appearance does not change original donation tiles or layout");
        Equal(0,sends,"offline appearance save needs no server write");
        await coordinator.ApplyAsync(Body(new{action="appearance-reset"}),CancellationToken.None);
        Equal(false,new WallpaperAppearance(path).View.GetProperty("enabled").GetBoolean(),"reset restores default after restart");
        var broken=Path.Combine(root,"appearance-broken"); Directory.CreateDirectory(broken);
        File.WriteAllText(Path.Combine(broken,"wallpaper-appearance-v1.json"),"broken");
        var damaged=new WallpaperAppearance(broken);
        try { damaged.Apply(Body(new{action="appearance-reset"}),CancellationToken.None); throw new Exception("Corrupt settings overwritten"); }
        catch(InvalidDataException) { _assertions++; }
        Equal("broken",File.ReadAllText(Path.Combine(broken,"wallpaper-appearance-v1.json")),"corrupt file preserved for recovery");
    }
}
