using System.Net.Http.Headers;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using static HurogiCollector.WeflabTrialProtocol;

namespace HurogiCollector;

internal sealed partial class VNextDevelopmentClient
{
    internal event Action? WeflabSettingsChanged;
    internal void NotifyWeflabSettingsChanged() => WeflabSettingsChanged?.Invoke();
    internal Guid WeflabTrialUserId => _authenticatedUserId;
    internal async Task<JsonElement> WeflabTrialRpcAsync(string workspace, long epoch, object request, CancellationToken ct)
    {
        if (!IsSessionEpochCurrent(epoch) || WorkspaceId != workspace) throw new OperationCanceledException(ct);
        var body = JsonSerializer.Serialize(new { p_workspace_id = workspace, p_request = request });
        using var response = await SendWithSessionRecoveryAsync(token =>
        {
            if (!IsSessionEpochCurrent(epoch) || WorkspaceId != workspace) throw new OperationCanceledException(ct);
            var message = new HttpRequestMessage(HttpMethod.Post, SupabaseUrl + "/rest/v1/rpc/byeollog_weflab_trial_rpc_v1");
            message.Headers.TryAddWithoutValidation("apikey", PublishableKey);
            message.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            message.Content = new StringContent(body, Encoding.UTF8, "application/json");
            return message;
        }, HttpCompletionOption.ResponseContentRead, ct);
        if (!response.IsSuccessStatusCode) throw new IOException("trial_rpc_" + (int)response.StatusCode);
        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
        return doc.RootElement.Clone();
    }
}

