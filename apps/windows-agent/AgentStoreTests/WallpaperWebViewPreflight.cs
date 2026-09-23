using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace HurogiCollector;

// Test double for the remote transport and agent facade only. The linked Form,
// JS, coordinator, workspace storage and localhost renderer are production code.
// This does NOT claim to run the installed EXE, SOOP transport, or OBS CEF.
internal sealed class VNextLocalAgent : IDisposable
{
    internal event Action? WallpaperEditorStateChanged;
    internal event Action? WallpaperWorkspaceChanged;
    internal string WallpaperWorkspaceId { get; private set; } = Guid.NewGuid().ToString("D");
    internal bool Online = true;
    internal int DelayMs = 60;
    internal int RemoteWrites;
    internal WallpaperWorkspaceContext Context { get; private set; }
    private readonly string _root;
    private string[] _selected = [];
    private long _revision = 1;
    internal VNextLocalAgent(string root) { _root=root; Context=Make(); }
    private WallpaperWorkspaceContext Make() => new(_root, WallpaperWorkspaceId, () => Online,
        RemoteAsync, () => 1, _ => { }, () => { });
    private string Id(int index) => index==0 ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222";
    private JsonElement EditorState() => JsonSerializer.SerializeToElement(new {
        revision=_revision, selectedSessionIds=_selected, live=new {isLive=false}, total=_selected.Length, count=_selected.Length,
        session=_selected.Length==0 ? null : new {id="fixture",state="offline",canvasWidth=1920,canvasHeight=1080},
        sessions=new[] {new {id="session-a",label="격리 시험 A",tileCount=1,startedAt="2026-09-06T01:00:00Z"},new {id="session-b",label="격리 시험 B",tileCount=1,startedAt="2026-09-06T02:00:00Z"}},
        groups=_selected.Select((s,i)=>new {id="group-"+i,amount=2,displayKind="subscription",imageUrl=(string?)null,
            tileIds=new[]{Id(i)},x=i*300,y=100,width=240,height=226,cardWidth=240,cardHeight=226,rowsPerColumn=1,slotColumns=2,scale=1,
            cards=new[]{new {id=Id(i),actorName="격리 시험",displayKind="subscription",amount=2,imageUrl=(string?)null,x=0,y=0,width=240,height=226}}})
    });
    private async Task<JsonElement> RemoteAsync(JsonElement? control,CancellationToken token)
    {
        if(!Online) throw new IOException("isolated network outage");
        await Task.Delay(DelayMs,token);
        if(control is not null) {
            var action=control.Value.GetProperty("action").GetString();
            if(action=="verify-cache-ownership")return JsonSerializer.SerializeToElement(new {owned=false,workspaceId=WallpaperWorkspaceId});
            RemoteWrites++;
            if(action=="select-sessions")_selected=control.Value.GetProperty("sessionIds").EnumerateArray().Select(x=>x.GetString()!).ToArray();
            _revision++;
        }
        return EditorState();
    }
    internal async Task<JsonElement> GetWallpaperEditorStateAsync(CancellationToken token){await Context.PrepareAsync(token);return await Context.Editor.GetStateAsync(token);}
    internal async Task<JsonElement> RefreshWallpaperEditorStateAsync(CancellationToken token){await Context.PrepareAsync(token);return await Context.Editor.RefreshAsync(token);}
    internal async Task<JsonElement> ApplyWallpaperEditorControlAsync(JsonElement control,CancellationToken token){
        var context=Context;
        var result=await context.Editor.ApplyAsync(control,token);
        if(control.GetProperty("action").GetString()=="select-sessions") {
            // Isolated replacement for the independent direct snapshot delivery.
            var snapshot=JsonSerializer.SerializeToElement(new {schemaVersion=1,revision=_revision,canvasWidth=1920,canvasHeight=1080,
                tiles=_selected.Select((s,i)=>new {id=Id(i),actorName="격리 시험",amount=2,displayKind="subscription",imageUrl=(string?)null,imageKey=(string?)null,groupKey="group-"+i})});
            await context.State.ApplyAsync(new(true,_revision,false,snapshot),token);
        }
        WallpaperEditorStateChanged?.Invoke();return result;
    }
    internal LocalWallpaperImageMask CreateWallpaperImageMask(string url)=>Context.State.CreateImageMask(url);
    internal async Task SwitchAsync(){var old=Context;old.Dispose();await old.Retired;WallpaperWorkspaceId=Guid.NewGuid().ToString("D");_selected=[];_revision=1;Context=Make();WallpaperWorkspaceChanged?.Invoke();}
    public void Dispose()=>Context.Dispose();
}
internal sealed class VNextDevelopmentException : Exception
{
    internal int? StatusCode {get;init;}
    internal string? Code {get;init;}
}
internal static class WallpaperWebViewPreflight
{
    internal static Task RunAsync(string uiRoot)
    {
        var done=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var thread=new Thread(()=>{
            using var host=new Form {ShowInTaskbar=false,StartPosition=FormStartPosition.Manual,Location=new(-32000,-32000),Size=new(1200,800)};
            host.Shown+=async (_,_)=>{
                try{await ExerciseAsync(uiRoot,host);done.TrySetResult();}
                catch(Exception ex){done.TrySetException(ex);}
                finally{host.Close();}
            };
            Application.Run(host);
        });
        thread.SetApartmentState(ApartmentState.STA);thread.Start();return done.Task;
    }
    private static async Task WaitAsync(WebView2 web,string predicate,string label)
    {
        var deadline=Stopwatch.StartNew();
        while(deadline.Elapsed<TimeSpan.FromSeconds(12)){
            if(web.CoreWebView2 is not null && await web.ExecuteScriptAsync("Boolean("+predicate+")")=="true")return;
            await Task.Delay(50);
        }
        throw new Exception("WebView check timed out: "+label+" state="+await web.ExecuteScriptAsync("document.body.innerText.slice(-1800)"));
    }
    private static async Task ExerciseAsync(string uiRoot,Form host)
    {
        var root=Path.Combine(Path.GetTempPath(),"byeollog-webview-preflight",Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
        using var agent=new VNextLocalAgent(root);
        var storage=new CollectorStorage(root);
        var listener=new TcpListener(IPAddress.Loopback,0);listener.Start();var port=((IPEndPoint)listener.LocalEndpoint).Port;listener.Stop();
        using var overlay=new ByeollogOverlayService(storage,new OverlayAssetCache(root),agent.Context.State,port);
        overlay.WallpaperStateProvider=()=>agent.Context.State;
        if(!overlay.TryStart())throw new Exception("isolated overlay did not bind");
        var environment=await CoreWebView2Environment.CreateAsync(null,Path.Combine(root,"webview"));
        using var form=new WallpaperEditorForm(agent,storage,environment,uiRoot,null){ShowInTaskbar=false,StartPosition=FormStartPosition.Manual,Location=new(-32000,-32000)};
        form.Show();var web=form.Controls.OfType<WebView2>().Single();
        await WaitAsync(web,"document.querySelectorAll('#wallpaperSessions input').length===2","editor bootstrap");
        using var rendered=new WebView2 {Dock=DockStyle.Fill};host.Controls.Add(rendered);
        await rendered.EnsureCoreWebView2Async(environment);rendered.Source=new Uri($"http://127.0.0.1:{port}/overlay/wallpaper");
        await WaitAsync(rendered,"document.readyState==='complete'","overlay bootstrap");
        for(int i=0;i<36;i++){
            int index=i%2;
            await web.ExecuteScriptAsync($"document.querySelectorAll('#wallpaperSessions input')[{index}].click()");
            await WaitAsync(web,"document.getElementById('wallpaperStatus').classList.contains('ok')","selection settled");
            var expected=JsonSerializer.Deserialize<int>(await web.ExecuteScriptAsync("document.querySelectorAll('#wallpaperSessions input:checked').length"));
            await WaitAsync(web,$"document.querySelectorAll('#wallpaperPreview .wallpaper-tile').length==={expected}","editor tile count");
            using var snapshot=JsonDocument.Parse(agent.Context.State.SnapshotBytes());
            if(snapshot.RootElement.GetProperty("tiles").GetArrayLength()!=expected)throw new Exception("local state and checkbox disagree");
            await WaitAsync(rendered,$"document.querySelectorAll('.wallpaper-tile').length==={expected}","overlay tile count");
        }
        // Bursts during slow acknowledgements: the latest selection must win.
        agent.DelayMs=700;
        for(var burst=0;burst<6;burst++){
            for(int i=0;i<9;i++){await web.ExecuteScriptAsync("document.querySelectorAll('#wallpaperSessions input')[0].click()");await Task.Delay(45);}
            await WaitAsync(web,"document.getElementById('wallpaperStatus').classList.contains('ok')","burst settled");
            var expected=await web.ExecuteScriptAsync("document.querySelectorAll('#wallpaperSessions input:checked').length");
            await WaitAsync(web,$"document.querySelectorAll('#wallpaperPreview .wallpaper-tile').length==={expected}","burst editor");
            await WaitAsync(rendered,$"document.querySelectorAll('.wallpaper-tile').length==={expected}","burst overlay");
        }
        agent.DelayMs=60;
        await WaitAsync(web,"!document.getElementById('refreshWallpaperBtn').disabled","selection queue drained");
        await web.ExecuteScriptAsync("if(!document.querySelector('#wallpaperSessions input').checked)document.querySelector('#wallpaperSessions input').click()");
        await WaitAsync(web,"!document.getElementById('refreshWallpaperBtn').disabled && document.querySelectorAll('#wallpaperPreview .wallpaper-tile').length>0","settings fixture selected");
        // Settings must remain usable offline and survive closing/reopening the modal.
        await web.ExecuteScriptAsync("document.getElementById('openWallpaperSettingsBtn').click();document.getElementById('wallpaperMergeRanges').value='1-100';document.getElementById('saveWallpaperMergeBtn').click()");
        await WaitAsync(web,"document.getElementById('wallpaperSettingsStatus').classList.contains('ok')","local merge saved");
        await web.ExecuteScriptAsync("document.getElementById('closeWallpaperSettingsBtn').click();document.getElementById('openWallpaperSettingsBtn').click()");
        await WaitAsync(web,"document.getElementById('wallpaperMergeRanges').value==='1-100'","merge survives modal reopen");
        var writesBeforeRefresh=agent.RemoteWrites;
        await web.ExecuteScriptAsync("document.getElementById('closeWallpaperSettingsBtn').click();document.getElementById('refreshWallpaperBtn').click()");
        await WaitAsync(web,"document.getElementById('wallpaperStatus').classList.contains('ok') && document.getElementById('wallpaperMergeCount').textContent==='1개 범위'","refresh preserves local settings");
        if(agent.RemoteWrites!=writesBeforeRefresh)throw new Exception("local rules caused a server mutation");
        await web.ExecuteScriptAsync("document.getElementById('openWallpaperSettingsBtn').click()");
        using(var screenshot=File.Create(Path.Combine(root,"local-merge-settings.png")))
            await web.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,screenshot);
        await web.ExecuteScriptAsync("document.getElementById('closeWallpaperSettingsBtn').click()");
        await web.ExecuteScriptAsync("if(!document.querySelectorAll('#wallpaperSessions input')[0].checked)document.querySelectorAll('#wallpaperSessions input')[0].click()");
        await WaitAsync(web,"document.getElementById('wallpaperStatus').classList.contains('ok')","offline fixture selected");
        agent.Online=false;var before=agent.RemoteWrites;
        await web.ExecuteScriptAsync("document.querySelector('#wallpaperPreview .wallpaper-tile-meta').scrollIntoView({block:'center'})");
        var rectJson=await web.ExecuteScriptAsync("(()=>{const r=document.querySelector('#wallpaperPreview .wallpaper-tile-meta').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()");
        var rect=JsonSerializer.Deserialize<JsonElement>(rectJson);
        var x=rect.GetProperty("x").GetDouble();var y=rect.GetProperty("y").GetDouble();
        await web.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent",JsonSerializer.Serialize(new {type="mousePressed",x,y,button="left",clickCount=1}));
        await web.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent",JsonSerializer.Serialize(new {type="mouseMoved",x=x+60,y,button="left",buttons=1}));
        await web.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent",JsonSerializer.Serialize(new {type="mouseReleased",x=x+60,y,button="left",clickCount=1}));
        await Task.Delay(1200);
        if(agent.RemoteWrites!=before)throw new Exception("offline layout attempted remote write");
        if(agent.Context.State.PendingLayout() is null)throw new Exception("offline layout was not persisted");
        agent.Online=true;
        for(var i=0;i<8;i++){
            var previous=await web.ExecuteScriptAsync("location.href");
            await agent.SwitchAsync();
            await WaitAsync(web,$"location.href!=={previous} && document.querySelectorAll('#wallpaperSessions input').length===2 && document.querySelectorAll('#wallpaperPreview .wallpaper-tile').length===0","account switch");
            await WaitAsync(rendered,"document.querySelectorAll('.wallpaper-tile').length===0","account overlay empty");
        }
        Console.WriteLine("PASS: real WebView2 Form+editor JS+coordinator+local HTTP renderer: 36 sequential toggles, 54 rapid toggles with slow ACK, local merge save/reopen/refresh, offline persisted layout, 8 account document reloads. Fake remote transport; not installed EXE or actual OBS.");
        Console.WriteLine("WEBVIEW_ARTIFACT_ROOT="+root);
        form.Close();
    }
}
