using System.Diagnostics;
using System.Reflection;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace HurogiCollector;

internal sealed class CollectorLoginWebForm : Form
{
    private readonly CollectorStorage _storage;
    private readonly VNextDevelopmentClient _automationClient;
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(30) };
    private readonly WebView2 _ui = new() { Dock = DockStyle.Fill };
    private readonly NotifyIcon _trayIcon = new();
    private readonly ContextMenuStrip _trayMenu = new();
    private readonly string _rememberedIdPath;
    private readonly AdaptiveWindowController _adaptiveWindow;
    private Icon? _appIcon;
    private Task? _uiInitializationTask;
    private bool _ready;
    private bool _loginInProgress;
    private bool _accountLoginCommitted;
    private bool _allowClose;

    // 로그인 성공 뒤 top-level 창이 하나도 없는 상태에서 MainForm을 만드는
    // 공백을 없애기 위해 Program이 메인 폼을 미리 준비할 수 있게 합니다.
    // 인증 요청이 성공하기 전에는 절대 호출되지 않습니다.
    internal Func<Task>? PrepareMainWindowBeforeCloseAsync { get; set; }

    internal CollectorLoginWebForm(CollectorStorage storage, VNextDevelopmentClient automationClient)
    {
        _storage = storage;
        _automationClient = automationClient;
        _rememberedIdPath = Path.Combine(storage.RootPath, "remembered_login_id.txt");

        Text = "별록 로그인";
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.None;
        AutoScaleMode = AutoScaleMode.None;
        ClientSize = new Size(AdaptiveWindowController.DesignWidth, AdaptiveWindowController.DesignHeight);
        _adaptiveWindow = new AdaptiveWindowController(this);
        _appIcon = LoadAppIcon();
        Icon = _appIcon;
        ShowInTaskbar = true;
        BackColor = Color.FromArgb(7, 18, 38);
        Controls.Add(_ui);
        SetupLoginTray();

        // The HTML shell already draws rounded corners, but WebView2 still occupies a
        // rectangular native top-level window. Clip the actual login window just like
        // MainForm so the WebView background cannot leak through at any corner.
        ApplyRoundedRegion(24);
        Resize += (_, _) => ApplyRoundedRegion(24);

        Shown += async (_, _) => await InitializeUiForDisplayAsync();
        FormClosing += (_, e) =>
        {
            if (_allowClose || e.CloseReason != CloseReason.UserClosing) return;
            e.Cancel = true;
            HideToTray();
        };
        FormClosed += (_, _) =>
        {
            _trayIcon.Visible = false;
            _trayIcon.Dispose();
            _trayMenu.Dispose();
            _appIcon?.Dispose();
            _appIcon = null;
        };
    }

    private void SetupLoginTray()
    {
        var openItem = new ToolStripMenuItem("별록 풍벽지 열기")
        {
            Font = new Font(SystemFonts.MenuFont ?? Control.DefaultFont, FontStyle.Bold)
        };
        openItem.Click += (_, _) => RestoreFromTray();
        var exitItem = new ToolStripMenuItem("프로그램 종료");
        exitItem.Click += (_, _) =>
        {
            _allowClose = true;
            DialogResult = DialogResult.Cancel;
            Close();
        };
        _trayMenu.Items.Add(openItem);
        _trayMenu.Items.Add(new ToolStripSeparator());
        _trayMenu.Items.Add(exitItem);
        _trayIcon.Icon = _appIcon ?? SystemIcons.Application;
        _trayIcon.Text = "별록 풍벽지 · 서버 연결 필요";
        _trayIcon.ContextMenuStrip = _trayMenu;
        _trayIcon.DoubleClick += (_, _) => RestoreFromTray();
        _trayIcon.Visible = true;
    }

    private void HideToTray()
    {
        Hide();
        ShowInTaskbar = false;
    }

    private void RestoreFromTray()
    {
        ShowInTaskbar = true;
        if (!Visible) Show();
        WindowState = FormWindowState.Normal;
        Activate();
        BringToFront();
    }

    private void ApplyRoundedRegion(int radius)
    {
        if (Width <= 2 || Height <= 2) return;

        var diameter = Math.Max(2, radius * 2);
        var bounds = new Rectangle(0, 0, Math.Max(1, Width - 1), Math.Max(1, Height - 1));
        using var path = new System.Drawing.Drawing2D.GraphicsPath();
        path.AddArc(bounds.Left, bounds.Top, diameter, diameter, 180, 90);
        path.AddArc(bounds.Right - diameter, bounds.Top, diameter, diameter, 270, 90);
        path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(bounds.Left, bounds.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();

        var previous = Region;
        Region = new Region(path);
        previous?.Dispose();
    }

    private static Icon LoadAppIcon()
    {
        try
        {
            var assembly = Assembly.GetExecutingAssembly();
            using var stream = assembly.GetManifestResourceStream("HurogiCollector.Assets.byeollog_app.ico");
            if (stream is not null)
            {
                using var embedded = new Icon(stream);
                return (Icon)embedded.Clone();
            }

            var executableIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            if (executableIcon is not null) return (Icon)executableIcon.Clone();
        }
        catch
        {
            // 개발 환경에서는 기본 아이콘으로 폴백하되 로그인은 계속 진행합니다.
        }

        return (Icon)SystemIcons.Application.Clone();
    }

    internal Task PrepareForDisplayAsync()
    {
        CreateControl();
        return _uiInitializationTask ??= InitializeUiCoreAsync();
    }

    private async Task InitializeUiForDisplayAsync()
    {
        try
        {
            await PrepareForDisplayAsync();
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "로그인 화면을 시작하지 못했습니다.\n\n" + ex.Message,
                BuildInfo.ProductName,
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            Close();
        }
    }

    private async Task InitializeUiCoreAsync()
    {
        var userData = Path.Combine(_storage.RootPath, "LoginUiWebView2Data");
        var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: userData);
        await _ui.EnsureCoreWebView2Async(environment);
        _ui.CoreWebView2.Settings.AreDevToolsEnabled = false;
        _ui.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
        _ui.CoreWebView2.Settings.IsZoomControlEnabled = false;
        _ui.CoreWebView2.WebMessageReceived += async (_, e) => await HandleUiMessageAsync(e);

        var uiRoot = UiAssetStore.Prepare();
        _ui.CoreWebView2.SetVirtualHostNameToFolderMapping(
            "byeollog.local",
            uiRoot,
            CoreWebView2HostResourceAccessKind.DenyCors);

        var navigationReady = new TaskCompletionSource<string?>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var theme = _storage.LoadTheme();
        _ui.NavigationCompleted += async (_, e) =>
        {
            if (!e.IsSuccess)
            {
                navigationReady.TrySetResult("별록 로그인 화면을 불러오지 못했습니다: " + e.WebErrorStatus);
                return;
            }
            try
            {
                _ready = true;
                await SendLoginStateAsync(new
                {
                    rememberedId = LoadRememberedId(),
                    autoLogin = _automationClient.HasRememberedSession,
                    busy = false,
                    message = "",
                    error = false
                });
                navigationReady.TrySetResult(null);
            }
            catch (Exception ex)
            {
                navigationReady.TrySetResult(ex.Message);
            }
        };
        _ui.Source = new Uri($"https://byeollog.local/byeollog_ui.html?mode=login&theme={theme}");
        var navigationError = await navigationReady.Task.WaitAsync(TimeSpan.FromSeconds(15));
        if (!string.IsNullOrWhiteSpace(navigationError))
            throw new InvalidOperationException(navigationError);
    }

    private async Task HandleUiMessageAsync(CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!Uri.TryCreate(e.Source, UriKind.Absolute, out var sourceUri)
            || sourceUri.Scheme != Uri.UriSchemeHttps
            || !string.Equals(sourceUri.Host, "byeollog.local", StringComparison.OrdinalIgnoreCase))
        {
            _storage.Log("Login UI message blocked (source): " + (e.Source ?? ""));
            return;
        }
        try
        {
            using var document = JsonDocument.Parse(e.WebMessageAsJson);
            var root = document.RootElement;
            var action = root.TryGetProperty("action", out var actionElement)
                ? actionElement.GetString() ?? ""
                : "";
            var payload = root.TryGetProperty("payload", out var payloadElement)
                ? payloadElement
                : default;

            switch (action)
            {
                case "windowDrag":
                    NativeWindowDrag.Begin(this);
                    break;
                case "minimize":
                    WindowState = FormWindowState.Minimized;
                    break;
                case "close":
                    HideToTray();
                    break;
                case "theme":
                    if (payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty("theme", out var theme))
                        _storage.SaveTheme(theme.GetString() ?? "dark");
                    break;
                case "login":
                    var id = payload.TryGetProperty("id", out var idElement) ? idElement.GetString() ?? "" : "";
                    var password = payload.TryGetProperty("password", out var passwordElement) ? passwordElement.GetString() ?? "" : "";
                    var remember = payload.TryGetProperty("remember", out var rememberElement) && rememberElement.ValueKind == JsonValueKind.True;
                    var autoLogin = payload.TryGetProperty("autoLogin", out var autoLoginElement) && autoLoginElement.ValueKind == JsonValueKind.True;
                    await LoginAsync(id, password, remember, autoLogin);
                    break;
                case "forgotPassword":
                    OpenSite("/forgot-password");
                    break;
                case "signup":
                    OpenSite("/signup");
                    break;
            }
        }
        catch (Exception ex)
        {
            await SendLoginStateAsync(new { busy = false, message = ex.Message, error = true });
        }
    }

    private string BaseServerUrl()
    {
        var url = (_storage.Config.ServerUrl ?? "").Trim();
        if (url.EndsWith("/api/collector", StringComparison.OrdinalIgnoreCase))
            url = url[..^"/api/collector".Length];
        return string.IsNullOrWhiteSpace(url) ? CollectorStorage.ProductionServerUrl : url.TrimEnd('/');
    }

    private async Task LoginAsync(string id, string password, bool remember, bool autoLogin)
    {
        id = id.Trim();

        // 계정 인증과 기기 등록은 이미 성공했지만 메인 창 준비만 실패한 경우에는
        // 비밀번호를 다시 받거나 pair/adoption을 중복 실행하지 않고 화면 준비만 재시도합니다.
        if (_accountLoginCommitted)
        {
            if (_loginInProgress) return;
            _loginInProgress = true;
            try
            {
                await CompleteMainWindowHandoffAsync();
            }
            finally
            {
                if (DialogResult != DialogResult.OK)
                    _loginInProgress = false;
            }
            return;
        }

        if (string.IsNullOrWhiteSpace(id))
        {
            await SendLoginStateAsync(new { busy = false, message = "이메일 또는 아이디를 입력해주세요.", error = true, focus = "id" });
            return;
        }
        if (string.IsNullOrWhiteSpace(password))
        {
            await SendLoginStateAsync(new { busy = false, message = "비밀번호를 입력해주세요.", error = true, focus = "password" });
            return;
        }

        // WebView 버튼 비활성화가 반영되기 전 연속 Enter/클릭이 들어오더라도
        // pair 요청과 메인 폼 준비는 실행 수명당 한 번만 진행합니다.
        if (_loginInProgress) return;
        _loginInProgress = true;
        try
        {
            // 연결 중에는 버튼 상태만 잠그고 별도 문구로 레이아웃을 흔들지 않습니다.
            await SendLoginStateAsync(new { busy = true, message = "", error = false });
            var baseUrl = CollectorStorage.ProductionServerUrl;
            var json = JsonSerializer.Serialize(new
            {
                mode = "core_agent",
                email = id,
                password,
                device_name = Environment.MachineName,
                collector_version = BuildInfo.Version,
                automation_capability = VNextDevelopmentClient.AutomationCapability
            });

            using var request = new HttpRequestMessage(HttpMethod.Post, baseUrl + "/api/collector-pair");
            request.Content = new StringContent(json, Encoding.UTF8, "application/json");
            using var response = await _http.SendAsync(request);
            var body = await response.Content.ReadAsStringAsync();

            if (!response.IsSuccessStatusCode)
            {
                try
                {
                    using var error = JsonDocument.Parse(body);
                    if (error.RootElement.TryGetProperty("message", out var message))
                        throw new Exception(message.GetString() ?? "로그인에 실패했습니다.");
                }
                catch (JsonException) { }
                throw new Exception("로그인에 실패했습니다.");
            }

            using var document = JsonDocument.Parse(body);
            var adopted = await _automationClient.BeginCollectorPairSessionAdoption(
                document.RootElement.Clone(),
                id,
                rememberSession: autoLogin);
            if (!adopted)
                throw new Exception("풍벽지 서버 세션을 안전하게 연결하지 못했습니다. 다시 시도해주세요.");

            _storage.SaveStreamerName(ExtractStreamerName(document.RootElement));
            _storage.MarkAccountLoginComplete();
            PersistRememberedId(id, remember);
            _accountLoginCommitted = true;
            await CompleteMainWindowHandoffAsync();
        }
        catch (Exception ex)
        {
            await SendLoginStateAsync(new { busy = false, message = ex.Message, error = true, clearPassword = true, focus = "password" });
        }
        finally
        {
            if (DialogResult != DialogResult.OK)
                _loginInProgress = false;
        }
    }

    private async Task CompleteMainWindowHandoffAsync()
    {
        try
        {
            await SendLoginStateAsync(new
            {
                busy = true,
                phase = "preparing",
                message = "로그인 완료 · 별록 화면을 준비하고 있습니다.",
                error = false,
                clearPassword = true
            });
            if (PrepareMainWindowBeforeCloseAsync is not null)
                await PrepareMainWindowBeforeCloseAsync();
            _allowClose = true;
            _trayIcon.Visible = false;
            DialogResult = DialogResult.OK;
            Close();
        }
        catch (Exception ex)
        {
            _storage.Log("로그인 후 메인 화면 준비 실패: " + ex.GetType().Name);
            try
            {
                await SendLoginStateAsync(new
                {
                    busy = false,
                    phase = "prepareError",
                    message = "로그인은 완료됐지만 별록 화면을 준비하지 못했습니다. 아래 버튼으로 화면 준비를 다시 시도해주세요.\n\n" + ex.Message,
                    error = true,
                    clearPassword = true
                });
            }
            catch
            {
                // 준비 실패 안내조차 렌더링할 수 없는 경우에도 인증 성공 상태는 유지합니다.
            }
        }
    }

    private void BeginAutomationSessionAdoption(JsonElement pairResponse, string fallbackEmail)
    {
        var adoption = _automationClient.BeginCollectorPairSessionAdoption(pairResponse, fallbackEmail);
        _ = ObserveAutomationSessionAdoptionAsync(adoption);
    }

    private async Task ObserveAutomationSessionAdoptionAsync(Task<bool> adoption)
    {
        try
        {
            // 계정 비밀번호는 pair 서버까지만 전송합니다. 서버가 같은 offsl
            // 프로젝트에서 발급했고 Auth 사용자·workspace 권한까지 검증되는
            // 짧은 세션만 실행 중 메모리에 채택합니다.
            if (!await adoption)
                _storage.Log("방송 자동화 통합 세션 없음: 기존 수집 모드로 계속 실행");
        }
        catch (Exception ex)
        {
            // 시간 초과를 포함한 자동화 인증 실패는 이미 성공한 Collector 로그인의
            // 상태와 화면 전환에 영향을 주지 않습니다.
            _storage.Log("방송 자동화 세션 연결 보류: " + ex.GetType().Name);
        }
    }

    private static string ExtractStreamerName(JsonElement root)
    {
        var preferredKeys = new[] { "streamer_name", "streamerName", "workspace_name", "workspaceName", "display_name", "displayName", "nickname", "name" };
        foreach (var key in preferredKeys)
        {
            if (root.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(value.GetString()))
                return value.GetString()!;
        }

        var objectKeys = new[] { "workspace", "streamer", "profile", "user", "account" };
        foreach (var objectKey in objectKeys)
        {
            if (!root.TryGetProperty(objectKey, out var nested)) continue;
            if (nested.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(nested.GetString())) return nested.GetString()!;
            if (nested.ValueKind != JsonValueKind.Object) continue;
            var result = ExtractStreamerName(nested);
            if (!string.Equals(result, "스트리머", StringComparison.Ordinal)) return result;
        }
        return "스트리머";
    }

    private string LoadRememberedId()
    {
        try { return File.Exists(_rememberedIdPath) ? File.ReadAllText(_rememberedIdPath, Encoding.UTF8).Trim() : ""; }
        catch { return ""; }
    }

    private void PersistRememberedId(string id, bool remember)
    {
        try
        {
            if (remember) File.WriteAllText(_rememberedIdPath, id, new UTF8Encoding(false));
            else if (File.Exists(_rememberedIdPath)) File.Delete(_rememberedIdPath);
        }
        catch { }
    }

    private void OpenSite(string path)
    {
        try
        {
            var baseUrl = BaseServerUrl().TrimEnd('/') + "/";
            if (!WebViewTrustPolicy.TryResolveSameOriginExternalUri(baseUrl, path.TrimStart('/'), out var target, out _))
                throw new InvalidOperationException("외부 페이지 주소가 허용된 서버 범위를 벗어났습니다.");
            Process.Start(new ProcessStartInfo { FileName = target.AbsoluteUri, UseShellExecute = true });
        }
        catch { }
    }

    private async Task SendLoginStateAsync(object state)
    {
        if (!_ready || _ui.CoreWebView2 is null) return;
        var json = JsonSerializer.Serialize(state);
        await _ui.CoreWebView2.ExecuteScriptAsync($"window.byeollog?.setLoginState({json});");
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _adaptiveWindow.Dispose();
            _http.Dispose();
        }
        base.Dispose(disposing);
    }
}
