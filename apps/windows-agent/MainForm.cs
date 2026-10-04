using System.Diagnostics;
using System.Net.Http.Headers;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace HurogiCollector;

public sealed class MainForm : Form
{
    // 매니저용 8자리 연결 코드 기능은 구현 상태로 유지하되 기본 배포 UI에서는 숨깁니다.
    // 문의 대응으로 공개할 때 true로 바꾸면 버튼이 즉시 나타납니다.
    private const bool EnableManagerPairingCodeUi = false;
    // The legacy Collector wire contract has always sent a four-part numeric
    // version. Keep build labels out of /api/collector* for v0.5.1.8 servers.
    private static readonly string CollectorVersion = BuildInfo.Version;
    private readonly AgentUpdateNoticeCache _updateNotice = new(AgentUpdateNotice.ReadCurrent);
    private readonly WebView2 _ui = new();
    private readonly CollectorStorage _storage;
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(30) };
    private bool _dashboardOpenInProgress;
    private readonly VNextDevelopmentClient _vNextDevClient;
    private readonly VNextLocalAgent? _vNextLocalAgent;
    private readonly VNextActivityMonitor _activityMonitor;
    private CoreWebView2Environment? _mainUiWebViewEnvironment;
    private Task<CoreWebView2Environment>? _mainUiWebViewEnvironmentTask;
    private Task? _mainUiInitializationTask;
    private CoreWebView2Environment? _automationWebViewEnvironment;
    private Task<CoreWebView2Environment>? _automationWebViewEnvironmentTask;
    private VNextAutomationSettingsForm? _automationSettingsForm;
    private CoreWebView2Environment? _wallpaperEditorWebViewEnvironment;
    private Task<CoreWebView2Environment>? _wallpaperEditorWebViewEnvironmentTask;
    private WallpaperEditorForm? _wallpaperEditorForm;
    private bool _wallpaperEditorOpenOrPending;
    private bool _automationSettingsOpenOrPending;
    private bool _automationSettingsShowRequested;
    private string _pendingAutomationView = "wallpaper";
    private bool _activityBalloonPending;
    private readonly TimedMuteActionAdapter _timedMuteActions;
    private readonly string _vNextAgentStartupError = "";
    private bool _vNextAgentE2EInProgress;
    private bool _vNextObsE2EInProgress;
    private bool _obsTestInProgress;
    private bool _obsMuteCycleInProgress;
    private bool _timedMuteTestInProgress;
    private bool _preflightInProgress;
    private readonly Label _collectorStatus = new();
    private readonly Label _sessionStatus = new();
    private readonly Button _startButton = new();
    private readonly Button _uploadButton = new();
    private readonly NotifyIcon _trayIcon = new();
    private readonly ContextMenuStrip _trayMenu = new();
    private ToolStripMenuItem? _vNextDevStatusItem;
    private ToolStripMenuItem? _vNextAgentStatusItem;
    private ToolStripMenuItem? _obsStatusItem;
    private ToolStripMenuItem? _windowsCaptureStatusItem;
    private bool _darkMode;
    private bool _allowExit;
    private bool _trayHintShown;
    private bool _trayInitialized;
    private Icon? _appIcon;
    private readonly AdaptiveWindowController _adaptiveWindow;

    private bool _uiReady;

    internal MainForm(CollectorStorage storage, DateTime programStartedAtLocal, VNextDevelopmentClient vNextDevClient)
    {
        _storage = storage;
        _vNextDevClient = vNextDevClient;
        _timedMuteActions = new TimedMuteActionAdapter(storage);
        try
        {
            _vNextLocalAgent = new VNextLocalAgent(_vNextDevClient, _storage);
            _vNextLocalAgent.StatusChanged += VNextLocalAgent_StatusChanged;
        }
        catch (Exception ex)
        {
            _vNextAgentStartupError = ex.Message;
            _storage.Log("vNext Local Agent 초기화 실패: " + ex.GetType().Name);
        }
        _activityMonitor = new VNextActivityMonitor(_vNextDevClient);
        _activityMonitor.NotificationReady += ActivityMonitor_NotificationReady;
        _vNextDevClient.SessionChanged += VNextDevClient_SessionChanged;
        _vNextDevClient.SessionRecoveryChanged += VNextDevClient_SessionRecoveryChanged;
        var interrupted = _storage.Session?.Active == true;
        if (interrupted) _storage.CloseInterruptedSessionOnStartup();
        Text = $"별록 풍벽지 v{BuildInfo.DisplayVersion}";
        // 메인 화면에는 더 이상 세로로 늘어나야 할 콘텐츠가 없습니다.
        // 사용자가 창을 늘려 레이아웃 사이에 큰 공백이 생기는 일을 막고
        // 실제 배포 UI의 비율을 항상 동일하게 유지합니다.
        FormBorderStyle = FormBorderStyle.None;
        AutoScaleMode = AutoScaleMode.None;
        ClientSize = new Size(AdaptiveWindowController.DesignWidth, AdaptiveWindowController.DesignHeight);
        MaximizeBox = false;
        MinimizeBox = false;
        SizeGripStyle = SizeGripStyle.Hide;
        StartPosition = FormStartPosition.CenterScreen;
        _adaptiveWindow = new AdaptiveWindowController(this);
        Font = new Font("맑은 고딕", 10.2F);
        _darkMode = _storage.LoadTheme() != "light";
        _appIcon = LoadAppIcon();
        Icon = _appIcon;
        BuildUi();
        SetupRoundedUi(this);
        ApplyRoundedRegion(this, 24);
        Resize += (_, _) => ApplyRoundedRegion(this, 24);
        ApplyTheme();
        FormClosing += MainForm_FormClosing;
        Shown += async (_, _) =>
        {
            if (!_trayInitialized)
            {
                SetupTray();
                _trayInitialized = true;
            }
            EnsureMainWindowVisible();
            if (_vNextDevClient.IsSignedIn) _vNextLocalAgent?.Start();
            await InitUiAsync();
            await FlushPendingDiagnosticsAsync();
        };
    }

    internal void UsePrewarmedMainUiEnvironment(Task<CoreWebView2Environment>? environmentTask)
    {
        if (environmentTask is null || _mainUiWebViewEnvironment is not null) return;
        _mainUiWebViewEnvironmentTask ??= environmentTask;
    }

    internal void PreserveCurrentLocationOnFirstShow()
    {
        _adaptiveWindow.PreserveCurrentLocationOnFirstShow();
    }

    private Icon LoadAppIcon()
    {
        try
        {
            // 트레이 아이콘은 EXE 내부 리소스에서 읽습니다.
            // 단일 파일 배포에서도 외부 Assets 폴더에 의존하지 않습니다.
            var asm = Assembly.GetExecutingAssembly();
            using var stream = asm.GetManifestResourceStream("HurogiCollector.Assets.byeollog_app.ico");
            if (stream is not null)
            {
                using var embedded = new Icon(stream);
                return (Icon)embedded.Clone();
            }

            // 윈도우/작업표시줄에 포함된 실행 파일 아이콘으로 폴백
            var exeIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            if (exeIcon is not null)
            {
                return (Icon)exeIcon.Clone();
            }

            // 개발 중 폴더 실행 시 마지막 폴백
            var iconPath = Path.Combine(AppContext.BaseDirectory, "Assets", "byeollog_app.ico");
            if (File.Exists(iconPath))
            {
                return new Icon(iconPath);
            }
        }
        catch
        {
            // 기본 아이콘으로 폴백
        }

        return (Icon)SystemIcons.Application.Clone();
    }

    private void SetupTray()
    {
        _trayMenu.Items.Clear();

        var openItem = new ToolStripMenuItem("별록 풍벽지 열기");
        openItem.Font = new Font(openItem.Font, FontStyle.Bold);
        openItem.Click += (_, _) => RestoreFromTray();

        var editorItem = new ToolStripMenuItem("풍벽지 배치 편집");
        editorItem.Click += (_, _) => QueueWallpaperEditorOpen();

        var statusItem = new ToolStripMenuItem("상태: 대기 중") { Enabled = false, Name = "trayStatus" };
        _vNextDevStatusItem = new ToolStripMenuItem("별록 계정: 연결 필요") { Enabled = false };
        _vNextAgentStatusItem = new ToolStripMenuItem("별록 풍벽지: 연결 대기") { Enabled = false };
        _obsStatusItem = new ToolStripMenuItem("OBS: 연결 설정 필요") { Enabled = false };
        _windowsCaptureStatusItem = new ToolStripMenuItem("Windows 마이크: 설정 필요") { Enabled = false };
        var exitItem = new ToolStripMenuItem("프로그램 종료");
        exitItem.Click += (_, _) => ExitFromTray();

        var preflightItem = new ToolStripMenuItem("방송 준비 사전진단 (읽기 전용)");
        preflightItem.Click += async (_, _) =>
        {
            preflightItem.Enabled = false;
            try { await ShowPreflightAsync(); }
            finally { preflightItem.Enabled = true; }
        };

        var diagnosticItem = new ToolStripMenuItem("사전진단 + 진단 ZIP 만들기");
        diagnosticItem.Click += async (_, _) =>
        {
            diagnosticItem.Enabled = false;
            try { await ExportDebugAsync(); }
            finally { diagnosticItem.Enabled = true; }
        };

        var reconnectVNextDevItem = new ToolStripMenuItem("별록 액션 연결 상태 확인");
        reconnectVNextDevItem.Click += async (_, _) => await ReconnectVNextDevelopmentAsync();

        var activityItem = new ToolStripMenuItem("자동화 활동 보기");
        activityItem.Click += (_, _) => QueueVNextAutomationSettingsOpen("activity");

        var disconnectVNextDevItem = new ToolStripMenuItem("별록 계정 연결 해제");
        disconnectVNextDevItem.Click += async (_, _) => await DisconnectVNextDevelopmentAsync();

        var e2eVNextAgentItem = new ToolStripMenuItem("뉴별록 DEV 이 PC 자동화 테스트");
        e2eVNextAgentItem.Click += async (_, _) =>
        {
            e2eVNextAgentItem.Enabled = false;
            try { await RunVNextLocalAgentE2ETestAsync(); }
            finally { e2eVNextAgentItem.Enabled = true; }
        };

        var obsSettingsItem = new ToolStripMenuItem("OBS 연결 설정");
        obsSettingsItem.Click += (_, _) => ShowObsSettings();

        var overlayMenu = new ToolStripMenuItem("별록 OBS 오버레이");
        var copyOverlayUrlItem = new ToolStripMenuItem("OBS 브라우저 소스 주소 복사");
        copyOverlayUrlItem.Enabled = _vNextLocalAgent is not null;
        copyOverlayUrlItem.Click += (_, _) =>
        {
            if (_vNextLocalAgent is null) return;
            try
            {
                Clipboard.SetText(_vNextLocalAgent.OverlayUrl);
                MessageBox.Show(
                    "OBS의 브라우저 소스 URL에 붙여넣으세요.\n\n" +
                    _vNextLocalAgent.OverlayUrl + "\n\n" +
                    "평소에는 투명하며 별록 이벤트가 실행될 때만 이미지가 표시됩니다.",
                    "별록 OBS 오버레이 주소",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "오버레이 주소를 복사하지 못했습니다.\n\n" + ex.Message,
                    "별록 OBS 오버레이",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
            }
        };
        var previewOverlayItem = new ToolStripMenuItem("마이크 꺼짐 이미지 3초 미리보기");
        previewOverlayItem.Enabled = _vNextLocalAgent is not null;
        previewOverlayItem.Click += async (_, _) =>
        {
            if (_vNextLocalAgent is null) return;
            previewOverlayItem.Enabled = false;
            try
            {
                await _vNextLocalAgent.PreviewOverlayAsync();
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "별록 오버레이 미리보기를 실행하지 못했습니다.\n\n" + ex.Message,
                    "별록 OBS 오버레이",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
            }
            finally
            {
                previewOverlayItem.Enabled = true;
            }
        };
        var syncOverlayAssetsItem = new ToolStripMenuItem("오버레이 이미지 확인");
        syncOverlayAssetsItem.Enabled = _vNextLocalAgent is not null;
        syncOverlayAssetsItem.Click += async (_, _) =>
        {
            if (_vNextLocalAgent is null) return;
            syncOverlayAssetsItem.Enabled = false;
            try
            {
                var result = await _vNextLocalAgent.SyncOverlayAssetsNowAsync();
                MessageBox.Show(
                    "오버레이 이미지 확인이 완료됐습니다.\n\n" +
                    $"사용 가능: {result.Available}개\n" +
                    $"새로 받음: {result.Downloaded}개\n" +
                    $"검증 캐시 재사용: {result.Reused}개\n" +
                    $"필수 미준비: {result.RequiredUnavailable}개",
                    "별록 오버레이 이미지",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "오버레이 이미지를 확인하지 못했습니다.\n\n" + ex.Message +
                    "\n\n마지막 검증본은 그대로 보존됩니다.",
                    "별록 오버레이 이미지",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
            }
            finally
            {
                syncOverlayAssetsItem.Enabled = true;
                UpdateTrayStatus();
            }
        };
        overlayMenu.DropDownItems.Add(copyOverlayUrlItem);
        overlayMenu.DropDownItems.Add(previewOverlayItem);
        overlayMenu.DropDownItems.Add(syncOverlayAssetsItem);

        var obsTestItem = new ToolStripMenuItem("OBS 연결 테스트");
        obsTestItem.Click += async (_, _) =>
        {
            obsTestItem.Enabled = false;
            try { await RunObsConnectionTestAsync(); }
            finally { obsTestItem.Enabled = true; }
        };

        var obsMuteCycleItem = new ToolStripMenuItem("OBS 실제 음소거·복구 테스트 (DEV)");
        obsMuteCycleItem.Click += async (_, _) =>
        {
            obsMuteCycleItem.Enabled = false;
            try { await RunObsMuteCycleTestAsync(); }
            finally { obsMuteCycleItem.Enabled = true; }
        };

        var e2eObsItem = new ToolStripMenuItem("vNext DEV OBS 상태 유지 테스트");
        e2eObsItem.Click += async (_, _) =>
        {
            e2eObsItem.Enabled = false;
            try { await RunVNextObsE2ETestAsync(); }
            finally { e2eObsItem.Enabled = true; }
        };

        var obsTimedMuteItem = new ToolStripMenuItem("OBS 3초 시간제 음소거 (로컬 DEV)");
        obsTimedMuteItem.Click += async (_, _) =>
        {
            obsTimedMuteItem.Enabled = false;
            try { await RunLocalTimedMuteTestAsync(useWindowsCapture: false); }
            finally { obsTimedMuteItem.Enabled = true; }
        };

        var windowsSettingsItem = new ToolStripMenuItem("Windows 마이크 설정");
        windowsSettingsItem.Click += (_, _) => ShowWindowsCaptureSettings();

        var windowsProbeItem = new ToolStripMenuItem("Windows 마이크 상태 확인 (읽기 전용)");
        windowsProbeItem.Click += async (_, _) =>
        {
            windowsProbeItem.Enabled = false;
            try { await RunWindowsCaptureProbeAsync(); }
            finally { windowsProbeItem.Enabled = true; }
        };

        var windowsTimedMuteItem = new ToolStripMenuItem("Windows 마이크 3초 시간제 음소거 (로컬 DEV)");
        windowsTimedMuteItem.Click += async (_, _) =>
        {
            windowsTimedMuteItem.Enabled = false;
            try { await RunLocalTimedMuteTestAsync(useWindowsCapture: true); }
            finally { windowsTimedMuteItem.Enabled = true; }
        };

        var e2eObsTimedMuteItem = new ToolStripMenuItem("vNext DEV OBS 3초 음소거 E2E");
        e2eObsTimedMuteItem.Click += async (_, _) =>
        {
            e2eObsTimedMuteItem.Enabled = false;
            try { await RunVNextTimedMuteE2ETestAsync(useWindowsCapture: false); }
            finally { e2eObsTimedMuteItem.Enabled = true; }
        };

        var e2eWindowsTimedMuteItem = new ToolStripMenuItem("vNext DEV Windows 마이크 3초 음소거 E2E");
        e2eWindowsTimedMuteItem.Click += async (_, _) =>
        {
            e2eWindowsTimedMuteItem.Enabled = false;
            try { await RunVNextTimedMuteE2ETestAsync(useWindowsCapture: true); }
            finally { e2eWindowsTimedMuteItem.Enabled = true; }
        };

        _trayMenu.Items.Add(openItem);
        _trayMenu.Items.Add(editorItem);
        _trayMenu.Items.Add(statusItem);
        _trayMenu.Items.Add(_vNextDevStatusItem);
        _trayMenu.Items.Add(_vNextAgentStatusItem);
        if (CoreProductScope.LocalActionExecutionEnabled)
        {
            _trayMenu.Items.Add(_obsStatusItem);
            _trayMenu.Items.Add(_windowsCaptureStatusItem);
        }
        _trayMenu.Items.Add(new ToolStripSeparator());
        _trayMenu.Items.Add(disconnectVNextDevItem);
        if (BuildInfo.ShowInternalTesterTools)
        {
            _trayMenu.Items.Add(new ToolStripSeparator());
            if (CoreProductScope.LocalActionExecutionEnabled)
            {
                _trayMenu.Items.Add(reconnectVNextDevItem);
                _trayMenu.Items.Add(activityItem);
                _trayMenu.Items.Add(e2eVNextAgentItem);
                _trayMenu.Items.Add(overlayMenu);
                _trayMenu.Items.Add(obsSettingsItem);
                _trayMenu.Items.Add(obsTestItem);
                _trayMenu.Items.Add(obsMuteCycleItem);
                _trayMenu.Items.Add(e2eObsItem);
                _trayMenu.Items.Add(obsTimedMuteItem);
                _trayMenu.Items.Add(e2eObsTimedMuteItem);
                _trayMenu.Items.Add(windowsSettingsItem);
                _trayMenu.Items.Add(windowsProbeItem);
                _trayMenu.Items.Add(windowsTimedMuteItem);
                _trayMenu.Items.Add(e2eWindowsTimedMuteItem);
                _trayMenu.Items.Add(preflightItem);
            }
            _trayMenu.Items.Add(diagnosticItem);
        }
        _trayMenu.Items.Add(new ToolStripSeparator());
        _trayMenu.Items.Add(exitItem);

        _trayIcon.Icon = _appIcon ?? SystemIcons.Application;
        _trayIcon.Text = "별록 풍벽지";
        _trayIcon.ContextMenuStrip = _trayMenu;
        _trayIcon.Visible = true;
        _trayIcon.DoubleClick += (_, _) => RestoreFromTray();
        _trayIcon.BalloonTipClicked += (_, _) =>
        {
            if (_activityBalloonPending)
            {
                _activityBalloonPending = false;
                QueueVNextAutomationSettingsOpen("activity");
                return;
            }
            RestoreFromTray();
        };
    }

    private void ActivityMonitor_NotificationReady(object? sender, VNextActivityNotification notification)
    {
        if (notification.Total == 0 || IsDisposed || Disposing || !IsHandleCreated) return;
        try
        {
            BeginInvoke(new Action(() =>
            {
                if (!_vNextDevClient.IsSignedIn
                    || _vNextDevClient.SessionEpoch != notification.SessionEpoch
                    || IsDisposed
                    || Disposing)
                    return;
                _activityBalloonPending = true;
                _trayIcon.BalloonTipTitle = "뉴별록 자동화 활동";
                _trayIcon.BalloonTipText = notification.Summary();
                _trayIcon.BalloonTipIcon = notification.Blocked + notification.NeedsReview > 0
                    ? ToolTipIcon.Warning
                    : ToolTipIcon.Info;
                _trayIcon.ShowBalloonTip(5000);
            }));
        }
        catch (ObjectDisposedException) { }
        catch (InvalidOperationException) { }
    }

    private void VNextDevClient_SessionChanged(object? sender, EventArgs e)
    {
        if (IsDisposed || Disposing || !IsHandleCreated) return;
        try
        {
            BeginInvoke(new Action(() =>
            {
                if (_vNextDevClient.IsSignedIn)
                {
                    _vNextLocalAgent?.Start();
                    _vNextLocalAgent?.Wake();
                    _activityMonitor.Wake();
                }
                UpdateTrayStatus();
                NotifyMainUi();
            }));
        }
        catch (ObjectDisposedException) { }
        catch (InvalidOperationException) { }
    }

    private void VNextDevClient_SessionRecoveryChanged(object? sender, VNextSessionRecoveryEventArgs e)
    {
        var message = e.State switch
        {
            "recovering" => "별록 액션 인증 응답 확인 · 저장 세션 자동 갱신 시작",
            "recovered" => "별록 액션 세션 자동 복구 완료 · 중단된 요청 1회 재전송",
            "retrying" => "별록 액션 세션 자동 복구 일시 대기 · 기존 수집은 계속 유지",
            "attention" => "별록 액션 세션 재로그인 필요 · 기존 수집은 계속 유지",
            _ => "별록 액션 세션 상태 변경"
        };
        _storage.Log(message + " · code=" + e.Code);
        if (IsDisposed || Disposing || !IsHandleCreated) return;
        try
        {
            BeginInvoke(new Action(() =>
            {
                UpdateTrayStatus();
                NotifyMainUi();
            }));
        }
        catch (ObjectDisposedException) { }
        catch (InvalidOperationException) { }
    }

    private void MainForm_FormClosing(object? sender, FormClosingEventArgs e)
    {
        // Windows 종료/로그오프 등 시스템 종료는 막지 않습니다.
        if (_allowExit || e.CloseReason != CloseReason.UserClosing) return;

        e.Cancel = true;
        HideToTray();
    }

    private void HideToTray()
    {
        Hide();
        ShowInTaskbar = false;

        UpdateTrayStatus();
        if (!_trayHintShown)
        {
            _trayHintShown = true;
            _trayIcon.BalloonTipTitle = "별록 에이전트";
            _trayIcon.BalloonTipText = "프로그램은 종료되지 않고 트레이에서 계속 실행됩니다.\n종료하려면 트레이 아이콘을 우클릭하세요.";
            _trayIcon.BalloonTipIcon = ToolTipIcon.Info;
            _trayIcon.ShowBalloonTip(2500);
        }
    }

    public void RestoreFromExternalLaunch()
    {
        // 사용자가 아이콘/EXE를 다시 실행하면 새 프로그램을 띄우지 않고
        // 이미 실행 중인 에이전트 창을 복원합니다.
        RestoreFromTray();
        WindowState = FormWindowState.Normal;
        Activate();
        BringToFront();
    }

    private void RestoreFromTray()
    {
        EnsureMainWindowVisible();
    }

    private void EnsureMainWindowVisible()
    {
        if (IsDisposed || Disposing) return;
        ShowInTaskbar = true;
        if (!Visible) Show();
        WindowState = FormWindowState.Normal;
        _adaptiveWindow.Apply(center: false);
        Activate();
        BringToFront();

        // 로그인 창이 닫히는 순간 Windows가 포커스를 다른 창으로 넘기는 경우를 방지합니다.
        TopMost = true;
        TopMost = false;
        Focus();
    }

    private void ExitFromMain()
    {
        if (_timedMuteTestInProgress)
        {
            MessageBox.Show(
                "시간제 음소거의 원래 상태 복구를 확인하고 있습니다. 완료 창이 표시될 때까지 별록 에이전트를 종료하지 마세요.",
                "마이크 복구 진행 중",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return;
        }
        if (_obsMuteCycleInProgress)
        {
            MessageBox.Show(
                "OBS 음소거 복구 확인이 진행 중입니다. 테스트 완료 창이 표시될 때까지 별록 에이전트를 종료하지 마세요.",
                "OBS 복구 진행 중",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return;
        }

        var message = (_vNextLocalAgent?.Status.Running == true)
            ? "프로그램을 종료하면 이 PC의 풍벽지 표시가 멈춥니다.\n\n종료하시겠습니까?"
            : "별록 에이전트를 종료하시겠습니까?";

        var answer = MessageBox.Show(
            message,
            "별록 에이전트 종료",
            MessageBoxButtons.YesNo,
            (_vNextLocalAgent?.Status.Running == true) ? MessageBoxIcon.Warning : MessageBoxIcon.Question,
            MessageBoxDefaultButton.Button2);
        if (answer != DialogResult.Yes) return;

        _allowExit = true;
        _trayIcon.Visible = false;
        _trayIcon.Dispose();
        _appIcon?.Dispose();
        _trayMenu.Dispose();
        Close();
    }

    private void ExitFromTray()
    {
        if (_timedMuteTestInProgress)
        {
            MessageBox.Show(
                "시간제 음소거의 원래 상태 복구를 확인하고 있습니다. 완료 창이 표시될 때까지 별록 에이전트를 종료하지 마세요.",
                "마이크 복구 진행 중",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return;
        }
        if (_obsMuteCycleInProgress)
        {
            MessageBox.Show(
                "OBS 음소거 복구 확인이 진행 중입니다. 테스트 완료 창이 표시될 때까지 별록 에이전트를 종료하지 마세요.",
                "OBS 복구 진행 중",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return;
        }

        if (_vNextLocalAgent?.Status.Running == true)
        {
            var answer = MessageBox.Show(
                "프로그램을 종료하면 이 PC의 풍벽지 표시가 멈춥니다.\n\n정말 종료할까요?",
                "별록 에이전트 종료",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Warning,
                MessageBoxDefaultButton.Button2);
            if (answer != DialogResult.Yes) return;
        }

        _allowExit = true;
        _trayIcon.Visible = false;
        _trayIcon.Dispose();
        _appIcon?.Dispose();
        _trayMenu.Dispose();
        Close();
    }

    private void UpdateTrayStatus()
    {
        var text = _vNextLocalAgent?.Status.Connected == true
            ? "상태: 풍벽지 연결됨"
            : "상태: 연결 대기";

        if (_trayMenu.Items["trayStatus"] is ToolStripMenuItem statusItem)
            statusItem.Text = text;

        if (_vNextDevStatusItem is not null)
        {
            var connection = _vNextDevClient.SessionRecoveryState switch
            {
                "recovering" => "자동 복구 중",
                "retrying" => "재연결 대기",
                "attention" => "재로그인 필요",
                _ => _vNextDevClient.IsSignedIn ? "연결됨" : "연결 필요"
            };
            _vNextDevStatusItem.Text = $"별록 계정: {connection}";
        }

        if (_vNextAgentStatusItem is not null)
        {
            if (_vNextLocalAgent is null)
            {
                _vNextAgentStatusItem.Text = "별록 풍벽지: 사용 불가";
                _vNextAgentStatusItem.ToolTipText = _vNextAgentStartupError;
            }
            else if (!_vNextDevClient.IsSignedIn)
            {
                _vNextAgentStatusItem.Text = "별록 풍벽지: 계정 연결 필요";
                _vNextAgentStatusItem.ToolTipText = "별록 계정을 연결하면 풍벽지가 자동으로 시작됩니다.";
            }
            else
            {
                var agent = _vNextLocalAgent.Status;
                _vNextAgentStatusItem.Text = CoreProductScope.LocalActionExecutionEnabled
                    ? $"별록 액션: {agent.State} · ACK {agent.PendingAcks:N0} · 확인 {agent.Uncertain:N0}"
                    : $"별록 풍벽지: {agent.State}";
                var overlay = _vNextLocalAgent.OverlayAvailable
                    ? $"오버레이 준비됨 · {_vNextLocalAgent.OverlayUrl}"
                    : "오버레이 시작 필요";
                var assets = agent.OverlayAssetsReady
                    ? $"오버레이 이미지 준비됨 · {agent.ManagedOverlayAssets:N0}개"
                    : "오버레이 이미지 확인 필요";
                overlay += Environment.NewLine + assets;
                _vNextAgentStatusItem.ToolTipText = string.IsNullOrWhiteSpace(agent.LastError)
                    ? overlay
                    : agent.LastError + Environment.NewLine + overlay;
            }
        }

        if (_obsStatusItem is not null)
        {
            var obs = _storage.LoadObsSettings();
            _obsStatusItem.Text = obs.Enabled && !string.IsNullOrWhiteSpace(obs.MicrophoneInputName)
                ? $"OBS: 설정됨 · localhost:{obs.Port}"
                : "OBS: 연결 설정 필요";
        }

        if (_windowsCaptureStatusItem is not null)
        {
            var windows = _storage.LoadWindowsCaptureSettings();
            _windowsCaptureStatusItem.Text = windows.Enabled && !string.IsNullOrWhiteSpace(windows.EndpointId)
                ? $"Windows 마이크: 설정됨 · {ShortDisplay(windows.EndpointName, 24)}"
                : "Windows 마이크: 설정 필요";
        }

        _trayIcon.Text = text.Length <= 63 ? $"별록 · {text.Replace("상태: ", "")}" : "별록 에이전트";
    }

    private void VNextLocalAgent_StatusChanged(object? sender, EventArgs e)
    {
        if (IsDisposed || Disposing || !IsHandleCreated) return;
        try
        {
            BeginInvoke(new Action(() =>
            {
                UpdateTrayStatus();
                NotifyMainUi();
            }));
        }
        catch { }
    }

    private void ShowObsSettings()
    {
        if (_timedMuteTestInProgress)
        {
            MessageBox.Show(
                "시간제 음소거가 진행 중입니다. 원래 상태 복구가 끝난 뒤 설정을 변경해주세요.",
                "마이크 복구 진행 중",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return;
        }
        if (_obsMuteCycleInProgress)
        {
            MessageBox.Show(
                "OBS 실제 음소거 복구가 진행 중입니다. 완료 창이 표시된 뒤 설정을 변경해주세요.",
                "OBS 복구 진행 중",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return;
        }
        using var form = new ObsSettingsForm(_storage);
        if (form.ShowDialog(this) != DialogResult.OK) return;
        _storage.Log("OBS 로컬 연결 설정 변경");
        UpdateTrayStatus();
    }

    private async Task RunObsConnectionTestAsync()
    {
        if (_obsTestInProgress) return;
        if (_timedMuteTestInProgress)
        {
            MessageBox.Show(
                "시간제 음소거가 진행 중입니다. 완료된 뒤 OBS 연결 테스트를 실행해주세요.",
                "방송 프로그램 테스트 진행 중",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return;
        }
        if (_obsMuteCycleInProgress)
        {
            MessageBox.Show(
                "OBS 실제 음소거 복구가 진행 중입니다. 완료 창이 표시된 뒤 연결 테스트를 실행해주세요.",
                "OBS 복구 진행 중",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return;
        }
        var settings = _storage.LoadObsSettings();
        if (!settings.Enabled || string.IsNullOrWhiteSpace(settings.MicrophoneInputName))
        {
            MessageBox.Show(
                "먼저 트레이 메뉴의 ‘OBS 연결 설정’에서 포트·마이크 입력·비밀번호를 저장해주세요.",
                "OBS 연결 테스트",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return;
        }

        _obsTestInProgress = true;
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(6));
            var probe = await new ObsActionAdapter(_storage).ProbeAsync(timeout.Token);
            _storage.Log($"OBS 연결 테스트 성공 · obs={probe.ObsStudioVersion} websocket={probe.ObsWebSocketVersion}");
            MessageBox.Show(
                "OBS 연결 테스트에 성공했습니다.\n\n" +
                $"OBS Studio: {probe.ObsStudioVersion}\n" +
                $"OBS WebSocket: {probe.ObsWebSocketVersion}\n" +
                $"마이크 음소거 상태: {(probe.InputMuted ? "켜짐" : "꺼짐")}\n\n" +
                "OBS 상태는 변경하지 않았습니다.",
                "OBS 연결 테스트",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }
        catch (OperationCanceledException)
        {
            MessageBox.Show(
                "OBS 연결 시간이 초과됐습니다. OBS와 WebSocket 서버가 실행 중인지 확인해주세요.",
                "OBS 연결 테스트",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
        catch (Exception ex)
        {
            _storage.Log("OBS 연결 테스트 실패 · " + ex.GetType().Name);
            var message = ex switch
            {
                ObsAuthenticationException => "OBS WebSocket 비밀번호가 맞지 않습니다.",
                ObsRequestException request => $"OBS가 요청을 거부했습니다. (code {request.Code})",
                System.Net.WebSockets.WebSocketException => "OBS에 연결할 수 없습니다. OBS와 WebSocket 서버를 확인해주세요.",
                InvalidDataException => "OBS WebSocket 응답 형식이 올바르지 않습니다.",
                _ => "OBS 연결 테스트 중 오류가 발생했습니다."
            };
            MessageBox.Show(message, "OBS 연결 테스트", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            _obsTestInProgress = false;
            UpdateTrayStatus();
        }
    }

    private async Task RunObsMuteCycleTestAsync()
    {
        if (_obsMuteCycleInProgress) return;
        if (_timedMuteTestInProgress)
        {
            MessageBox.Show(
                "시간제 음소거가 진행 중입니다. 완료된 뒤 OBS 테스트를 실행해주세요.",
                "방송 프로그램 테스트 진행 중",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return;
        }
        if (_vNextObsE2EInProgress)
        {
            MessageBox.Show(
                "OBS 상태 유지 테스트가 진행 중입니다. 완료된 뒤 실제 음소거·복구 테스트를 실행해주세요.",
                "OBS 테스트 진행 중",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return;
        }
        var settings = _storage.LoadObsSettings();
        if (!settings.Enabled || string.IsNullOrWhiteSpace(settings.MicrophoneInputName))
        {
            MessageBox.Show(
                "먼저 ‘OBS 연결 설정’을 저장하고 ‘OBS 연결 테스트’를 통과해주세요.",
                "OBS 실제 음소거·복구 테스트",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return;
        }

        ObsConnectionProbeResult probe;
        try
        {
            using var probeTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(6));
            probe = await new ObsActionAdapter(_storage).ProbeAsync(probeTimeout.Token);
        }
        catch (Exception ex)
        {
            _storage.Log("OBS 실제 변경 사전 확인 실패 · " + ex.GetType().Name);
            MessageBox.Show(
                "OBS 상태를 확인하지 못했습니다. 먼저 ‘OBS 연결 테스트’를 다시 실행해주세요.",
                "OBS 실제 음소거·복구 테스트",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return;
        }

        if (probe.InputMuted)
        {
            MessageBox.Show(
                "현재 마이크가 이미 음소거 상태입니다.\n\n" +
                "이 테스트는 숨겨진 음성을 자동으로 노출하지 않도록, 음소거 해제 상태에서만 실행됩니다. " +
                "OBS에서 직접 음소거를 해제한 뒤 다시 시도해주세요.\n\nOBS 상태는 변경하지 않았습니다.",
                "OBS 실제 음소거·복구 테스트",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return;
        }

        var answer = MessageBox.Show(
            "마이크를 실제로 약 1초간 음소거한 뒤 원래 상태(음소거 해제)로 복구합니다.\n\n" +
            "• 방송·녹화 중에는 약 1초간 음성이 끊깁니다.\n" +
            "• 테스트 중 OBS와 별록 에이전트를 종료하지 마세요.\n" +
            "• 서버와 DEV DB에는 이벤트를 전송하지 않습니다.\n\n" +
            "지금 실제 변경·복구 테스트를 실행할까요?",
            "OBS 실제 음소거·복구 테스트",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning,
            MessageBoxDefaultButton.Button2);
        if (answer != DialogResult.Yes) return;

        // 사전 조회를 기다리는 동안 상태 유지 E2E가 시작됐을 수 있으므로 변경 직전에 다시 확인합니다.
        if (_vNextObsE2EInProgress)
        {
            MessageBox.Show(
                "다른 방송 프로그램 테스트가 먼저 시작됐습니다. 완료된 뒤 다시 실행해주세요.",
                "방송 프로그램 테스트 진행 중",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return;
        }

        _obsMuteCycleInProgress = true;
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
            var result = await new ObsActionAdapter(_storage).RunLocalMuteCycleAsync(timeout.Token);
            var succeeded =
                !result.InitialMuted
                && result.MutedVerified
                && result.RestoredUnmuted;
            if (!succeeded)
                throw new InvalidDataException("OBS 실제 음소거·복구 결과가 예상과 다릅니다.");

            _storage.Log($"OBS 실제 음소거·복구 테스트 성공 · obs={result.ObsStudioVersion} websocket={result.ObsWebSocketVersion}");
            MessageBox.Show(
                "OBS 실제 음소거·복구 테스트에 성공했습니다.\n\n" +
                "✓ 시작 상태: 음소거 꺼짐\n" +
                "✓ 실제 변경: 음소거 켜짐 확인\n" +
                "✓ 최종 복구: 음소거 꺼짐 확인\n" +
                "✓ 테스트 이벤트·서버 작업 생성 없음\n\n" +
                $"OBS Studio: {result.ObsStudioVersion}\n" +
                $"OBS WebSocket: {result.ObsWebSocketVersion}",
                "OBS 실제 음소거·복구 테스트",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }
        catch (ObsMuteCycleRestoreFailedException)
        {
            _storage.Log("OBS 실제 음소거·복구 테스트 실패 · restore=unverified");
            MessageBox.Show(
                "마이크의 원래 상태 복구를 확인하지 못했습니다.\n\n" +
                "지금 바로 OBS 오디오 믹서에서 마이크 음소거 버튼을 확인하고, 켜져 있으면 직접 해제해주세요. " +
                "상태를 확인하기 전에는 방송·녹화를 재개하지 마세요.",
                "OBS 복구 확인 필요",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
        catch (ObsMuteCycleRequiresUnmutedException)
        {
            MessageBox.Show(
                "테스트 직전 마이크가 음소거 상태로 바뀌어 실행을 중단했습니다.\n\nOBS 상태는 자동으로 변경하지 않았습니다.",
                "OBS 실제 음소거·복구 테스트",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
        catch (ObsMuteCycleOperationException)
        {
            _storage.Log("OBS 실제 음소거·복구 테스트 실패 · restore=verified");
            MessageBox.Show(
                "실제 음소거 변경 검증은 완료되지 않았지만, 최종 음소거 해제 상태는 확인했습니다.\n\nOBS 연결을 확인한 뒤 다시 시도해주세요.",
                "OBS 실제 음소거·복구 테스트",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
        catch (ObsMuteCycleCanceledAfterRestoreException)
        {
            _storage.Log("OBS 실제 음소거·복구 테스트 시간 초과 · restore=verified");
            MessageBox.Show(
                "테스트 시간이 초과됐지만 최종 음소거 해제 상태는 확인했습니다.\n\nOBS 연결을 확인한 뒤 다시 시도해주세요.",
                "OBS 실제 음소거·복구 테스트",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
        catch (OperationCanceledException)
        {
            _storage.Log("OBS 실제 음소거·복구 테스트 시간 초과 · mutation=not-started");
            MessageBox.Show(
                "실제 음소거 변경을 시작하기 전 상태 확인 시간이 초과됐습니다.\n\nOBS 상태는 이 테스트가 변경하지 않았습니다.",
                "OBS 실제 음소거·복구 테스트",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
        catch (Exception ex)
        {
            _storage.Log("OBS 실제 음소거·복구 테스트 실패 · " + ex.GetType().Name);
            MessageBox.Show(
                "OBS 실제 음소거·복구 테스트 중 오류가 발생했습니다. OBS 오디오 믹서의 현재 상태를 직접 확인해주세요.",
                "OBS 실제 음소거·복구 테스트",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
        finally
        {
            _obsMuteCycleInProgress = false;
            UpdateTrayStatus();
        }
    }

    private void ShowWindowsCaptureSettings()
    {
        if (_timedMuteTestInProgress || _obsMuteCycleInProgress || _vNextObsE2EInProgress)
        {
            MessageBox.Show(
                "방송 마이크 테스트가 진행 중입니다. 원래 상태 복구가 끝난 뒤 설정을 변경해주세요.",
                "마이크 복구 진행 중",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return;
        }
        using var form = new WindowsCaptureSettingsForm(_storage);
        if (form.ShowDialog(this) != DialogResult.OK) return;
        _storage.Log("Windows 캡처 장치 로컬 설정 변경");
        _vNextLocalAgent?.Wake();
        UpdateTrayStatus();
    }

    private async Task RunWindowsCaptureProbeAsync()
    {
        var settings = _storage.LoadWindowsCaptureSettings();
        if (!settings.Enabled || string.IsNullOrWhiteSpace(settings.EndpointId))
        {
            MessageBox.Show(
                "먼저 ‘Windows 마이크 설정’에서 사용할 캡처 장치를 선택하고 기능을 활성화해주세요.",
                "Windows 마이크 상태 확인",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return;
        }

        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            var muted = await _timedMuteActions.ProbeWindowsMutedAsync(timeout.Token);
            _storage.Log($"Windows 마이크 읽기 전용 상태 확인 성공 · muted={muted}");
            MessageBox.Show(
                $"Windows 마이크 상태를 확인했습니다.\n\n장치: {settings.EndpointName}\n현재 음소거: {(muted ? "켜짐" : "꺼짐")}\n\n상태는 변경하지 않았습니다.",
                "Windows 마이크 상태 확인 (읽기 전용)",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }
        catch (OperationCanceledException)
        {
            MessageBox.Show("Windows 마이크 상태 확인 시간이 초과됐습니다.", "Windows 마이크 상태 확인", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        catch (Exception ex)
        {
            _storage.Log("Windows 마이크 읽기 전용 상태 확인 실패 · " + ex.GetType().Name);
            MessageBox.Show(
                "Windows 마이크 상태를 확인하지 못했습니다. 장치 연결과 설정을 다시 확인해주세요.",
                "Windows 마이크 상태 확인",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }

    private async Task RunLocalTimedMuteTestAsync(bool useWindowsCapture)
    {
        if (_timedMuteTestInProgress) return;
        if (_obsTestInProgress || _obsMuteCycleInProgress || _vNextObsE2EInProgress)
        {
            MessageBox.Show(
                "다른 방송 마이크 테스트가 진행 중입니다. 완료된 뒤 다시 실행해주세요.",
                "방송 프로그램 테스트 진행 중",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return;
        }

        var displayTarget = useWindowsCapture ? "Windows 캡처 장치" : "OBS 마이크 입력";
        bool initialMuted;
        try
        {
            using var probeTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            initialMuted = useWindowsCapture
                ? await _timedMuteActions.ProbeWindowsMutedAsync(probeTimeout.Token)
                : (await new ObsActionAdapter(_storage).ProbeAsync(probeTimeout.Token)).InputMuted;
        }
        catch (Exception ex)
        {
            _storage.Log($"{displayTarget} 시간제 음소거 사전 확인 실패 · {ex.GetType().Name}");
            MessageBox.Show(
                $"{displayTarget} 상태를 읽지 못했습니다. 먼저 연결 설정과 읽기 전용 상태 확인을 통과해주세요.",
                "3초 시간제 음소거 (로컬 DEV)",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return;
        }

        var answer = MessageBox.Show(
            $"{displayTarget}을 실제로 3초간 음소거하고 시작 당시 상태로 복구합니다.\n\n" +
            $"• 시작 상태: {(initialMuted ? "이미 음소거됨 — 노출하지 않고 음소거 상태 유지" : "음소거 해제됨 — 3초 음소거 후 해제 복구")}\n" +
            "• Windows 방식은 이 장치를 사용하는 모든 앱에 적용됩니다.\n" +
            "• 작업은 직렬화되며 겹친 요청은 앞 작업 뒤에 이어집니다.\n" +
            "• 복구 확인 전에는 성공으로 처리하지 않습니다.\n" +
            "• 이 로컬 테스트는 서버 이벤트나 ACK를 만들지 않습니다.\n\n" +
            "실제 방송이 아닌 상태에서 실행할까요?",
            "3초 시간제 음소거 (로컬 DEV)",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning,
            MessageBoxDefaultButton.Button2);
        if (answer != DialogResult.Yes) return;

        _timedMuteTestInProgress = true;
        UpdateTrayStatus();
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(25));
            var result = useWindowsCapture
                ? await _timedMuteActions.RunLocalWindowsTestAsync(3000, timeout.Token)
                : await _timedMuteActions.RunLocalObsTestAsync(3000, timeout.Token);
            if (!result.MutedVerified || !result.RestoredVerified || result.InitialMuted != initialMuted)
                throw new InvalidDataException("시간제 음소거 검증 결과가 예상과 다릅니다.");

            _storage.Log($"{displayTarget} 로컬 시간제 음소거 성공 · duration=3000 initialMuted={result.InitialMuted} restored=true");
            MessageBox.Show(
                $"{displayTarget} 3초 시간제 음소거 테스트에 성공했습니다.\n\n" +
                "✓ 시작 상태 저장\n✓ 음소거 상태 확인\n✓ 3초 유지\n✓ 시작 당시 상태로 복구 확인\n✓ 서버 이벤트·ACK 생성 없음",
                "3초 시간제 음소거 (로컬 DEV)",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }
        catch (TimedMuteRestoreFailedException)
        {
            _storage.Log($"{displayTarget} 로컬 시간제 음소거 실패 · restore=unverified journal=preserved");
            MessageBox.Show(
                $"{displayTarget}의 원래 상태 복구를 확인하지 못했습니다.\n\n지금 Windows 또는 OBS에서 마이크 상태를 직접 확인하세요. 복구 저널은 남아 있어 별록 에이전트가 다음 연결 전에 다시 복구를 시도합니다.",
                "마이크 상태 직접 확인 필요",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
        catch (TimedMuteCanceledAfterRestoreException)
        {
            MessageBox.Show(
                "테스트 시간이 초과됐지만 시작 당시 마이크 상태로 복구된 것은 확인했습니다.",
                "3초 시간제 음소거 (로컬 DEV)",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
        catch (TimedMuteOperationException)
        {
            MessageBox.Show(
                "음소거 과정 검증은 완료되지 않았지만 시작 당시 마이크 상태로 복구된 것은 확인했습니다. 설정을 확인한 뒤 다시 시도해주세요.",
                "3초 시간제 음소거 (로컬 DEV)",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
        catch (Exception ex)
        {
            _storage.Log($"{displayTarget} 로컬 시간제 음소거 실패 · {ex.GetType().Name}");
            MessageBox.Show(
                $"{displayTarget} 시간제 음소거 테스트 중 오류가 발생했습니다. 현재 마이크 상태를 직접 확인해주세요.",
                "3초 시간제 음소거 (로컬 DEV)",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
        finally
        {
            _timedMuteTestInProgress = false;
            _vNextLocalAgent?.Wake();
            UpdateTrayStatus();
        }
    }

    private PictureBox CreateByeollogBrandMark()
    {
        var box = new PictureBox
        {
            Width = 116,
            Height = 58,
            SizeMode = PictureBoxSizeMode.Zoom,
            Margin = new Padding(0, 0, 14, 0),
            BackColor = Color.Transparent,
        };
        try
        {
            var asm = typeof(MainForm).Assembly;
            using var stream = asm.GetManifestResourceStream("HurogiCollector.Assets.byeollog_symbol.png");
            if (stream != null)
            {
                using var temp = Image.FromStream(stream);
                box.Image = new Bitmap(temp);
            }
        }
        catch { }
        return box;
    }

    private void BuildUi()
    {
        AutoScaleMode = AutoScaleMode.None;
        var shellBackground = _darkMode
            ? Color.FromArgb(7, 18, 38)
            : Color.FromArgb(248, 250, 252);
        BackColor = shellBackground;

        _ui.Dock = DockStyle.Fill;
        _ui.DefaultBackgroundColor = shellBackground;
        _ui.Visible = true;
        Controls.Add(_ui);
        _ui.BringToFront();
    }

    private async Task InitUiAsync()
    {
        try
        {
            await PrepareForDisplayAsync();
        }
        catch (Exception ex)
        {
            _storage.Log("Collector UI 초기화 실패: " + ex);
            MessageBox.Show(
                "에이전트 화면을 시작하지 못했습니다.\n\n" + ex.Message,
                "별록 에이전트",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }

    internal Task PrepareForDisplayAsync()
    {
        CreateControl();
        return _mainUiInitializationTask ??= InitializeMainUiCoreAsync();
    }

    internal async Task RefreshPreparedMainStateAsync()
    {
        await PrepareForDisplayAsync();
        if (_uiReady) await PushMainStateAsync();
    }

    private async Task InitializeMainUiCoreAsync()
    {
        var environment = await GetMainUiWebViewEnvironmentAsync();
        _mainUiWebViewEnvironment = environment;
        await _ui.EnsureCoreWebView2Async(environment);
        _ui.CoreWebView2.Settings.AreDevToolsEnabled = false;
        _ui.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
        _ui.CoreWebView2.Settings.IsZoomControlEnabled = false;
        _ui.CoreWebView2.NavigationStarting += UiNavigationStarting;
        _ui.CoreWebView2.FrameNavigationStarting += UiFrameNavigationStarting;
        _ui.CoreWebView2.NewWindowRequested += UiNewWindowRequested;
        _ui.CoreWebView2.PermissionRequested += CoreWebView2_PermissionRequested;
        _ui.CoreWebView2.DownloadStarting += CoreWebView2_DownloadStarting;
        _ui.CoreWebView2.WebMessageReceived += async (_, e) => await HandleUiMessageAsync(e);

        var uiRoot = UiAssetStore.Prepare();
        _ui.CoreWebView2.SetVirtualHostNameToFolderMapping(
            "byeollog.local",
            uiRoot,
            CoreWebView2HostResourceAccessKind.DenyCors);

        var navigationReady = new TaskCompletionSource<string?>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        _ui.NavigationCompleted += async (_, e) =>
        {
            if (!e.IsSuccess)
            {
                navigationReady.TrySetResult(
                    "별록 메인 화면을 불러오지 못했습니다: " + e.WebErrorStatus);
                return;
            }

            try
            {
                _uiReady = true;
                await PushMainStateAsync();
                navigationReady.TrySetResult(null);
            }
            catch (Exception ex)
            {
                navigationReady.TrySetResult(ex.Message);
            }
        };
        _ui.Source = new Uri($"https://byeollog.local/byeollog_ui.html?mode=main&theme={(_darkMode ? "dark" : "light")}");
        // 실제 메인 컨트롤과 HTML, 최초 상태 주입까지 로그인 전에 끝냅니다.
        // 이후 Show에서는 이미 완성된 화면만 노출됩니다.
        var navigationError = await navigationReady.Task.WaitAsync(TimeSpan.FromSeconds(15));
        if (!string.IsNullOrWhiteSpace(navigationError))
            throw new InvalidOperationException(navigationError);
    }

    private async Task<CoreWebView2Environment> GetMainUiWebViewEnvironmentAsync()
    {
        if (_mainUiWebViewEnvironment is not null)
            return _mainUiWebViewEnvironment;

        var pending = _mainUiWebViewEnvironmentTask;
        var wasPrewarmed = pending is not null;
        if (pending is null)
        {
            var userData = Path.Combine(_storage.RootPath, "CollectorUiWebView2Data");
            pending = CoreWebView2Environment.CreateAsync(userDataFolder: userData);
            _mainUiWebViewEnvironmentTask = pending;
        }

        try
        {
            _mainUiWebViewEnvironment = await pending;
            return _mainUiWebViewEnvironment;
        }
        catch
        {
            if (ReferenceEquals(_mainUiWebViewEnvironmentTask, pending))
                _mainUiWebViewEnvironmentTask = null;
            if (!wasPrewarmed) throw;

            // 로그인 중 사전 준비만 일시적으로 실패한 경우 기존 시작 방식으로
            // 한 번 다시 시도합니다. 사전 준비가 로그인 성공을 되돌리지는 않습니다.
            _storage.Log("메인 화면 WebView2 사전 준비 재시도");
            var userData = Path.Combine(_storage.RootPath, "CollectorUiWebView2Data");
            pending = CoreWebView2Environment.CreateAsync(userDataFolder: userData);
            _mainUiWebViewEnvironmentTask = pending;
            _mainUiWebViewEnvironment = await pending;
            return _mainUiWebViewEnvironment;
        }
    }

    private async Task HandleUiMessageAsync(CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!WebViewTrustPolicy.IsTrustedUiMessageSource(e.Source))
        {
            _storage.Log("UI message blocked (source): " + WebViewTrustPolicy.SafeOriginForLog(e.Source));
            return;
        }

        string raw;
        try { raw = e.WebMessageAsJson; }
        catch
        {
            _storage.Log("UI message blocked (unreadable)");
            return;
        }

        if (!WebViewTrustPolicy.TryParseUiMessage(raw, out var root, out var action, out var reason))
        {
            _storage.Log("UI message blocked (" + reason + ")");
            return;
        }

        if (!CoreProductScope.LocalActionExecutionEnabled && !CoreProductScope.IsAllowedMainUiAction(action))
        {
            _storage.Log("Retired main UI action blocked: " + action);
            return;
        }

        try
        {
            var payload = root.TryGetProperty("payload", out var payloadElement)
                ? payloadElement
                : default;

            switch (action)
            {
                case "windowDrag":
                    NativeWindowDrag.Begin(this);
                    break;
                case "supportRequest":
                    await SubmitSupportRequestAsync(payload);
                    break;
                case "minimize":
                    WindowState = FormWindowState.Minimized;
                    break;
                case "close":
                    HideToTray();
                    break;
                case "exit":
                    ExitFromMain();
                    break;
                case "theme":
                    if (payload.TryGetProperty("theme", out var themeElement))
                    {
                        _darkMode = !string.Equals(themeElement.GetString(), "light", StringComparison.OrdinalIgnoreCase);
                        _storage.SaveTheme(_darkMode ? "dark" : "light");
                        ApplyTheme();
                        if (_automationSettingsForm is { IsDisposed: false, Disposing: false } automationForm)
                            await automationForm.ApplyHostThemeAsync(_darkMode ? "dark" : "light");
                    }
                    break;
                case "dashboard":
                    await OpenDashboardAsync();
                    break;
                case "openAutomationSettings":
                    var automationView = payload.TryGetProperty("view", out var automationViewElement)
                        ? automationViewElement.GetString() ?? "rules"
                        : "rules";
                    QueueVNextAutomationSettingsOpen(automationView);
                    return;
            }
        }
        catch (Exception ex)
        {
            _storage.Log("UI 메시지 처리 실패: " + ex);
            await ShowUiToastAsync("요청을 처리하지 못했습니다: " + ex.Message);
        }
    }

    private bool _supportRequestBusy;
    private async Task SubmitSupportRequestAsync(JsonElement payload)
    {
        if (_supportRequestBusy) return;
        _supportRequestBusy = true;
        try
        {
            var requestId = payload.GetProperty("requestId").GetString() ?? "";
            var message = payload.GetProperty("message").GetString() ?? "";
            var epoch = payload.GetProperty("sessionEpoch").GetInt64();
            await _vNextDevClient.SendSupportRequestAsync(requestId, message, epoch);
            await ExecuteUiAsync("setSupportResult", new { ok = true, message = "장애 내용을 접수했습니다. 운영자가 확인하겠습니다." });
        }
        catch (VNextDevelopmentException ex)
        {
            await ExecuteUiAsync("setSupportResult", new { ok = false, message = ex.Message });
        }
        catch
        {
            await ExecuteUiAsync("setSupportResult", new { ok = false, message = "접수하지 못했습니다. 내용을 유지한 채 다시 보내주세요." });
        }
        finally { _supportRequestBusy = false; }
    }

    private async Task OpenDashboardAsync()
    {
        if (_dashboardOpenInProgress) return;
        _dashboardOpenInProgress = true;
        try
        {
            await ExecuteUiAsync("setDashboardBusy", true);
            var epoch = _vNextDevClient.CaptureSessionEpoch();
            var path = await _vNextDevClient.CreateDashboardHandoffAsync();
            if (!_vNextDevClient.IsSessionEpochCurrent(epoch))
                throw new Exception("별록 계정 연결이 변경됐습니다. 다시 눌러주세요.");
            var baseUrl = CollectorStorage.ProductionServerUrl;
            if (!WebViewTrustPolicy.TryResolveSameOriginExternalUri(
                    baseUrl.TrimEnd('/') + "/",
                    path,
                    out var dashboardUrl,
                    out _))
                throw new Exception("서버가 허용되지 않은 대시보드 주소를 반환했습니다.");
            Process.Start(new ProcessStartInfo { FileName = dashboardUrl.AbsoluteUri, UseShellExecute = true });
        }
        catch (Exception ex)
        {
            await ShowUiToastAsync("대시보드를 열지 못했습니다: " + ex.Message);
        }
        finally
        {
            _dashboardOpenInProgress = false;
            try { await ExecuteUiAsync("setDashboardBusy", false); }
            catch (Exception) { /* The main window may have closed while the browser opened. */ }
        }
    }

    private void QueueVNextAutomationSettingsOpen(string targetView = "wallpaper")
    {
        if (!CoreProductScope.LocalActionExecutionEnabled)
        {
            QueueWallpaperEditorOpen();
            return;
        }
        // 메인 WebView2 콜백이 반환된 뒤 같은 메인 창 안에 자동화 화면을 올립니다.
        // 별도 모달 창과 중첩 메시지 루프를 만들지 않습니다.
        if (IsDisposed || Disposing || !IsHandleCreated) return;
        _pendingAutomationView = !CoreProductScope.LocalActionExecutionEnabled
            ? "wallpaper"
            : targetView is "rules" or "readiness" or "devices" or "overlays" or "activity" or "wallpaper"
                ? targetView
                : "rules";
        _automationSettingsShowRequested = true;

        var openForm = _automationSettingsForm;
        if (openForm is not null && !openForm.IsDisposed && !openForm.Disposing)
        {
            try
            {
                BeginInvoke(new Action(async () =>
                {
                    await openForm.SelectViewAsync(_pendingAutomationView);
                    if (!openForm.Visible) openForm.Show();
                    openForm.BringToFront();
                }));
            }
            catch (ObjectDisposedException) { }
            catch (InvalidOperationException) { }
            return;
        }
        if (_automationSettingsOpenOrPending) return;

        _automationSettingsOpenOrPending = true;
        try
        {
            BeginInvoke(new Action(async () => await ShowVNextAutomationSettingsAsync(display: true)));
        }
        catch (ObjectDisposedException)
        {
            _automationSettingsOpenOrPending = false;
        }
        catch (InvalidOperationException)
        {
            _automationSettingsOpenOrPending = false;
        }
    }

    private async Task PreloadVNextAutomationSettingsAsync()
    {
        // 풍벽지 전용 제품은 사용자가 편집기를 요청할 때만 원격 HTML과 세션을
        // 준비합니다. 백그라운드 실행 중 불필요한 WebView/네트워크 비용이 없습니다.
        if (!CoreProductScope.LocalActionExecutionEnabled) return;
        if (IsDisposed || Disposing || _automationSettingsOpenOrPending) return;
        var form = _automationSettingsForm;
        if (form is not null && !form.IsDisposed && !form.Disposing) return;
        _automationSettingsOpenOrPending = true;
        _automationSettingsShowRequested = false;
        await ShowVNextAutomationSettingsAsync(display: false);
    }

    private void QueueWallpaperEditorOpen()
    {
        if (IsDisposed || Disposing || !IsHandleCreated) return;
        if (!_vNextDevClient.IsSignedIn)
        {
            _ = ShowUiToastAsync("별록 서버에 연결한 뒤 편집기를 열어주세요.");
            return;
        }
        var openForm = _wallpaperEditorForm;
        if (openForm is not null && !openForm.IsDisposed && !openForm.Disposing)
        {
            if (!openForm.Visible) openForm.Show();
            if (openForm.WindowState == FormWindowState.Minimized)
                openForm.WindowState = FormWindowState.Normal;
            openForm.Activate();
            openForm.BringToFront();
            return;
        }
        if (_wallpaperEditorOpenOrPending) return;
        _wallpaperEditorOpenOrPending = true;
        try
        {
            BeginInvoke(new Action(async () => await ShowWallpaperEditorAsync()));
        }
        catch (ObjectDisposedException)
        {
            _wallpaperEditorOpenOrPending = false;
        }
        catch (InvalidOperationException)
        {
            _wallpaperEditorOpenOrPending = false;
        }
    }

    private async Task<CoreWebView2Environment> GetWallpaperEditorWebViewEnvironmentAsync()
    {
        if (_wallpaperEditorWebViewEnvironment is not null)
            return _wallpaperEditorWebViewEnvironment;
        var pending = _wallpaperEditorWebViewEnvironmentTask;
        if (pending is null)
        {
            var userData = Path.Combine(_storage.RootPath, "WallpaperEditorWebView2Data");
            pending = CoreWebView2Environment.CreateAsync(userDataFolder: userData);
            _wallpaperEditorWebViewEnvironmentTask = pending;
        }
        try
        {
            _wallpaperEditorWebViewEnvironment = await pending;
            return _wallpaperEditorWebViewEnvironment;
        }
        catch
        {
            if (ReferenceEquals(_wallpaperEditorWebViewEnvironmentTask, pending))
                _wallpaperEditorWebViewEnvironmentTask = null;
            throw;
        }
    }

    private async Task ShowWallpaperEditorAsync()
    {
        WallpaperEditorForm? form = null;
        try
        {
            var environment = await GetWallpaperEditorWebViewEnvironmentAsync();
            if (IsDisposed || Disposing || _vNextLocalAgent is null) return;
            form = new WallpaperEditorForm(
                _vNextLocalAgent,
                _storage,
                environment,
                UiAssetStore.Prepare(),
                Icon);
            _wallpaperEditorForm = form;
            form.FormClosed += WallpaperEditorForm_FormClosed;
            // 트레이에서 열 때 메인 창이 숨겨져 있어도 편집기가 함께 숨지지
            // 않도록 독립된 최상위 창으로 표시합니다.
            form.Show();
            form.WindowState = FormWindowState.Maximized;
            form.Activate();
            _wallpaperEditorOpenOrPending = false;
            form = null;
        }
        catch (Exception ex)
        {
            try { _storage.Log($"Wallpaper editor form failed: type={ex.GetType().Name} hresult=0x{ex.HResult:X8}"); }
            catch { }
            if (!IsDisposed && !Disposing)
                await ShowUiToastAsync("풍벽지 편집기를 열지 못했습니다: " + ex.Message);
        }
        finally
        {
            if (form is not null)
            {
                try { form.Dispose(); } catch { }
                if (ReferenceEquals(_wallpaperEditorForm, form)) _wallpaperEditorForm = null;
            }
            _wallpaperEditorOpenOrPending = false;
        }
    }

    private void WallpaperEditorForm_FormClosed(object? sender, FormClosedEventArgs e)
    {
        if (sender is not WallpaperEditorForm form) return;
        form.FormClosed -= WallpaperEditorForm_FormClosed;
        if (ReferenceEquals(_wallpaperEditorForm, form)) _wallpaperEditorForm = null;
        _wallpaperEditorOpenOrPending = false;
        try { form.Dispose(); } catch { }
    }

    private async Task<CoreWebView2Environment> GetAutomationWebViewEnvironmentAsync()
    {
        if (_mainUiWebViewEnvironment is not null)
            return _mainUiWebViewEnvironment;
        if (_automationWebViewEnvironment is not null)
            return _automationWebViewEnvironment;

        var pending = _automationWebViewEnvironmentTask;
        if (pending is null)
        {
            var userData = Path.Combine(_storage.RootPath, "AutomationUiWebView2Data");
            pending = CoreWebView2Environment.CreateAsync(userDataFolder: userData);
            _automationWebViewEnvironmentTask = pending;
        }

        try
        {
            _automationWebViewEnvironment = await pending;
            return _automationWebViewEnvironment;
        }
        catch
        {
            if (ReferenceEquals(_automationWebViewEnvironmentTask, pending))
                _automationWebViewEnvironmentTask = null;
            throw;
        }
    }

    private async Task ShowVNextAutomationSettingsAsync(bool display)
    {
        VNextAutomationSettingsForm? form = null;
        try
        {
            // 자동화 화면은 계정 연결 대기와 분리해 먼저 준비합니다. 로컬 OBS와
            // 마이크 설정은 즉시 열리고, 서버 데이터는 폼 내부에서 연결 상태에
            // 맞춰 채워지므로 화면 전환이 네트워크 왕복을 기다리지 않습니다.
            var environment = await GetAutomationWebViewEnvironmentAsync();
            if (IsDisposed || Disposing) return;

            form = new VNextAutomationSettingsForm(
                UiAssetStore.Prepare(),
                _darkMode,
                Icon,
                _vNextDevClient,
                _vNextLocalAgent,
                _storage,
                environment);
            _automationSettingsForm = form;
            await form.SelectViewAsync(_pendingAutomationView);
            form.TopLevel = false;
            form.FormBorderStyle = FormBorderStyle.None;
            form.Dock = DockStyle.Fill;
            form.BackRequested += AutomationSettingsForm_BackRequested;
            form.HostWindowDragRequested += AutomationSettingsForm_HostWindowDragRequested;
            form.HostMinimizeRequested += AutomationSettingsForm_HostMinimizeRequested;
            form.HostCloseRequested += AutomationSettingsForm_HostCloseRequested;
            form.HostThemeChangedRequested += AutomationSettingsForm_HostThemeChangedRequested;
            form.FormClosed += AutomationSettingsForm_FormClosed;
            Controls.Add(form);
            form.Show();
            if (display || _automationSettingsShowRequested)
            {
                form.BringToFront();
            }
            else
            {
                form.Hide();
                _ui.BringToFront();
            }
            _automationSettingsOpenOrPending = false;
            form = null;
        }
        catch (Exception ex)
        {
            // 이 메서드는 BeginInvoke의 async-void 경계에서 시작됩니다. 진단 파일
            // I/O나 종료 중 MessageBox 실패가 그 경계 밖으로 빠져 앱을 종료시키지
            // 않도록 최종 오류 처리 자체도 비투척으로 유지합니다.
            try
            {
                _storage.Log($"Automation settings open failed: type={ex.GetType().Name} hresult=0x{ex.HResult:X8}");
            }
            catch { }
            if ((display || _automationSettingsShowRequested) && !IsDisposed && !Disposing)
            {
                try
                {
                    MessageBox.Show(
                        "별록 액션 화면을 열지 못했습니다.\n\n" + ex.Message,
                        "별록 에이전트",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error);
                }
                catch { }
            }
        }
        finally
        {
            if (form is not null)
            {
                _automationSettingsForm = null;
                try { form.Dispose(); }
                catch (Exception ex)
                {
                    try
                    {
                        _storage.Log($"Automation settings dispose failed: type={ex.GetType().Name} hresult=0x{ex.HResult:X8}");
                    }
                    catch { }
                }
                _automationSettingsOpenOrPending = false;
            }
            else if (_automationSettingsForm is null)
            {
                _automationSettingsOpenOrPending = false;
            }
        }
    }

    private async void AutomationSettingsForm_BackRequested(string destination)
    {
        var form = _automationSettingsForm;
        if (form is null || form.IsDisposed || form.Disposing) return;
        _automationSettingsShowRequested = false;
        try
        {
            if (destination == "main")
                await ExecuteUiAsync("showMain", new { });
            else
                await ExecuteUiAsync("openScreen", destination is "collection" ? "collection" : "rules");
        }
        catch (Exception ex)
        {
            try { _storage.Log($"Automation sidebar navigation failed: {ex.GetType().Name}"); }
            catch { }
        }
        finally
        {
            if (!form.IsDisposed && !form.Disposing) form.Hide();
            if (!IsDisposed && !Disposing)
            {
                _ui.Visible = true;
                _ui.BringToFront();
            }
        }
    }

    private void AutomationSettingsForm_HostWindowDragRequested()
    {
        if (!IsDisposed && !Disposing) NativeWindowDrag.Begin(this);
    }

    private void AutomationSettingsForm_HostMinimizeRequested()
    {
        if (!IsDisposed && !Disposing) WindowState = FormWindowState.Minimized;
    }

    private void AutomationSettingsForm_HostCloseRequested()
    {
        if (!IsDisposed && !Disposing) HideToTray();
    }

    private async void AutomationSettingsForm_HostThemeChangedRequested(string theme)
    {
        _darkMode = !string.Equals(theme, "light", StringComparison.OrdinalIgnoreCase);
        _storage.SaveTheme(_darkMode ? "dark" : "light");
        ApplyTheme();
        await ExecuteUiAsync("setTheme", _darkMode ? "dark" : "light");
    }

    private async void AutomationSettingsForm_FormClosed(object? sender, FormClosedEventArgs e)
    {
        if (sender is not VNextAutomationSettingsForm form) return;
        form.BackRequested -= AutomationSettingsForm_BackRequested;
        form.HostWindowDragRequested -= AutomationSettingsForm_HostWindowDragRequested;
        form.HostMinimizeRequested -= AutomationSettingsForm_HostMinimizeRequested;
        form.HostCloseRequested -= AutomationSettingsForm_HostCloseRequested;
        form.HostThemeChangedRequested -= AutomationSettingsForm_HostThemeChangedRequested;
        form.FormClosed -= AutomationSettingsForm_FormClosed;
        if (ReferenceEquals(_automationSettingsForm, form))
            _automationSettingsForm = null;
        _automationSettingsOpenOrPending = false;
        try { await form.WaitForShutdownAsync(); }
        catch (Exception ex)
        {
            try { _storage.Log($"Automation inline UI shutdown failed: {ex.GetType().Name}"); }
            catch { }
        }
        finally
        {
            try { Controls.Remove(form); }
            catch { }
            try { form.Dispose(); }
            catch { }
            if (!IsDisposed && !Disposing)
            {
                _ui.Visible = true;
                _ui.BringToFront();
                if (_vNextDevClient.SessionEpoch != form.OpenedSessionEpoch)
                {
                    try { BeginInvoke(new Action(async () => await PreloadVNextAutomationSettingsAsync())); }
                    catch (ObjectDisposedException) { }
                    catch (InvalidOperationException) { }
                }
            }
        }
    }

    private async Task PushMainStateAsync()
    {
        if (!_uiReady || _ui.CoreWebView2 is null) return;
        var localAgentStatus = _vNextLocalAgent?.Status;
        var serverConnected = _vNextDevClient.IsSignedIn && localAgentStatus?.Connected == true;
        var serverRecoveryState = AgentConnectionPresentation.RecoveryState(
            _vNextDevClient.IsSignedIn, serverConnected, localAgentStatus?.Running == true,
            _vNextDevClient.SessionRecoveryState, !string.IsNullOrEmpty(_vNextAgentStartupError));
        await ExecuteUiAsync("setMainState", new
        {
            streamerName = _storage.StreamerName,
            releaseLabel = BuildInfo.DisplayVersion,
            updateWarning = _updateNotice.Get(),
            betaSupportEnabled = _vNextDevClient.IsSignedIn && _vNextDevClient.BetaSupportEnabled,
            supportSessionEpoch = _vNextDevClient.CaptureSessionEpoch(),
            developmentConnected = _vNextDevClient.IsSignedIn,
            developmentRecoveryState = serverRecoveryState,
            serverConnected
        });
    }

    private async Task ExecuteUiAsync(string function, object payload)
    {
        if (!_uiReady || _ui.CoreWebView2 is null || _ui.IsDisposed) return;
        var json = JsonSerializer.Serialize(payload);
        await _ui.CoreWebView2.ExecuteScriptAsync($"window.byeollog?.{function}({json});");
    }

    private Task ShowUiToastAsync(string message) => ExecuteUiAsync("showToast", message);

    private void NotifyMainUi()
    {
        if (!_uiReady || IsDisposed) return;
        _ = PushMainStateAsync();
    }

    private void UiNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (WebViewTrustPolicy.IsAllowedUiNavigation(e.Uri, out _)) return;
        e.Cancel = true;
        _storage.Log("UI navigation blocked · origin=" + WebViewTrustPolicy.SafeOriginForLog(e.Uri));
    }

    private void UiFrameNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        UiNavigationStarting(sender, e);
    }

    private void UiNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        _storage.Log("UI popup blocked · origin=" + WebViewTrustPolicy.SafeOriginForLog(e.Uri));
    }

    private void CoreWebView2_PermissionRequested(object? sender, CoreWebView2PermissionRequestedEventArgs e)
    {
        e.State = CoreWebView2PermissionState.Deny;
        e.SavesInProfile = false;
        e.Handled = true;
        _storage.Log(
            "WebView permission denied · kind=" + e.PermissionKind +
            " · origin=" + WebViewTrustPolicy.SafeOriginForLog(e.Uri));
    }

    private void CoreWebView2_DownloadStarting(object? sender, CoreWebView2DownloadStartingEventArgs e)
    {
        e.Cancel = true;
        _storage.Log(
            "WebView download blocked · origin=" +
            WebViewTrustPolicy.SafeOriginForLog(e.DownloadOperation.Uri));
    }

    private async Task ReconnectVNextDevelopmentAsync()
    {
        await ConnectVNextDevelopmentAsync(forcePrompt: true);
    }

    private async Task DisconnectVNextDevelopmentAsync()
    {
        if (!_vNextDevClient.IsSignedIn)
        {
            MessageBox.Show(
                "현재 연결된 별록 액션 계정 세션이 없습니다.",
                "별록 에이전트 · 별록 액션 연결",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
            return;
        }
        if (MessageBox.Show(
                "현재 실행의 별록 액션 계정 연결을 해제할까요?\n\n기존 별록 수집과 저장 데이터는 그대로 유지됩니다.",
                "별록 액션 연결 해제",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question,
                MessageBoxDefaultButton.Button2) != DialogResult.Yes)
            return;

        try
        {
            await _vNextDevClient.DisconnectAsync();
            _activityBalloonPending = false;
            _storage.Log("별록 액션 계정 세션 연결 해제 완료");
            UpdateTrayStatus();
            NotifyMainUi();
        }
        catch (Exception ex)
        {
            _storage.Log("뉴별록 연결 해제 실패: " + ex.GetType().Name);
            MessageBox.Show(
                "별록 액션 계정 연결을 안전하게 해제하지 못해 현재 연결을 유지했습니다.\n\n" + ex.Message,
                "별록 액션 연결 해제",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
    }

    private async Task<bool> ConnectVNextDevelopmentAsync(bool forcePrompt)
    {
        try
        {
            // 일반 로그인 성공 직후에는 자동화 세션의 Auth/RLS 검증이 아직
            // 백그라운드에서 진행 중일 수 있습니다. 즉시 실패로 판정하지 않고
            // 로그인 때 시작한 동일 작업만 제한 시간 안에서 기다립니다.
            if (!_vNextDevClient.IsSignedIn)
                await _vNextDevClient.WaitForPendingCollectorPairSessionAdoptionAsync(
                    TimeSpan.FromSeconds(8));

            if (_vNextDevClient.IsSignedIn)
            {
                if (_vNextLocalAgent is not null)
                    await _vNextLocalAgent.EnsureCurrentDeviceRegisteredAsync();
                return true;
            }

            if (forcePrompt)
            {
                MessageBox.Show(
                    "일반 별록 로그인 응답에서 별록 액션 세션을 받지 못했습니다.\n\n" +
                    "별도의 개발자 로그인이나 자동 연결 설정은 필요하지 않습니다. " +
                    "프로그램을 완전히 종료한 뒤 다시 실행하여 일반 별록 계정으로 로그인해주세요.\n\n" +
                    "재로그인 후에도 계속되면 트레이 메뉴에서 진단 ZIP을 만들어 전달해주세요. " +
                    "기존 별록 수집 기능은 계속 사용할 수 있습니다.",
                    "별록 에이전트 · 별록 액션 연결",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
            }
            return false;
        }
        catch (Exception ex)
        {
            _storage.Log("뉴별록 기능 연결 실패: " + ex.GetType().Name);
            MessageBox.Show(
                "별록 액션 계정을 연결하지 못했습니다. 기존 별록 수집 기능은 계속 사용할 수 있습니다.\n\n" + ex.Message,
                "별록 에이전트 · 별록 액션 연결",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            UpdateTrayStatus();
            NotifyMainUi();
            return false;
        }
    }


    private async Task RunVNextLocalAgentE2ETestAsync()
    {
        if (_vNextAgentE2EInProgress) return;
        if (_vNextLocalAgent is null)
        {
            MessageBox.Show(
                "이 PC 자동화를 시작하지 못했습니다.\n\n" + _vNextAgentStartupError,
                "뉴별록 DEV 이 PC 자동화 테스트",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return;
        }
        if (!_vNextDevClient.IsSignedIn)
        {
            MessageBox.Show(
                "vNext DEV 계정 세션이 없습니다. 먼저 트레이 메뉴의 ‘vNext 개발 계정 다시 연결’을 실행해주세요.",
                "뉴별록 DEV 이 PC 자동화 테스트",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return;
        }

        var answer = MessageBox.Show(
            "개발 DB에 이 PC 자동화 전용 테스트 이벤트 1건을 전송합니다.\n\n" +
            "별록 에이전트가 작업을 받아 SQLite에 기록하고, 로컬 동작 실행 후 ACK하는지 확인합니다. " +
            "같은 이벤트 재전송의 중복 차단도 함께 검사합니다.\n" +
            "운영 서버에는 전송하지 않습니다. 계속할까요?",
            "뉴별록 DEV 이 PC 자동화 테스트",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Question,
            MessageBoxDefaultButton.Button1);
        if (answer != DialogResult.Yes) return;

        _vNextAgentE2EInProgress = true;
        var now = DateTimeOffset.UtcNow;
        var correlationId = $"collector_agent_e2e_{now:yyyyMMddHHmmss}_{Guid.NewGuid():N}";
        var normalizedEvent = new VNextDevelopmentEvent(
            SchemaVersion: "1.0",
            Id: correlationId + "_probe",
            WorkspaceId: _vNextDevClient.WorkspaceId,
            Source: "collector",
            Platform: "windows",
            Type: "local_agent_probe",
            Subtype: "collector_agent_e2e",
            Actor: new { id = "collector_agent_e2e", name = "Collector Local Agent E2E" },
            Amount: null,
            Currency: null,
            Payload: new { label = "LOCAL_AGENT_OK", testOnly = true },
            OccurredAt: now,
            ReceivedAt: now,
            CorrelationId: correlationId);

        try
        {
            var first = await _vNextDevClient.SendEventAsync(normalizedEvent);
            var executionId = first.QueuedExecutionIds.Count == 1 ? first.QueuedExecutionIds[0] : "";
            _vNextLocalAgent.Wake();
            var ack = executionId.Length > 0
                ? await _vNextLocalAgent.WaitForAckOutcomeAsync(executionId, TimeSpan.FromSeconds(35))
                : null;
            var acknowledged = ack is not null;
            var ackSucceeded = ack?.Succeeded == true;
            var second = await _vNextDevClient.SendEventAsync(normalizedEvent);

            var succeeded =
                !first.Duplicate
                && first.MatchedRuleCount == 1
                && first.QueuedExecutionCount == 1
                && first.CompletedSucceededCount == 0
                && acknowledged
                && ackSucceeded
                && second.Duplicate
                && second.QueuedExecutionCount == 0
                && second.CompletedSucceededCount == 0;

            var shortId = correlationId[^12..];
            _storage.Log(
                $"vNext Local Agent E2E {(succeeded ? "성공" : "검증 불일치")} · test={shortId} · " +
                $"match={first.MatchedRuleCount} queue={first.QueuedExecutionCount} " +
                $"ack={acknowledged} ackSucceeded={ackSucceeded} duplicate={second.Duplicate}");

            if (!succeeded)
            {
                MessageBox.Show(
                    "DEV 전송은 완료됐지만 이 PC 자동화 검증 결과가 예상과 다릅니다.\n\n" +
                    $"규칙 매칭: {first.MatchedRuleCount}건 (예상 1)\n" +
                    $"로컬 실행 생성: {first.QueuedExecutionCount}건 (예상 1)\n" +
                    $"Agent ACK: {(acknowledged ? "확인" : "시간 초과")}\n" +
                    $"로컬 액션 결과: {(ackSucceeded ? "성공" : acknowledged ? "실패" : "미확인")}\n" +
                    $"재전송 중복 판정: {(second.Duplicate ? "확인" : "실패")}\n\n" +
                    $"테스트 식별값: {shortId}",
                    "뉴별록 DEV 이 PC 자동화 테스트",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
                return;
            }

            MessageBox.Show(
                "DEV 이 PC 자동화 전체 경로 테스트에 성공했습니다.\n\n" +
                "✓ 테스트 이벤트 및 규칙 매칭\n" +
                "✓ 별록 에이전트 작업 수신\n" +
                "✓ SQLite inbox/outbox 기록\n" +
                "✓ 로컬 액션 실행 및 ACK 완료\n" +
                "✓ 동일 이벤트 재전송 중복 차단\n\n" +
                $"테스트 식별값: {shortId}\n" +
                "운영 서버에는 전송되지 않았습니다.",
                "뉴별록 DEV 이 PC 자동화 테스트",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }
        catch (VNextDevelopmentException ex)
        {
            _storage.Log($"vNext Local Agent E2E 실패 · status={ex.StatusCode?.ToString() ?? "none"} code={ex.Code}");
            MessageBox.Show(
                ex.Message + "\n\n트레이에서 개발 계정을 다시 연결한 뒤 재시도해주세요.",
                "뉴별록 DEV 이 PC 자동화 테스트",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
        catch (Exception ex)
        {
            _storage.Log($"vNext Local Agent E2E 실패 · type={ex.GetType().Name}");
            MessageBox.Show(
                "DEV 이 PC 자동화 테스트 중 오류가 발생했습니다.\n\n" + ex.Message,
                "뉴별록 DEV 이 PC 자동화 테스트",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
        finally
        {
            _vNextAgentE2EInProgress = false;
            UpdateTrayStatus();
        }
    }

    private async Task RunVNextObsE2ETestAsync()
    {
        if (_vNextObsE2EInProgress) return;
        if (_timedMuteTestInProgress)
        {
            MessageBox.Show(
                "시간제 음소거가 진행 중입니다. 완료된 뒤 OBS 상태 유지 테스트를 실행해주세요.",
                "방송 프로그램 테스트 진행 중",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return;
        }
        if (_obsMuteCycleInProgress)
        {
            MessageBox.Show(
                "OBS 실제 음소거 복구가 진행 중입니다. 완료된 뒤 상태 유지 테스트를 실행해주세요.",
                "OBS 테스트 진행 중",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return;
        }
        if (_vNextLocalAgent is null)
        {
            MessageBox.Show(
                "이 PC 자동화를 시작하지 못했습니다.\n\n" + _vNextAgentStartupError,
                "vNext DEV OBS 상태 유지 테스트",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return;
        }
        if (!_vNextDevClient.IsSignedIn)
        {
            MessageBox.Show(
                "vNext DEV 계정 세션이 없습니다. 먼저 개발 계정을 다시 연결해주세요.",
                "vNext DEV OBS 상태 유지 테스트",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return;
        }
        var settings = _storage.LoadObsSettings();
        if (!settings.Enabled || string.IsNullOrWhiteSpace(settings.MicrophoneInputName))
        {
            MessageBox.Show(
                "먼저 ‘OBS 연결 설정’을 저장하고 ‘OBS 연결 테스트’를 통과해주세요.",
                "vNext DEV OBS 상태 유지 테스트",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return;
        }

        var answer = MessageBox.Show(
            "현재 OBS 마이크의 음소거 상태를 먼저 읽은 뒤, 같은 상태를 다시 지정하는 DEV 이벤트를 전송합니다.\n\n" +
            "서버 규칙 → 이 PC 자동화 → OBS → ACK와 중복 차단을 검사하며 실제 음소거 상태는 바꾸지 않습니다. 계속할까요?",
            "vNext DEV OBS 상태 유지 테스트",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Question,
            MessageBoxDefaultButton.Button1);
        if (answer != DialogResult.Yes) return;

        if (_obsMuteCycleInProgress)
        {
            MessageBox.Show(
                "다른 방송 프로그램 테스트가 먼저 시작됐습니다. 완료된 뒤 다시 실행해주세요.",
                "방송 프로그램 테스트 진행 중",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return;
        }

        _vNextObsE2EInProgress = true;
        try
        {
            using var probeTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(6));
            var probe = await new ObsActionAdapter(_storage).ProbeAsync(probeTimeout.Token);
            var now = DateTimeOffset.UtcNow;
            var correlationId = $"collector_obs_e2e_{now:yyyyMMddHHmmss}_{Guid.NewGuid():N}";
            var normalizedEvent = new VNextDevelopmentEvent(
                SchemaVersion: "1.0",
                Id: correlationId + "_probe",
                WorkspaceId: _vNextDevClient.WorkspaceId,
                Source: "collector",
                Platform: "windows",
                Type: "obs_input_mute_probe",
                Subtype: probe.InputMuted ? "muted" : "unmuted",
                Actor: new { id = "collector_obs_e2e", name = "Collector OBS E2E" },
                Amount: null,
                Currency: null,
                Payload: new { target = "microphone", desiredMuted = probe.InputMuted, testOnly = true },
                OccurredAt: now,
                ReceivedAt: now,
                CorrelationId: correlationId);

            var first = await _vNextDevClient.SendEventAsync(normalizedEvent);
            var executionId = first.QueuedExecutionIds.Count == 1 ? first.QueuedExecutionIds[0] : "";
            _vNextLocalAgent.Wake();
            var ack = executionId.Length > 0
                ? await _vNextLocalAgent.WaitForAckOutcomeAsync(executionId, TimeSpan.FromSeconds(35))
                : null;
            var acknowledged = ack is not null;
            var ackSucceeded = ack?.Succeeded == true;
            var ackResultMatches =
                ack?.Result is JsonElement ackResult
                && ackResult.ValueKind == JsonValueKind.Object
                && ackResult.TryGetProperty("target", out var ackTarget)
                && ackTarget.ValueKind == JsonValueKind.String
                && ackTarget.GetString() == "microphone"
                && ackResult.TryGetProperty("requestedMuted", out var requestedMuted)
                && requestedMuted.ValueKind is JsonValueKind.True or JsonValueKind.False
                && requestedMuted.GetBoolean() == probe.InputMuted
                && ackResult.TryGetProperty("previousMuted", out var previousMuted)
                && previousMuted.ValueKind is JsonValueKind.True or JsonValueKind.False
                && previousMuted.GetBoolean() == probe.InputMuted
                && ackResult.TryGetProperty("changed", out var changed)
                && changed.ValueKind is JsonValueKind.True or JsonValueKind.False
                && !changed.GetBoolean();
            var second = await _vNextDevClient.SendEventAsync(normalizedEvent);
            using var verifyTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(6));
            var after = await new ObsActionAdapter(_storage).ProbeAsync(verifyTimeout.Token);
            var statePreserved = after.InputMuted == probe.InputMuted;

            var succeeded =
                !first.Duplicate
                && first.MatchedRuleCount == 1
                && first.QueuedExecutionCount == 1
                && first.CompletedSucceededCount == 0
                && acknowledged
                && ackSucceeded
                && ackResultMatches
                && second.Duplicate
                && second.QueuedExecutionCount == 0
                && second.CompletedSucceededCount == 0
                && statePreserved;
            var shortId = correlationId[^12..];
            _storage.Log(
                $"vNext OBS E2E {(succeeded ? "성공" : "검증 불일치")} · test={shortId} · " +
                $"match={first.MatchedRuleCount} queue={first.QueuedExecutionCount} " +
                $"ack={acknowledged} ackSucceeded={ackSucceeded} result={ackResultMatches} " +
                $"duplicate={second.Duplicate} statePreserved={statePreserved}");

            if (!succeeded)
            {
                MessageBox.Show(
                    "DEV OBS 전송은 완료됐지만 검증 결과가 예상과 다릅니다.\n\n" +
                    $"규칙 매칭: {first.MatchedRuleCount}건 (예상 1)\n" +
                    $"OBS 실행 생성: {first.QueuedExecutionCount}건 (예상 1)\n" +
                    $"Agent ACK: {(acknowledged ? "확인" : "시간 초과")}\n" +
                    $"OBS 액션 결과: {(ackSucceeded ? "성공" : acknowledged ? "실패" : "미확인")}\n" +
                    $"상태 유지 결과 계약: {(ackResultMatches ? "확인" : "불일치")}\n" +
                    $"재전송 중복 판정: {(second.Duplicate ? "확인" : "실패")}\n" +
                    $"테스트 전후 상태: {(statePreserved ? "유지" : "불일치")}\n\n" +
                    $"테스트 식별값: {shortId}",
                    "vNext DEV OBS 상태 유지 테스트",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
                return;
            }

            MessageBox.Show(
                "DEV OBS Adapter 상태 유지 경로 테스트에 성공했습니다.\n\n" +
                "✓ 현재 OBS 마이크 상태 확인\n" +
                "✓ OBS 전용 규칙 및 이 PC 자동화 작업 생성\n" +
                "✓ 현재값 확인과 멱등 no-op 및 성공 ACK\n" +
                "✓ 동일 이벤트 재전송 중복 차단\n" +
                "✓ 테스트 전후 OBS 상태 유지\n\n" +
                $"테스트 식별값: {shortId}\n" +
                "운영 서버에는 전송되지 않았습니다.",
                "vNext DEV OBS 상태 유지 테스트",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }
        catch (OperationCanceledException)
        {
            MessageBox.Show(
                "OBS 연결 시간이 초과됐습니다.",
                "vNext DEV OBS 상태 유지 테스트",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
        catch (VNextDevelopmentException ex)
        {
            _storage.Log($"vNext OBS E2E 실패 · status={ex.StatusCode?.ToString() ?? "none"} code={ex.Code}");
            MessageBox.Show(
                ex.Message + "\n\n개발 계정을 다시 연결한 뒤 재시도해주세요.",
                "vNext DEV OBS 상태 유지 테스트",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
        catch (Exception ex)
        {
            _storage.Log($"vNext OBS E2E 실패 · type={ex.GetType().Name}");
            MessageBox.Show(
                "DEV OBS 상태 유지 테스트 중 오류가 발생했습니다. OBS 연결 설정을 확인해주세요.",
                "vNext DEV OBS 상태 유지 테스트",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
        finally
        {
            _vNextObsE2EInProgress = false;
            UpdateTrayStatus();
        }
    }

    private async Task RunVNextTimedMuteE2ETestAsync(bool useWindowsCapture)
    {
        if (_timedMuteTestInProgress) return;
        var displayTarget = useWindowsCapture ? "Windows 마이크" : "OBS 마이크";
        var eventType = useWindowsCapture ? "timed_mute_windows_probe" : "timed_mute_obs_probe";
        var targetAlias = useWindowsCapture
            ? TimedMuteActionAdapter.WindowsTargetAlias
            : TimedMuteActionAdapter.ObsTargetAlias;

        if (_obsTestInProgress || _obsMuteCycleInProgress || _vNextObsE2EInProgress)
        {
            MessageBox.Show(
                "다른 방송 마이크 테스트가 진행 중입니다. 완료된 뒤 다시 실행해주세요.",
                "방송 프로그램 테스트 진행 중",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return;
        }
        if (_vNextLocalAgent is null)
        {
            MessageBox.Show(
                "이 PC 자동화를 시작하지 못했습니다.\n\n" + _vNextAgentStartupError,
                $"vNext DEV {displayTarget} 시간제 음소거 E2E",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return;
        }
        if (!_vNextDevClient.IsSignedIn)
        {
            MessageBox.Show(
                "vNext DEV 계정 세션이 없습니다. 먼저 개발 계정을 다시 연결해주세요.",
                $"vNext DEV {displayTarget} 시간제 음소거 E2E",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return;
        }

        try
        {
            using var probeTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            if (await ReadTimedMuteStateWithoutGateAsync(useWindowsCapture, probeTimeout.Token))
            {
                MessageBox.Show(
                    $"현재 {displayTarget}가 이미 음소거 상태입니다. 숨겨진 음성을 노출하지 않도록 상태를 바꾸지 않았습니다.\n\n직접 음소거를 해제한 뒤 E2E 테스트를 다시 실행해주세요.",
                    $"vNext DEV {displayTarget} 시간제 음소거 E2E",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
                return;
            }
        }
        catch (Exception ex)
        {
            _storage.Log($"vNext {displayTarget} 시간제 음소거 E2E 사전 확인 실패 · {ex.GetType().Name}");
            MessageBox.Show(
                $"{displayTarget} 상태를 확인하지 못했습니다. 로컬 읽기 전용 테스트부터 통과시켜주세요.",
                $"vNext DEV {displayTarget} 시간제 음소거 E2E",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return;
        }

        var answer = MessageBox.Show(
            $"DEV 이벤트 → 규칙 → 이 PC 자동화 → {displayTarget} → 복구 → ACK 전체 경로를 검사합니다.\n\n" +
            "• 실제로 3초간 음소거됩니다.\n" +
            "• 테스트 중 음소거 상태를 관찰하고, ACK 전에 원래 상태 복구까지 확인합니다.\n" +
            "• 같은 이벤트 재전송이 새 작업을 만들지 않는지도 확인합니다.\n" +
            "• 운영 서버에는 전송되지 않습니다.\n\n실제 방송이 아닌 상태에서 실행할까요?",
            $"vNext DEV {displayTarget} 3초 음소거 E2E",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning,
            MessageBoxDefaultButton.Button2);
        if (answer != DialogResult.Yes) return;

        _timedMuteTestInProgress = true;
        UpdateTrayStatus();
        try
        {
            var now = DateTimeOffset.UtcNow;
            var correlationId = $"collector_timed_mute_{(useWindowsCapture ? "win" : "obs")}_{now:yyyyMMddHHmmss}_{Guid.NewGuid():N}";
            var normalizedEvent = new VNextDevelopmentEvent(
                SchemaVersion: "1.0",
                Id: correlationId + "_probe",
                WorkspaceId: _vNextDevClient.WorkspaceId,
                Source: "collector",
                Platform: "windows",
                Type: eventType,
                Subtype: "duration_3000",
                Actor: new { id = "collector_timed_mute_e2e", name = "Collector Timed Mute E2E" },
                Amount: null,
                Currency: null,
                Payload: new { target = targetAlias, durationMs = 3000, testOnly = true },
                OccurredAt: now,
                ReceivedAt: now,
                CorrelationId: correlationId);

            var first = await _vNextDevClient.SendEventAsync(normalizedEvent);
            var executionId = first.QueuedExecutionIds.Count == 1 ? first.QueuedExecutionIds[0] : "";
            _vNextLocalAgent.Wake();
            var ackTask = executionId.Length > 0
                ? _vNextLocalAgent.WaitForAckOutcomeAsync(executionId, TimeSpan.FromSeconds(45))
                : Task.FromResult<VNextAgentAck?>(null);

            var observedMuted = false;
            var observationDeadline = DateTimeOffset.UtcNow.AddSeconds(20);
            while (DateTimeOffset.UtcNow < observationDeadline && !ackTask.IsCompleted)
            {
                try
                {
                    using var readTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                    if (await ReadTimedMuteStateWithoutGateAsync(useWindowsCapture, readTimeout.Token))
                    {
                        observedMuted = true;
                        break;
                    }
                }
                catch
                {
                    // 짧은 상태 관찰 실패는 다음 폴링에서 재확인합니다.
                }
                await Task.Delay(120);
            }

            var ack = await ackTask;
            var ackResultMatches =
                ack?.Succeeded == true
                && ack.Result is JsonElement result
                && result.ValueKind == JsonValueKind.Object
                && result.TryGetProperty("target", out var resultTarget)
                && resultTarget.ValueKind == JsonValueKind.String
                && resultTarget.GetString() == targetAlias
                && result.TryGetProperty("durationMs", out var resultDuration)
                && resultDuration.TryGetInt32(out var actualDuration)
                && actualDuration == 3000
                && result.TryGetProperty("mutedVerified", out var mutedVerified)
                && mutedVerified.ValueKind is JsonValueKind.True or JsonValueKind.False
                && mutedVerified.GetBoolean()
                && result.TryGetProperty("restoredVerified", out var restoredVerified)
                && restoredVerified.ValueKind is JsonValueKind.True or JsonValueKind.False
                && restoredVerified.GetBoolean();

            using var finalTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            var finalMuted = await ReadTimedMuteStateWithoutGateAsync(useWindowsCapture, finalTimeout.Token);
            var second = await _vNextDevClient.SendEventAsync(normalizedEvent);
            var succeeded =
                !first.Duplicate
                && first.MatchedRuleCount == 1
                && first.QueuedExecutionCount == 1
                && first.CompletedSucceededCount == 0
                && observedMuted
                && ackResultMatches
                && !finalMuted
                && second.Duplicate
                && second.QueuedExecutionCount == 0;
            var shortId = correlationId[^12..];
            _storage.Log(
                $"vNext {displayTarget} 시간제 음소거 E2E {(succeeded ? "성공" : "검증 불일치")} · test={shortId} " +
                $"match={first.MatchedRuleCount} queue={first.QueuedExecutionCount} observedMuted={observedMuted} " +
                $"ackContract={ackResultMatches} restored={!finalMuted} duplicate={second.Duplicate}");

            if (!succeeded)
            {
                MessageBox.Show(
                    $"DEV {displayTarget} E2E 결과가 예상과 다릅니다.\n\n" +
                    $"규칙 매칭: {first.MatchedRuleCount}건 (예상 1)\n" +
                    $"작업 생성: {first.QueuedExecutionCount}건 (예상 1)\n" +
                    $"음소거 구간 관찰: {(observedMuted ? "확인" : "미확인")}\n" +
                    $"ACK 복구 계약: {(ackResultMatches ? "확인" : "불일치/시간 초과")}\n" +
                    $"최종 음소거 해제: {(!finalMuted ? "확인" : "실패 — 즉시 직접 해제 필요")}\n" +
                    $"중복 차단: {(second.Duplicate ? "확인" : "실패")}\n\n테스트 식별값: {shortId}",
                    $"vNext DEV {displayTarget} 시간제 음소거 E2E",
                    MessageBoxButtons.OK,
                    finalMuted ? MessageBoxIcon.Error : MessageBoxIcon.Warning);
                return;
            }

            MessageBox.Show(
                $"DEV {displayTarget} 3초 시간제 음소거 E2E에 성공했습니다.\n\n" +
                "✓ 이벤트 및 전용 규칙 매칭\n✓ 장치 capability 기반 작업 수신\n✓ 실제 음소거 구간 관찰\n" +
                "✓ 시작 상태 복구 뒤 성공 ACK\n✓ 동일 이벤트 재전송 중복 차단\n\n" +
                $"테스트 식별값: {shortId}\n운영 서버에는 전송되지 않았습니다.",
                $"vNext DEV {displayTarget} 시간제 음소거 E2E",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }
        catch (VNextDevelopmentException ex)
        {
            _storage.Log($"vNext {displayTarget} 시간제 음소거 E2E 실패 · status={ex.StatusCode?.ToString() ?? "none"} code={ex.Code}");
            MessageBox.Show(ex.Message, $"vNext DEV {displayTarget} 시간제 음소거 E2E", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        catch (Exception ex)
        {
            _storage.Log($"vNext {displayTarget} 시간제 음소거 E2E 실패 · {ex.GetType().Name}");
            MessageBox.Show(
                $"{displayTarget} E2E 테스트 중 오류가 발생했습니다. 지금 마이크 상태를 직접 확인해주세요.",
                $"vNext DEV {displayTarget} 시간제 음소거 E2E",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
        finally
        {
            _timedMuteTestInProgress = false;
            _vNextLocalAgent.Wake();
            UpdateTrayStatus();
        }
    }

    private async Task<bool> ReadTimedMuteStateWithoutGateAsync(
        bool useWindowsCapture,
        CancellationToken cancellationToken)
    {
        if (useWindowsCapture)
        {
            var settings = _storage.LoadWindowsCaptureSettings();
            if (!settings.Enabled || string.IsNullOrWhiteSpace(settings.EndpointId))
                throw new InvalidOperationException("Windows 캡처 장치 설정이 필요합니다.");
            return await Task.Run(
                () => CoreAudioCaptureAdapter.GetMute(settings.EndpointId, cancellationToken),
                cancellationToken);
        }

        var obs = _storage.LoadObsSettings();
        if (!obs.Enabled || string.IsNullOrWhiteSpace(obs.MicrophoneInputName))
            throw new InvalidOperationException("OBS 연결 설정이 필요합니다.");
        return (await ObsActionAdapter.ReadMicrophoneStateAsync(obs, cancellationToken)).InputMuted;
    }

    private static readonly TimeSpan MaxLiveAutomationEventAge = TimeSpan.FromMinutes(2);

    private string DiagnosticUrl()
    {
        var url = _storage.Config.ServerUrl.Trim();
        if (url.EndsWith("/api/collector", StringComparison.OrdinalIgnoreCase))
            return url[..^"/api/collector".Length] + "/api/collector-log";
        return url.TrimEnd('/') + "/log";
    }

    private async Task SendDiagnosticAsync(object payload, bool queueOnFailure)
    {
        var json = JsonSerializer.Serialize(payload);
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, DiagnosticUrl());
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _storage.Config.CollectorToken);
            req.Content = new StringContent(json, Encoding.UTF8, "application/json");
            using var res = await _http.SendAsync(req);
            if (!res.IsSuccessStatusCode && queueOnFailure) _storage.EnqueuePendingDiagnostic(json);
        }
        catch
        {
            if (queueOnFailure) _storage.EnqueuePendingDiagnostic(json);
        }
    }

    private async Task FlushPendingDiagnosticsAsync()
    {
        var pending = _storage.LoadPendingDiagnostics();
        if (pending.Count == 0) return;
        var remain = new List<string>();
        foreach (var json in pending)
        {
            try
            {
                using var req = new HttpRequestMessage(HttpMethod.Post, DiagnosticUrl());
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _storage.Config.CollectorToken);
                req.Content = new StringContent(json, Encoding.UTF8, "application/json");
                using var res = await _http.SendAsync(req);
                if (!res.IsSuccessStatusCode) remain.Add(json);
            }
            catch { remain.Add(json); }
        }
        _storage.ReplacePendingDiagnostics(remain);
    }


    private async Task<CollectorPreflightReport> CreatePreflightAsync()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        return await CollectorPreflightRunner.RunAsync(
            CollectorVersion,
            _storage,
            _vNextDevClient,
            _vNextLocalAgent,
            timeout.Token);
    }

    private async Task ShowPreflightAsync()
    {
        if (_preflightInProgress) return;
        _preflightInProgress = true;
        try
        {
            var report = await CreatePreflightAsync();
            _storage.Log($"방송 준비 사전진단 완료 · state={report.OverallState}");
            MessageBox.Show(
                report.UserSummary(),
                "별록 방송 준비 사전진단",
                MessageBoxButtons.OK,
                report.OverallState == "pass" ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
        }
        catch (Exception ex)
        {
            _storage.Log("방송 준비 사전진단 실패 · type=" + ex.GetType().Name);
            MessageBox.Show(
                "사전진단을 완료하지 못했습니다.\n\n별록 에이전트를 다시 실행한 뒤 반복되면 진단 ZIP을 전달해주세요.",
                "별록 방송 준비 사전진단",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
        finally
        {
            _preflightInProgress = false;
        }
    }

    private async Task ExportDebugAsync()
    {
        if (_preflightInProgress) return;
        var consent = MessageBox.Show(
            "먼저 마이크 상태를 바꾸지 않는 방송 준비 사전진단을 실행하고, 결과와 오류 분석용 로그·상태·규칙·세션 기록을 비식별화해 ZIP에 넣습니다.\n\n" +
            "이메일, 계정 ID, 닉네임, 메시지, 토큰, 후원 UID, URL 경로, OBS 입력명·비밀번호, Agent 장치 ID는 제외하거나 자동 마스킹합니다. 외부에 공개하지 말고 별록 관리자에게만 전달해주세요. 전달 후에는 ZIP을 삭제해주세요.\n\n" +
            "진단 ZIP을 만들까요?",
            "진단 자료 개인정보 안내",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Information,
            MessageBoxDefaultButton.Button2);
        if (consent != DialogResult.Yes) return;

        _preflightInProgress = true;
        try
        {
            var appVersion = Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? BuildInfo.Version;
            var webVersion = _ui.CoreWebView2?.Environment.BrowserVersionString ?? "not-ready";
            var preflight = await CreatePreflightAsync();
            var zip = _storage.ExportDebugZip(appVersion, webVersion, null, preflight);
            _storage.Log("진단 ZIP 생성: " + zip);
            if (MessageBox.Show(
                    preflight.UserSummary() + "\n\n진단 ZIP을 만들었습니다.\n" + zip + "\n\n폴더를 열까요?",
                    "별록 에이전트",
                    MessageBoxButtons.YesNo) == DialogResult.Yes)
            {
                Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{zip}\"") { UseShellExecute = true });
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show("진단 ZIP 생성 실패\n\n" + ex.Message, "별록 에이전트", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            _preflightInProgress = false;
        }
    }

    private static System.Drawing.Drawing2D.GraphicsPath RoundedPath(Rectangle bounds, int radius)
    {
        var path = new System.Drawing.Drawing2D.GraphicsPath();
        var d = Math.Max(2, radius * 2);
        var r = new Rectangle(bounds.X, bounds.Y, Math.Max(1, bounds.Width - 1), Math.Max(1, bounds.Height - 1));
        path.AddArc(r.Left, r.Top, d, d, 180, 90);
        path.AddArc(r.Right - d, r.Top, d, d, 270, 90);
        path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        path.AddArc(r.Left, r.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    private static void ApplyRoundedRegion(Control control, int radius)
    {
        if (control.Width <= 2 || control.Height <= 2) return;
        using var path = RoundedPath(new Rectangle(0, 0, control.Width, control.Height), radius);
        var old = control.Region;
        control.Region = new Region(path);
        old?.Dispose();
    }

    private void SetupRoundedUi(Control root)
    {
        void Walk(Control c)
        {
            int radius = 0;
            if (c is Button) radius = 18;
            else if (c is Panel && Equals(c.Tag, "card")) radius = 18;
            else if (c is Label && Equals(c.Tag, "stat")) radius = 18;

            if (radius > 0)
            {
                ApplyRoundedRegion(c, radius);
                c.Resize += (_, _) => ApplyRoundedRegion(c, radius);
            }
            foreach (Control child in c.Controls) Walk(child);
        }
        Walk(root);
    }

    private void ApplyTheme()
    {
        var bg = _darkMode ? Color.FromArgb(8, 21, 43) : Color.FromArgb(247, 249, 252);
        var surface = _darkMode ? Color.FromArgb(17, 37, 67) : Color.White;
        var surface2 = _darkMode ? Color.FromArgb(24, 48, 82) : Color.FromArgb(246, 248, 252);
        var text = _darkMode ? Color.FromArgb(248, 250, 252) : Color.FromArgb(15, 23, 42);
        var muted = _darkMode ? Color.FromArgb(183, 194, 211) : Color.FromArgb(112, 122, 138);
        var border = _darkMode ? Color.FromArgb(48, 73, 108) : Color.FromArgb(226, 231, 239);
        var accent = Color.FromArgb(251, 190, 55);
        var buttonBg = _darkMode ? Color.FromArgb(22, 44, 76) : Color.White;
        BackColor = bg;
        ForeColor = text;
        ApplyThemeToControl(this, bg, surface, surface2, text, muted, border, accent, buttonBg);
    }

    private void ApplyThemeToControl(Control control, Color bg, Color surface, Color surface2, Color text, Color muted, Color border, Color accent, Color buttonBg)
    {
        if (control is Form form)
        {
            form.BackColor = bg; form.ForeColor = text;
        }
        else if (control is Panel && Equals(control.Tag, "card"))
        {
            control.BackColor = border;
            foreach (Control child in control.Controls) child.BackColor = surface;
        }
        else if (control is TableLayoutPanel or FlowLayoutPanel)
        {
            if (control.Parent is Panel p && Equals(p.Tag, "card")) control.BackColor = surface;
            else control.BackColor = Color.Transparent;
            control.ForeColor = text;
        }
        else if (control is Label label)
        {
            if (Equals(label.Tag, "muted")) label.ForeColor = muted;
            else if (Equals(label.Tag, "stat")) { label.BackColor = surface; label.ForeColor = text; label.BorderStyle = BorderStyle.None; }
            else if (label != _sessionStatus && label != _collectorStatus) label.ForeColor = text;
        }
        else if (control is Button button)
        {
            var isAccentButton = button == _startButton || button == _uploadButton || Equals(button.Tag, "accentButton");
            button.FlatStyle = FlatStyle.Flat;
            button.UseVisualStyleBackColor = false;
            button.FlatAppearance.BorderSize = 1;
            button.FlatAppearance.BorderColor = isAccentButton ? Color.FromArgb(235, 170, 26) : border;
            button.FlatAppearance.MouseOverBackColor = isAccentButton
                ? Color.FromArgb(255, 205, 92)
                : (_darkMode ? Color.FromArgb(31, 57, 92) : Color.FromArgb(248, 250, 253));
            button.FlatAppearance.MouseDownBackColor = isAccentButton
                ? Color.FromArgb(240, 170, 30)
                : (_darkMode ? Color.FromArgb(38, 66, 104) : Color.FromArgb(238, 242, 247));
            button.BackColor = isAccentButton ? accent : buttonBg;
            button.ForeColor = isAccentButton ? Color.FromArgb(29,35,48) : text;
            button.Padding = Equals(button.Tag, "accentButton") ? new Padding(0) : new Padding(10,5,10,5);
            button.Cursor = Cursors.Hand;
        }
        else if (control is GroupBox group)
        {
            group.BackColor = surface; group.ForeColor = text;
        }
        else if (control is NumericUpDown nud)
        {
            nud.BackColor = surface2;
            nud.ForeColor = text;
            nud.BorderStyle = BorderStyle.FixedSingle;
            nud.Font = new Font("맑은 고딕", 10F);
            nud.MinimumSize = new Size(0, 30);
        }
        else if (control is TextBox tb)
        {
            tb.BackColor = surface2;
            tb.ForeColor = text;
            tb.BorderStyle = BorderStyle.FixedSingle;
            tb.Font = new Font("맑은 고딕", 10F);
            tb.MinimumSize = new Size(0, 30);
        }
        else if (control is ListBox lb)
        {
            lb.BackColor = surface; lb.ForeColor = text;
        }
        else if (control is DateTimePicker picker)
        {
            // WinForms DateTimePicker는 다크 테마에서 ForeColor를 안정적으로 반영하지 않습니다.
            // 따라서 입력 필드는 항상 밝은 고대비 표면을 사용해 검정 네이티브 글씨가 선명하게 보이게 합니다.
            picker.BackColor = Color.FromArgb(252, 253, 255);
            picker.ForeColor = Color.FromArgb(15, 23, 42);
            picker.CalendarMonthBackground = Color.White;
            picker.CalendarForeColor = Color.FromArgb(15, 23, 42);
            picker.CalendarTitleBackColor = accent;
            picker.CalendarTitleForeColor = Color.FromArgb(15, 23, 42);
        }
        else if (control is DataGridView grid)
        {
            grid.BackgroundColor = surface;
            grid.BorderStyle = BorderStyle.None;
            grid.CellBorderStyle = DataGridViewCellBorderStyle.SingleHorizontal;
            grid.ColumnHeadersBorderStyle = DataGridViewHeaderBorderStyle.None;
            grid.GridColor = border;
            grid.EnableHeadersVisualStyles = false;
            grid.ColumnHeadersHeight = 42;
            grid.ColumnHeadersHeightSizeMode = DataGridViewColumnHeadersHeightSizeMode.DisableResizing;
            grid.RowTemplate.Height = 42;
            grid.ColumnHeadersDefaultCellStyle.BackColor = surface2;
            grid.ColumnHeadersDefaultCellStyle.ForeColor = muted;
            grid.ColumnHeadersDefaultCellStyle.SelectionBackColor = surface2;
            grid.ColumnHeadersDefaultCellStyle.SelectionForeColor = muted;
            grid.ColumnHeadersDefaultCellStyle.Font = new Font("맑은 고딕", 9.2F, FontStyle.Bold);
            grid.ColumnHeadersDefaultCellStyle.Padding = new Padding(8, 0, 8, 0);
            grid.DefaultCellStyle.BackColor = surface;
            grid.DefaultCellStyle.ForeColor = text;
            grid.DefaultCellStyle.Font = new Font("맑은 고딕", 9.6F);
            grid.DefaultCellStyle.Padding = new Padding(8, 0, 8, 0);
            grid.DefaultCellStyle.SelectionBackColor = _darkMode ? Color.FromArgb(38, 61, 92) : Color.FromArgb(255, 248, 229);
            grid.DefaultCellStyle.SelectionForeColor = text;
        }
        else if (control is ListView lv)
        {
            lv.BackColor = surface;
            lv.ForeColor = text;
            lv.BorderStyle = BorderStyle.None;
            lv.GridLines = false;
            lv.Font = new Font("맑은 고딕", 9.6F);
        }

        foreach (Control child in control.Controls)
            ApplyThemeToControl(child, bg, surface, surface2, text, muted, border, accent, buttonBg);
    }

    private void ApplyThemeToDialog(Form form)
    {
        // 모든 보조 창도 규칙 설정 화면과 동일한 별록 디자인 시스템을 사용합니다.
        var bg = _darkMode ? Color.FromArgb(8, 21, 43) : Color.FromArgb(246, 248, 252);
        var surface = _darkMode ? Color.FromArgb(17, 37, 67) : Color.White;
        var surface2 = _darkMode ? Color.FromArgb(24, 48, 82) : Color.FromArgb(248, 250, 253);
        var text = _darkMode ? Color.FromArgb(248, 250, 252) : Color.FromArgb(15, 23, 42);
        var muted = _darkMode ? Color.FromArgb(177, 191, 211) : Color.FromArgb(100, 116, 139);
        var border = _darkMode ? Color.FromArgb(48, 73, 108) : Color.FromArgb(224, 230, 239);
        var accent = Color.FromArgb(251, 190, 55);
        var buttonBg = _darkMode ? Color.FromArgb(22, 44, 76) : Color.White;
        ApplyThemeToControl(form, bg, surface, surface2, text, muted, border, accent, buttonBg);
        SetupRoundedUi(form);
    }

    private static string ShortDisplay(string? value, int maxLength)
    {
        var normalized = string.IsNullOrWhiteSpace(value) ? "선택 장치" : value.Trim();
        return normalized.Length <= maxLength ? normalized : normalized[..(maxLength - 1)] + "…";
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _automationSettingsForm?.RequestHostShutdown();
            try { _wallpaperEditorForm?.Close(); } catch { }
            _vNextDevClient.SessionChanged -= VNextDevClient_SessionChanged;
            _vNextDevClient.SessionRecoveryChanged -= VNextDevClient_SessionRecoveryChanged;
            _activityMonitor.NotificationReady -= ActivityMonitor_NotificationReady;
            try { _activityMonitor.StopAsync().GetAwaiter().GetResult(); } catch { }
            _activityMonitor.Dispose();
            if (_vNextLocalAgent is not null)
            {
                _vNextLocalAgent.StatusChanged -= VNextLocalAgent_StatusChanged;
                _vNextLocalAgent.Dispose();
            }
            _adaptiveWindow.Dispose();
        }
        base.Dispose(disposing);
    }
}