// Browserless, opt-in shadow collection. Never writes to wallpaper/donation/upbo queues.
internal sealed class WeflabTrialAgent : IDisposable
{
    private readonly VNextDevelopmentClient _client;
    private readonly CollectorStorage _storage;
    private readonly CancellationTokenSource _stop = new();
    private readonly HttpClient _http = new(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(15) };
    private Task? _loop;
    private readonly SemaphoreSlim _wake = new(0, 1);
    private void Wake() { try { _wake.Release(); } catch (SemaphoreFullException) { } }
    private int _disposed;
    internal WeflabTrialAgent(VNextDevelopmentClient client, CollectorStorage storage) { _client = client; _storage = storage; _client.WeflabSettingsChanged += Wake; }
    internal void Start() { _loop ??= Task.Run(RunAsync); }
    private async Task RunAsync()
    {
        while (!_stop.IsCancellationRequested)
        {
            try
            {
                if (_client.IsSignedIn)
                {
                    var credentials = await _client.GetRealtimeCredentialsAsync(_stop.Token);
                    if (_client.TryStartSessionOperation(credentials.SessionEpoch, _stop.Token,
                        async ct => { await SessionAsync(credentials.WorkspaceId, credentials.SessionEpoch, ct); return true; },
                        out var lifetime, out Task<bool>? operation))
                    {
                        using (lifetime) await operation!;
                    }
                }
            }
            catch (OperationCanceledException) { }
            catch (Exception ex) { _storage.Log("위플랩 시험 수집 재연결 대기 · type=" + ex.GetType().Name); }
            try { await Task.Delay(TimeSpan.FromSeconds(30), _stop.Token); } catch (OperationCanceledException) { }
        }
    }
    private async Task SessionAsync(string workspace, long epoch, CancellationToken ct)
    {
        if (!Guid.TryParse(workspace, out var workspaceGuid)) return;
        var root = Path.Combine(AgentDataPaths.PrepareDataRoot().RootPath, "weflab-trial", workspaceGuid.ToString(), _client.WeflabTrialUserId.ToString());
        Directory.CreateDirectory(root);
        var identityFile = Path.Combine(root, "worker-id.txt");
        if (!File.Exists(identityFile)) File.WriteAllText(identityFile, Guid.NewGuid().ToString());
        var worker = Guid.Parse(File.ReadAllText(identityFile)).ToString();
        var store = new TrialFiles(root);
        Task<JsonElement> Rpc(object value)
        {
            var element = JsonSerializer.SerializeToElement(value);
            var fields = element.EnumerateObject().ToDictionary(p => p.Name, p => (object?)p.Value.Clone());
            fields["workerId"] = worker;
            return _client.WeflabTrialRpcAsync(workspace, epoch, fields, ct);
        }
        Intake? intake = null;
        try
        {
            while (!ct.IsCancellationRequested)
            {
                await store.FlushAsync(Rpc);
                // Disabled accounts make one cheap discovery call per five minutes and never contact Weflab.
                var h = await Rpc(new { action = "heartbeat", ready = intake?.Ready == true });
                var status = Text(h, "status");
                if (status == "disabled") { intake?.Dispose(); intake = null; await _wake.WaitAsync(TimeSpan.FromMinutes(5), ct); continue; }
                if (intake?.Failed == true) { intake.Dispose(); intake = null; }
                if (status is "prepare" or "owner")
                {
                    if (intake == null)
                    {
                        intake = new Intake(_http, h.GetProperty("config"), q => { store.Record(q); store.Enqueue(q); }, ct);
                        await intake.StartAsync();
                    }
                }
                else { intake?.Dispose(); intake = null; }
                if (status == "draining") await Rpc(new { action = "release", token = Text(h, "token") });
                if (status == "owner" && intake?.Ready == true)
                {
                    var due = await Rpc(new { action = "due", token = Text(h, "token") });
                    foreach (var key in due.GetProperty("keys").EnumerateArray().Take(1))
                        await LookupAsync(Rpc, store, key.GetString()!, Text(h, "token"), ct);
                }
                store.Status(new { at = DateTimeOffset.UtcNow, status, ready = intake?.Ready == true, campaignId = Text(h, "campaignId") });
                await _wake.WaitAsync(TimeSpan.FromSeconds(10), ct);
            }
        }
        finally { intake?.Dispose(); }
    }
    private async Task LookupAsync(Func<object, Task<JsonElement>> rpc, TrialFiles store, string key, string token, CancellationToken ct)
    {
        var reserved = await rpc(new { action = "reserve", key, token });
        if (Text(reserved, "status") != "reserved") return;
        var plan = reserved.GetProperty("plan"); var body = plan.GetProperty("body"); var attempt = Text(reserved, "attempt");
        if (Text(plan, "key") != key || Text(body, "type") != "roulette_result" || Text(body, "platform") != "afreeca") throw new IOException("trial_plan");
        store.Record(new { kind = "request_started", key, attempt, plan });
        object response;
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct); timeout.CancelAfter(TimeSpan.FromSeconds(10));
            using var message = new HttpRequestMessage(HttpMethod.Post, "https://weflab.com/api/")
            { Content = new FormUrlEncodedContent(body.EnumerateObject().Select(p => new KeyValuePair<string, string>(p.Name, p.Value.ToString()))) };
            using var r = await _http.SendAsync(message, timeout.Token);
            var raw = await r.Content.ReadAsStringAsync(timeout.Token);
            response = new { httpStatus = (int)r.StatusCode, raw, assessment = r.IsSuccessStatusCode ? Assess(raw, plan.GetProperty("count").GetInt32()) : (object)new { status = "needs_review", reason = "provider_http" } };
        }
        catch { response = new { assessment = new { status = "needs_review", reason = "uncertain_request_do_not_repeat" } }; }
        // Response survives failed ACK/session end. A retry only uploads this envelope.
        var complete = new { action = "complete", key, attempt, response };
        store.Record(new { kind = "response", payload = complete }); store.Enqueue(complete);
        await store.FlushAsync(rpc);
    }
    private sealed class TrialFiles
    {
        private readonly string _root, _outbox; private readonly object _gate = new();
        public TrialFiles(string root) { _root = root; _outbox = Path.Combine(root, "outbox"); Directory.CreateDirectory(_outbox); }
        private void CheckSize() { if (Directory.EnumerateFiles(_root, "*", SearchOption.AllDirectories).Sum(f => new FileInfo(f).Length) > 128L * 1024 * 1024) throw new IOException("trial_local_capacity"); }
        public void Record(object value)
        {
            lock (_gate)
            {
                CheckSize(); using var file = new FileStream(Path.Combine(_root, "evidence.jsonl"), FileMode.Append, FileAccess.Write, FileShare.Read);
                file.Write(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { at = DateTimeOffset.UtcNow, value }) + "\n")); file.Flush(true);
            }
        }
        public void Enqueue(object value)
        {
            lock (_gate)
            {
                CheckSize(); var bytes = JsonSerializer.SerializeToUtf8Bytes(value); var key = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
                var file = Path.Combine(_outbox, key + ".json"); if (File.Exists(file)) return;
                using (var stream = new FileStream(file + ".tmp", FileMode.CreateNew, FileAccess.Write, FileShare.None)) { stream.Write(bytes); stream.Flush(true); }
                File.Move(file + ".tmp", file);
            }
        }
        public async Task FlushAsync(Func<object, Task<JsonElement>> rpc)
        {
            foreach (var file in Directory.EnumerateFiles(_outbox, "*.json").Take(25).ToArray())
            {
                using var doc = JsonDocument.Parse(await File.ReadAllTextAsync(file));
                var result = await rpc(doc.RootElement);
                if (Text(result, "status") is "disabled" or "capacity_stop") continue;
                if (Text(result, "status") is not ("recorded" or "already_recorded" or "ignored")) throw new IOException("trial_delivery_not_accepted");
                File.Delete(file);
            }
        }
        public void Status(object value) { lock (_gate) File.WriteAllText(Path.Combine(_root, "status.json"), JsonSerializer.Serialize(value)); }
    }
    private sealed class Intake : IDisposable
    {
        private readonly HttpClient _http; private readonly JsonElement _pin; private readonly Action<object> _record;
        private readonly CancellationTokenSource _stop; private JsonElement _context, _rules; private int _joined, _failed;
        public bool Ready => Volatile.Read(ref _joined) == 2 && !Failed;
        public bool Failed => Volatile.Read(ref _failed) != 0;
        public Intake(HttpClient http, JsonElement pin, Action<object> record, CancellationToken ct) { _http = http; _pin = pin.Clone(); _record = record; _stop = CancellationTokenSource.CreateLinkedTokenSource(ct); }
        public async Task StartAsync()
        {
            var uri = new Uri(Text(_pin, "url"));
            if (uri.Scheme != "https" || uri.Host != "weflab.com" || !uri.IsDefaultPort || uri.UserInfo != "" || uri.Query != "" || uri.Fragment != "" || !Regex.IsMatch(uri.AbsolutePath, "^/page/[A-Za-z0-9]+$")) throw new IOException("trial_url");
            var html = await _http.GetStringAsync(uri, _stop.Token);
            var match = Regex.Match(html, @"const loginData\s*=\s*(\{[^\r\n]*\});");
            using var doc = JsonDocument.Parse(match.Success ? match.Groups[1].Value : "null"); _context = doc.RootElement.Clone();
            if (Text(_context, "type") != "page" || Text(_context, "pageid") != "alert" || Text(_context, "idx") != Text(_pin, "idx") || Text(_context, "preset") != Text(_pin, "preset") || Text(_context.GetProperty("platform").GetProperty("afreeca"), "id") != Text(_pin, "owner")) throw new IOException("trial_scope");
            var urls = _context.GetProperty("config").GetProperty("url");
            if (Text(urls, "socket") != "https://ssmain.weflab.com" || Text(urls, "socket_afreeca") != "https://ssafreeca.weflab.com") throw new IOException("trial_socket_origin");
            using var r = await _http.PostAsync("https://weflab.com/api/", new FormUrlEncodedContent(new Dictionary<string,string>
            { ["type"]="page_load",["pagetype"]="page",["idx"]=Text(_context,"idx"),["pageid"]="alert",["preset"]=Text(_context,"preset"),["dir"]=Text(_context,"dir"),["ver"]=Text(_context.GetProperty("config"),"ver") }), _stop.Token);
            r.EnsureSuccessStatusCode(); using var rules = JsonDocument.Parse(await r.Content.ReadAsStringAsync(_stop.Token)); _rules = rules.RootElement.Clone();
            if (Text(_rules,"result")!="success")throw new IOException("trial_rules");
            _ = SocketAsync("main"); _ = SocketAsync("afreeca");
        }
        private async Task SocketAsync(string channel)
        {
            while (!_stop.IsCancellationRequested)
            {
                var joined = false;
                try
                {
                    using var ws = new ClientWebSocket(); ws.Options.SetRequestHeader("Origin", "https://weflab.com");
                    var host = channel == "main" ? "ssmain.weflab.com" : "ssafreeca.weflab.com";
                    await ws.ConnectAsync(new Uri("wss://" + host + "/socket.io/?EIO=4&transport=websocket&idx=" + Uri.EscapeDataString(Text(_context,"idx")) + "&type=page&page=alert"), _stop.Token);
                    var limit = 45000;
                    while (ws.State == WebSocketState.Open && !_stop.IsCancellationRequested)
                    {
                        using var wait = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token); wait.CancelAfter(limit);
                        using var ms = new MemoryStream(); var buffer = new byte[16384]; WebSocketReceiveResult received;
                        do { received = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), wait.Token); if(received.MessageType==WebSocketMessageType.Close)throw new IOException("trial_socket_closed");ms.Write(buffer,0,received.Count);if(ms.Length>1048576)throw new IOException("trial_frame_limit"); } while(!received.EndOfMessage);
                        var raw = Encoding.UTF8.GetString(ms.ToArray());
                        async Task Send(string text) => await ws.SendAsync(new ArraySegment<byte>(Encoding.UTF8.GetBytes(text)),WebSocketMessageType.Text,true,_stop.Token);
                        if(raw.StartsWith('0')) { using var hello=JsonDocument.Parse(raw[1..]);limit=Math.Clamp(hello.RootElement.GetProperty("pingInterval").GetInt32()+hello.RootElement.GetProperty("pingTimeout").GetInt32()+5000,15000,120000);await Send("40");continue; }
                        if(raw=="2"){await Send("3");continue;}
                        if(raw.StartsWith("40",StringComparison.Ordinal))
                        {
                            var join=new Dictionary<string,object?> { ["type"]=channel=="main"?"join":"join_platform",["page"]="page",["idx"]=_context.GetProperty("idx"),["pageid"]="alert",["preset"]=_context.GetProperty("preset") };
                            if(channel!="main"){join["platform"]="afreeca";join["id"]=Text(_pin,"owner");}
                            await Send("42"+JsonSerializer.Serialize(new object[]{"msg",join}));if(!joined){joined=true;Interlocked.Increment(ref _joined);}continue;
                        }
                        if(raw=="41"||raw.StartsWith("44",StringComparison.Ordinal))throw new IOException("trial_namespace_closed");
                        if(!raw.StartsWith("42",StringComparison.Ordinal))continue;
                        using var frame=JsonDocument.Parse(raw[2..]);if(frame.RootElement[0].GetString()!="msg")continue;
                        var message=frame.RootElement[1];var type=Text(message,"type");
                        if(type is "load" or "refresh" or "refresh_all"){Interlocked.Exchange(ref _failed,1);_stop.Cancel();return;}
                        if(type is "alert" or "test_donation")
                        {
                            try { _record(new {action="ingest",context=_context,rules=_rules,message=message.Clone()}); }
                            catch { Interlocked.Exchange(ref _failed,1);_stop.Cancel();return; }
                        }
                    }
                }
                catch(OperationCanceledException) when(_stop.IsCancellationRequested){return;}
                catch(Exception ex) { if(ex is not WebSocketException && ex is not IOException && ex is not OperationCanceledException){Interlocked.Exchange(ref _failed,1);_stop.Cancel();return;} }
                finally { if(joined)Interlocked.Decrement(ref _joined); }
                try{await Task.Delay(5000,_stop.Token);}catch(OperationCanceledException){return;}
            }
        }
        public void Dispose(){_stop.Cancel();} // Socket tasks own cancellation until they finish.
    }
    public void Dispose()
    {
        if(Interlocked.Exchange(ref _disposed,1)!=0)return;
        _client.WeflabSettingsChanged -= Wake;
        _stop.Cancel();
        var task=_loop??Task.CompletedTask;
        _=task.ContinueWith(t=>{_=t.Exception;_http.Dispose();_stop.Dispose();},TaskScheduler.Default);
    }
}
