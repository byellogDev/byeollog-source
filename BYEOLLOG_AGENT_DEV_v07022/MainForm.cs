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
    private const string CollectorVersion = BuildInfo.Version;
    private static readonly Uri TtsRelayHealthUri = new(
        "https://byeollog-tts-relay.byeollog-tts-relay.workers.dev/healthz");
    private const string ExpectedTtsVoiceVersion = "raffle-winner-cosyvoice3-v1";
    private readonly WebView2 _ui = new();
    private WebView2 _web = new();
    private readonly CollectorStorage _storage;
    private readonly DateTime _programStartedAtLocal;
    private bool _forceStartTimeOnce = true;
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(30) };
    private readonly HttpClient _ttsHealthHttp = new()
    {
        Timeout = TimeSpan.FromSeconds(10),
        MaxResponseContentBufferSize = 16 * 1024
    };
    private readonly VNextDevelopmentClient _vNextDevClient;
    private readonly VNextLocalAgent? _vNextLocalAgent;
    private readonly VNextActivityMonitor _activityMonitor;
    private CoreWebView2Environment? _mainUiWebViewEnvironment;
    private Task<CoreWebView2Environment>? _mainUiWebViewEnvironmentTask;
    private Task? _mainUiInitializationTask;
    private Task? _collectorWebInitializationTask;
    private CoreWebView2Environment? _automationWebViewEnvironment;
    private Task<CoreWebView2Environment>? _automationWebViewEnvironmentTask;
    private VNextAutomationSettingsForm? _automationSettingsForm;
    private bool _automationSettingsOpenOrPending;
    private bool _automationSettingsShowRequested;
    private string _pendingAutomationView = "rules";
    private bool _activityBalloonPending;
    private readonly TimedMuteActionAdapter _timedMuteActions;
    private readonly string _vNextAgentStartupError = "";
    private readonly System.Windows.Forms.Timer _autoUploadTimer = new() { Interval = 2 * 1000 };
    private readonly System.Windows.Forms.Timer _retryUploadTimer = new() { Interval = 60 * 1000 };
    // 신규 자동화 행은 즉시 전송합니다. 이 타이머는 전송 도중 추가된 행을
    // 다음 UI turn에서 빠르게 이어 보내기 위한 짧은 fallback일 뿐입니다.
    private readonly System.Windows.Forms.Timer _vNextDevUploadTimer = new() { Interval = 100 };
    private readonly System.Windows.Forms.Timer _vNextDevRetryTimer = new() { Interval = 60 * 1000 };
    private readonly System.Windows.Forms.Timer _ttsHealthTimer = new() { Interval = 60 * 1000 };
    private bool _uploadInProgress;
    private bool _vNextDevUploadInProgress;
    private bool _vNextDevE2EInProgress;
    private bool _vNextAgentE2EInProgress;
    private bool _vNextObsE2EInProgress;
    private bool _obsTestInProgress;
    private bool _obsMuteCycleInProgress;
    private bool _timedMuteTestInProgress;
    private bool _preflightInProgress;
    private bool _acceptanceInProgress;
    private int _uploadRetryStep;
    private int _vNextDevRetryStep;
    private bool _ttsHealthCheckInProgress;
    private bool _ttsRelayChecked;
    private bool _ttsRelayConnected;
    private DateTime _nextUploadRetryAt = DateTime.MinValue;
    private DateTime _nextVNextDevRetryAt = DateTime.MinValue;

    private readonly Label _weflabStatus = new();
    private readonly Label _collectorStatus = new();
    private readonly Label _sessionStatus = new();
    private readonly Label _lastCheck = new();
    private readonly Label _uploadStatus = new();
    private readonly Label _uploadPending = new();
    private readonly Label _todayDonations = new();
    private readonly Label _todayBalloons = new();
    private readonly Label _todayRoulette = new();
    private readonly ListBox _recent = new();
    private readonly ModernDateTimeField _startDatePicker = new(ModernDateTimeField.FieldKind.Date);
    private readonly ModernDateTimeField _startTimePicker = new(ModernDateTimeField.FieldKind.Time);
    private readonly Button _loginButton = new();
    private readonly Button _startButton = new();
    private readonly Button _browserButton = new();
    private readonly Button _listButton = new();
    private readonly Button _uploadButton = new();
    private readonly Button _serverConnectButton = new();
    private readonly Button _debugButton = new();
    private readonly Button _dummyButton = new();
    private readonly Button _rulesButton = new();
    private readonly Button _settingsButton = new();
    private readonly Button _folderButton = new();
    private readonly Panel _headerPanel = new();
    private readonly HeaderBrandMarkControl _headerBrand = new();
    private readonly HeaderIconButton _minimizeButton = new(HeaderIconButton.IconKind.Minimize);
    private readonly HeaderIconButton _themeButton = new(HeaderIconButton.IconKind.Theme);
    private readonly HeaderIconButton _trayMinimizeButton = new(HeaderIconButton.IconKind.Tray);
    private readonly Button _exitButton = new();
    private readonly NotifyIcon _trayIcon = new();
    private readonly ContextMenuStrip _trayMenu = new();
    private ToolStripMenuItem? _vNextDevStatusItem;
    private ToolStripMenuItem? _vNextAgentStatusItem;
    private ToolStripMenuItem? _obsStatusItem;
    private ToolStripMenuItem? _windowsCaptureStatusItem;
    private TableLayoutPanel? _rootPanel;
    private bool _darkMode;
    private bool _allowExit;
    private bool _trayHintShown;
    private Icon? _appIcon;
    private bool _draggingMain;
    private Point _dragStartCursor;
    private Point _dragStartForm;
    private readonly AdaptiveWindowController _adaptiveWindow;

    private bool _collecting;
    private bool _webReady;
    private bool _uiReady;
    private bool _preserveCollectionDuringCollectorWebInitialization;
    private bool _weflabConnected;
    private bool _weflabLoginNoticeShown;
    private bool _weflabReconnectPending;
    private bool _weflabRecoveryInProgress;
    private readonly WeflabRecoveryDecisionGate _weflabRecoveryGate = new();
    private TaskCompletionSource<bool>? _weflabRecoverySignal;
    private readonly CancellationTokenSource _weflabRecoveryLifetime = new();
    private int _sessionDonationCount;
    private long _sessionBalloonCount;
    private int _sessionRouletteCount;
    private string _lastProbeSignature = "";
    private List<RouletteEventRule> _uiRouletteRules = new();
    private List<FixedRewardRule> _uiFixedRules = new();

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
        _programStartedAtLocal = programStartedAtLocal;
        var interrupted = _storage.Session?.Active == true;
        if (interrupted) _storage.CloseInterruptedSessionOnStartup();
        Text = $"별록 에이전트 v{BuildInfo.DisplayVersion}";
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
        RestoreSessionUi();
        ApplyTheme();
        SetupTray();
        UpdateTrayStatus();
        UpdateUploadUi();
        FormClosing += MainForm_FormClosing;
        _autoUploadTimer.Tick += async (_, _) => { _autoUploadTimer.Stop(); await AutoUploadTickAsync(); };
        _retryUploadTimer.Tick += async (_, _) => await RetryPendingUploadTickAsync();
        _vNextDevUploadTimer.Tick += async (_, _) => { _vNextDevUploadTimer.Stop(); await MirrorVNextDevelopmentAsync(); };
        _vNextDevRetryTimer.Tick += async (_, _) => await MirrorVNextDevelopmentAsync();
        _ttsHealthTimer.Tick += async (_, _) =>
        {
            _ttsHealthTimer.Stop();
            await RefreshTtsRelayHealthAsync();
            if (!IsDisposed && !Disposing) _ttsHealthTimer.Start();
        };
        Shown += async (_, _) =>
        {
            EnsureMainWindowVisible();
            if (_vNextDevClient.IsSignedIn) _vNextLocalAgent?.Start();
            _activityMonitor.Start();
            await InitUiAsync();
            _ttsHealthTimer.Start();
            _ = RefreshTtsRelayHealthAsync();
            await InitWebAsync();
            await RestoreWeflabSessionAsync();
            _retryUploadTimer.Start();
            _vNextDevRetryTimer.Start();
            await FlushPendingDiagnosticsAsync();
            await RetryPendingUploadTickAsync(force: true);
            await MirrorVNextDevelopmentAsync(force: true);
            BeginInvoke(new Action(async () => await PreloadVNextAutomationSettingsAsync()));
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

        var openItem = new ToolStripMenuItem("별록 에이전트 열기");
        openItem.Font = new Font(openItem.Font, FontStyle.Bold);
        openItem.Click += (_, _) => RestoreFromTray();

        var statusItem = new ToolStripMenuItem("상태: 대기 중") { Enabled = false, Name = "trayStatus" };
        _vNextDevStatusItem = new ToolStripMenuItem("별록 계정: 연결 필요") { Enabled = false };
        _vNextAgentStatusItem = new ToolStripMenuItem("별록 액션: 연결 대기") { Enabled = false };
        _obsStatusItem = new ToolStripMenuItem("OBS: 연결 설정 필요") { Enabled = false };
        _windowsCaptureStatusItem = new ToolStripMenuItem("Windows 마이크: 설정 필요") { Enabled = false };
        var exitItem = new ToolStripMenuItem("프로그램 종료");
        exitItem.Click += (_, _) => ExitFromTray();

        var resendItem = new ToolStripMenuItem("대기 데이터 재전송");
        resendItem.Click += async (_, _) => await UploadSessionAsync();

        var dummyItem = new ToolStripMenuItem("테스트 더미 데이터 추가");
        dummyItem.Click += (_, _) => AddDummyDonation();

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

        var acceptanceItem = new ToolStripMenuItem("아봉10초 최종 실기기 검증 (실제 이벤트 1회)");
        acceptanceItem.Enabled = _vNextLocalAgent is not null;
        acceptanceItem.Click += async (_, _) =>
        {
            acceptanceItem.Enabled = false;
            try { await RunAcceptanceEvidenceAsync(); }
            finally { acceptanceItem.Enabled = _vNextLocalAgent is not null; }
        };

        var retryVNextDevItem = new ToolStripMenuItem("뉴별록 전송 재시도");
        retryVNextDevItem.Click += async (_, _) => await MirrorVNextDevelopmentAsync(force: true);

        var reconnectVNextDevItem = new ToolStripMenuItem("별록 액션 연결 상태 확인");
        reconnectVNextDevItem.Click += async (_, _) => await ReconnectVNextDevelopmentAsync();

        var activityItem = new ToolStripMenuItem("자동화 활동 보기");
        activityItem.Click += (_, _) => QueueVNextAutomationSettingsOpen("activity");

        var disconnectVNextDevItem = new ToolStripMenuItem("별록 계정 연결 해제");
        disconnectVNextDevItem.Click += async (_, _) => await DisconnectVNextDevelopmentAsync();

        var e2eVNextDevItem = new ToolStripMenuItem("vNext DEV 전체 경로 테스트 (아봉 10초)");
        e2eVNextDevItem.Click += async (_, _) =>
        {
            e2eVNextDevItem.Enabled = false;
            try { await RunVNextDevelopmentE2ETestAsync(); }
            finally { e2eVNextDevItem.Enabled = true; }
        };

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
        _trayMenu.Items.Add(statusItem);
        _trayMenu.Items.Add(_vNextDevStatusItem);
        _trayMenu.Items.Add(_vNextAgentStatusItem);
        _trayMenu.Items.Add(_obsStatusItem);
        _trayMenu.Items.Add(_windowsCaptureStatusItem);
        _trayMenu.Items.Add(new ToolStripSeparator());
        _trayMenu.Items.Add(disconnectVNextDevItem);
        if (BuildInfo.ShowInternalTesterTools)
        {
            _trayMenu.Items.Add(new ToolStripSeparator());
            _trayMenu.Items.Add(resendItem);
            _trayMenu.Items.Add(retryVNextDevItem);
            _trayMenu.Items.Add(reconnectVNextDevItem);
            _trayMenu.Items.Add(activityItem);
            _trayMenu.Items.Add(e2eVNextDevItem);
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
            _trayMenu.Items.Add(dummyItem);
            _trayMenu.Items.Add(preflightItem);
            _trayMenu.Items.Add(acceptanceItem);
            _trayMenu.Items.Add(diagnosticItem);
        }
        _trayMenu.Items.Add(new ToolStripSeparator());
        _trayMenu.Items.Add(exitItem);

        _trayIcon.Icon = _appIcon ?? SystemIcons.Application;
        _trayIcon.Text = "별록 에이전트";
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

        var message = (_storage.Session?.Active == true || _collecting)
            ? "현재 수집 범위가 활성화되어 있습니다.\n프로그램을 종료하면 자동수집이 멈춥니다.\n\n종료하시겠습니까?"
            : "별록 에이전트를 종료하시겠습니까?";

        var answer = MessageBox.Show(
            message,
            "별록 에이전트 종료",
            MessageBoxButtons.YesNo,
            (_storage.Session?.Active == true || _collecting) ? MessageBoxIcon.Warning : MessageBoxIcon.Question,
            MessageBoxDefaultButton.Button2);
        if (answer != DialogResult.Yes) return;

        if (_storage.Session?.Active == true)
        {
            _storage.EndSession(DateTime.Now);
            _collecting = false;
            _storage.Log("프로그램 종료로 수집 세션 자동 종료");
        }

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

        if (_storage.Session?.Active == true || _collecting)
        {
            var answer = MessageBox.Show(
                "현재 수집 범위가 활성화되어 있습니다.\n\n프로그램을 종료하면 자동수집이 멈춥니다. 정말 종료할까요?",
                "별록 에이전트 종료",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Warning,
                MessageBoxDefaultButton.Button2);
            if (answer != DialogResult.Yes) return;
        }

        if (_storage.Session?.Active == true)
        {
            _storage.EndSession(DateTime.Now);
            _collecting = false;
            _storage.Log("프로그램 종료로 수집 세션 자동 종료");
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
        var text = _storage.Session?.Active == true
            ? (_collecting ? "상태: 자동수집 중" : "상태: 수집 범위 설정됨")
            : "상태: 대기 중";

        if (_trayMenu.Items["trayStatus"] is ToolStripMenuItem statusItem)
            statusItem.Text = text;

        var session = _storage.Session;
        var vNextPending = session is null ? 0 : _storage.PendingVNextDevelopmentCount(session.Id);
        if (_vNextDevStatusItem is not null)
        {
            var connection = _vNextDevClient.SessionRecoveryState switch
            {
                "recovering" => "자동 복구 중",
                "retrying" => "재연결 대기",
                "attention" => "재로그인 필요",
                _ => _vNextDevClient.IsSignedIn ? "연결됨" : "연결 필요"
            };
            _vNextDevStatusItem.Text = $"별록 계정: {connection} · 대기 {vNextPending:N0}건";
        }

        if (_vNextAgentStatusItem is not null)
        {
            if (_vNextLocalAgent is null)
            {
                _vNextAgentStatusItem.Text = "별록 액션: 사용 불가";
                _vNextAgentStatusItem.ToolTipText = _vNextAgentStartupError;
            }
            else if (!_vNextDevClient.IsSignedIn)
            {
                _vNextAgentStatusItem.Text = "별록 액션: 계정 연결 필요";
                _vNextAgentStatusItem.ToolTipText = "별록 액션에서 계정을 연결하면 자동으로 시작됩니다.";
            }
            else
            {
                var agent = _vNextLocalAgent.Status;
                _vNextAgentStatusItem.Text =
                    $"별록 액션: {agent.State} · ACK {agent.PendingAcks:N0} · 확인 {agent.Uncertain:N0}";
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
        try { BeginInvoke(new Action(UpdateTrayStatus)); } catch { }
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

        ConfigureCollectorWebControl(_web, shellBackground);
        Controls.Add(_web);
        _ui.BringToFront();
    }

    private void ConfigureCollectorWebControl(WebView2 control, Color shellBackground)
    {
        control.Dock = DockStyle.Fill;
        control.DefaultBackgroundColor = shellBackground;
        control.Visible = false;
        control.NavigationCompleted += CollectorWeb_NavigationCompleted;
    }

    private async void CollectorWeb_NavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (!e.IsSuccess)
        {
            _storage.Log($"페이지 이동 실패: {e.WebErrorStatus}");
            SetWeflabConnection(false);
            return;
        }
        await InjectLoginProbeAsync();
        if (_collecting) await InjectCollectorAsync();
    }

    // v0.4.6.8의 네이티브 UI는 기능 회귀 비교를 위해 소스에 보존합니다.
    // 실제 배포 화면은 위 BuildUi의 HTML/CSS 셸을 사용합니다.
    private void BuildLegacyUi()
    {
        // 고정형 컴팩트 레이아웃: 각 영역의 높이를 명시해서
        // DPI/폰트 크기에 따라 특정 버튼만 커지거나 사라지는 현상을 막습니다.
        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(18, 24, 18, 16),
            ColumnCount = 1,
            RowCount = 5,
            AutoScroll = false,
            GrowStyle = TableLayoutPanelGrowStyle.FixedSize,
        };
        _rootPanel = root;
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 104));  // header
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 190));  // status
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 124));  // start
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 84));   // stats
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 144));  // actions
        Controls.Add(root);

        // ── 자체 헤더
        // 상단은 이미지/PictureBox/글꼴 glyph에 의존하지 않고 직접 그리는 컨트롤만 사용합니다.
        // 따라서 DPI 배율과 폰트 렌더링에 관계없이 로고와 우상단 기능 버튼이 같은 크기로 유지됩니다.
        var header = _headerPanel;
        header.Dock = DockStyle.Fill;
        header.Margin = new Padding(0, 0, 0, 10);
        header.Padding = new Padding(0);
        header.BackColor = _darkMode ? Color.FromArgb(8, 21, 43) : Color.White;

        var compactBrand = _headerBrand;
        compactBrand.Location = new Point(6, 12);
        compactBrand.Size = new Size(112, 68);
        compactBrand.Anchor = AnchorStyles.Left | AnchorStyles.Top;
        header.Controls.Add(compactBrand);

        var titleLabel = new Label
        {
            Text = "별록 에이전트",
            Font = new Font("맑은 고딕", 21F, FontStyle.Bold),
            AutoSize = false,
            Location = new Point(126, 11),
            Size = new Size(360, 70),
            TextAlign = ContentAlignment.MiddleLeft,
            Margin = new Padding(0),
            BackColor = Color.Transparent,
        };
        header.Controls.Add(titleLabel);

        void BeginWindowDrag(object? _, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;
            _draggingMain = true;
            _dragStartCursor = Cursor.Position;
            _dragStartForm = Location;
        }
        void MoveWindowDrag(object? _, MouseEventArgs e)
        {
            if (!_draggingMain || e.Button != MouseButtons.Left) return;
            var delta = new Point(Cursor.Position.X - _dragStartCursor.X, Cursor.Position.Y - _dragStartCursor.Y);
            Location = new Point(_dragStartForm.X + delta.X, _dragStartForm.Y + delta.Y);
        }
        void EndWindowDrag(object? _, MouseEventArgs e) => _draggingMain = false;

        // 폼 최상단 여백까지 포함해서 드래그 가능하게 합니다.
        // 기존에는 header/로고/타이틀에만 이벤트가 붙어 root의 top padding 영역은 드래그되지 않았습니다.
        foreach (Control c in new Control[] { this, root, header, compactBrand, titleLabel })
        {
            c.MouseDown += BeginWindowDrag;
            c.MouseMove += MoveWindowDrag;
            c.MouseUp += EndWindowDrag;
        }

        void PlaceHeaderButton(HeaderIconButton button, int rightOffset, string tooltip, EventHandler action)
        {
            button.Size = new Size(50, 50);
            button.Location = new Point(header.Width - rightOffset, 21);
            button.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            button.Click += action;
            new ToolTip().SetToolTip(button, tooltip);
            header.Controls.Add(button);
            button.BringToFront();
        }

        PlaceHeaderButton(_minimizeButton, 166, "작업 표시줄로 최소화",
            (_, _) => WindowState = FormWindowState.Minimized);

        PlaceHeaderButton(_themeButton, 108, "다크/화이트 모드 전환",
            (_, _) =>
            {
                _darkMode = !_darkMode;
                _storage.SaveTheme(_darkMode ? "dark" : "light");
                ApplyTheme();
                UpdateUploadUi();
            });

        PlaceHeaderButton(_trayMinimizeButton, 50, "트레이로 최소화",
            (_, _) => HideToTray());

        root.Controls.Add(header, 0, 0);

        // ── 상태 카드
        var statusCard = CreateCard();
        statusCard.Dock = DockStyle.Fill;
        statusCard.AutoSize = false;
        statusCard.Margin = new Padding(0, 0, 0, 10);

        var status = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            RowCount = 6,
            Padding = new Padding(16, 10, 16, 10),
            Margin = new Padding(0),
        };
        status.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 126));
        status.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        for (var i = 0; i < 6; i++) status.RowStyles.Add(new RowStyle(SizeType.Percent, 16.666F));

        AddStatusRow(status, 0, "Weflab", _weflabStatus, "● 연결 필요");
        AddStatusRow(status, 1, "수집 범위", _sessionStatus, "● 대기");
        AddStatusRow(status, 2, "자동수집", _collectorStatus, "● OFF");
        AddStatusRow(status, 3, "자동 업로드", _uploadStatus, "● 동작 중");
        AddStatusRow(status, 4, "업로드 대기", _uploadPending, "0건");
        AddStatusRow(status, 5, "마지막 전송", _lastCheck, "-");

        statusCard.Controls.Add(status);
        root.Controls.Add(statusCard, 0, 1);

        // ── 수집 시작 카드
        var sessionCard = CreateCard();
        sessionCard.Dock = DockStyle.Fill;
        sessionCard.AutoSize = false;
        sessionCard.Margin = new Padding(0, 0, 0, 10);

        var sessionBox = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 2,
            Padding = new Padding(16, 10, 16, 12),
            Margin = new Padding(0),
        };
        sessionBox.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
        sessionBox.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

        sessionBox.Controls.Add(new Label
        {
            Text = "수집 시작 시각",
            AutoSize = false,
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleLeft,
            Font = new Font(Font.FontFamily, 10F, FontStyle.Bold),
            Margin = new Padding(0),
        }, 0, 0);

        var inputRow = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 3,
            RowCount = 1,
            Margin = new Padding(0),
            Padding = new Padding(0),
            Tag = "sessionInputRow",
        };
        inputRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 235));
        inputRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 150));
        inputRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        inputRow.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

        _startDatePicker.Dock = DockStyle.Fill;
        _startDatePicker.Margin = new Padding(0, 5, 10, 5);

        _startTimePicker.Dock = DockStyle.Fill;
        _startTimePicker.Margin = new Padding(0, 5, 10, 5);

        _startButton.Text = "▶ 수집 시작";
        _startButton.Dock = DockStyle.Fill;
        _startButton.AutoSize = false;
        _startButton.Margin = new Padding(0, 5, 0, 5);
        _startButton.Padding = new Padding(0);
        _startButton.TextAlign = ContentAlignment.MiddleCenter;
        _startButton.Font = new Font(Font.FontFamily, 10.5F, FontStyle.Bold);
        _startButton.Tag = "accentButton";
        _startButton.Click += async (_, _) =>
        {
            if (_collecting || _storage.Session?.Active == true)
                await EndBroadcastSessionAsync();
            else
                await StartBroadcastSessionAsync();
        };

        inputRow.Controls.Add(_startDatePicker, 0, 0);
        inputRow.Controls.Add(_startTimePicker, 1, 0);
        inputRow.Controls.Add(_startButton, 2, 0);
        sessionBox.Controls.Add(inputRow, 0, 1);
        sessionCard.Controls.Add(sessionBox);
        root.Controls.Add(sessionCard, 0, 2);

        // ── 요약 3칸
        var stats = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 3,
            RowCount = 1,
            Margin = new Padding(0, 0, 0, 10),
            Padding = new Padding(0),
        };
        for (var i = 0; i < 3; i++) stats.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33.333F));
        stats.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

        _todayDonations.Text = "이번 수집 후원\n0건";
        _todayBalloons.Text = "이번 수집 별풍선\n0개";
        _todayRoulette.Text = "룰렛 포함\n0건";
        foreach (var label in new[] { _todayDonations, _todayBalloons, _todayRoulette })
        {
            label.AutoSize = false;
            label.Dock = DockStyle.Fill;
            label.TextAlign = ContentAlignment.MiddleCenter;
            label.Font = new Font(Font.FontFamily, 10.2F, FontStyle.Bold);
            label.Margin = new Padding(4);
            label.Tag = "stat";
        }
        stats.Controls.Add(_todayDonations, 0, 0);
        stats.Controls.Add(_todayBalloons, 1, 0);
        stats.Controls.Add(_todayRoulette, 2, 0);
        root.Controls.Add(stats, 0, 3);

        // ── 하단 6개 기능 버튼: 3열 × 2행, 모든 셀/버튼 크기 동일
        var actionCard = CreateCard();
        actionCard.Dock = DockStyle.Fill;
        actionCard.AutoSize = false;
        actionCard.Margin = new Padding(0);
        var actionWrap = new Panel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(12),
            Margin = new Padding(0),
        };
        var actions = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 3,
            RowCount = 2,
            Margin = new Padding(0),
            Padding = new Padding(0),
            GrowStyle = TableLayoutPanelGrowStyle.FixedSize,
        };
        for (var i = 0; i < 3; i++) actions.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33.333F));
        actions.RowStyles.Add(new RowStyle(SizeType.Percent, 50));
        actions.RowStyles.Add(new RowStyle(SizeType.Percent, 50));

        void SetupActionButton(Button button, string label)
        {
            button.Text = label;
            button.AutoSize = false;
            button.Dock = DockStyle.Fill;
            button.Margin = new Padding(4);
            button.MinimumSize = Size.Empty;
            button.MaximumSize = Size.Empty;
            button.Padding = new Padding(2);
            button.Font = new Font(Font.FontFamily, 9.2F, FontStyle.Bold);
            button.TextAlign = ContentAlignment.MiddleCenter;
            button.AutoEllipsis = false;
            button.Tag = "equalAction";
        }

        SetupActionButton(_loginButton, "↗  위플랩 로그인");
        _loginButton.Click += async (_, _) => await OpenWeflabAsync(true);

        SetupActionButton(_listButton, "☷  수집 목록 보기");
        _listButton.Click += (_, _) => ShowSessionList();

        SetupActionButton(_rulesButton, "⚙  룰렛 설정");
        _rulesButton.Click += (_, _) => ShowRouletteSettings();

        SetupActionButton(_debugButton, "⏻  끝내기");
        _debugButton.Click += (_, _) => ExitFromMain();

        SetupActionButton(_dummyButton, "⚗  더미 추가 (TEST)");
        _dummyButton.Click += (_, _) => AddDummyDonation();

        SetupActionButton(_browserButton, "↗  대시보드");
        _browserButton.Click += async (_, _) =>
        {
            _browserButton.Enabled = false;
            try
            {
                if (string.IsNullOrWhiteSpace(_storage.Config.CollectorToken))
                    throw new Exception("별록 에이전트 기기 인증 정보가 없습니다. 프로그램을 다시 로그인해주세요.");

                var baseUrl = _storage.Config.ServerUrl.Trim().TrimEnd('/');
                if (baseUrl.EndsWith("/api/collector", StringComparison.OrdinalIgnoreCase))
                    baseUrl = baseUrl[..^"/api/collector".Length];

                var json = JsonSerializer.Serialize(new
                {
                    mode = "dashboard_handoff",
                    collector_version = CollectorVersion
                });
                using var req = new HttpRequestMessage(HttpMethod.Post, baseUrl + "/api/collector-pair");
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _storage.Config.CollectorToken);
                req.Content = new StringContent(json, Encoding.UTF8, "application/json");
                using var res = await _http.SendAsync(req);
                var responseText = await res.Content.ReadAsStringAsync();
                if (!res.IsSuccessStatusCode)
                {
                    try
                    {
                        using var error = JsonDocument.Parse(responseText);
                        if (error.RootElement.TryGetProperty("message", out var message))
                            throw new Exception(message.GetString() ?? "대시보드 로그인 링크 발급에 실패했습니다.");
                    }
                    catch (JsonException) { }
                    throw new Exception("대시보드 로그인 링크 발급에 실패했습니다.");
                }

                using var doc = JsonDocument.Parse(responseText);
                var dashboardPath = doc.RootElement.GetProperty("dashboard_url").GetString() ?? "";
                if (string.IsNullOrWhiteSpace(dashboardPath))
                    throw new Exception("서버에서 대시보드 주소를 받지 못했습니다.");
                if (!WebViewTrustPolicy.TryResolveSameOriginExternalUri(
                        baseUrl.TrimEnd('/') + "/",
                        dashboardPath,
                        out var dashboardUrl,
                        out _))
                    throw new Exception("서버가 허용되지 않은 대시보드 주소를 반환했습니다.");

                Process.Start(new ProcessStartInfo
                {
                    FileName = dashboardUrl.AbsoluteUri,
                    UseShellExecute = true
                });
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "대시보드를 열지 못했습니다.\n\n" + ex.Message,
                    "별록 에이전트",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            }
            finally
            {
                _browserButton.Enabled = true;
            }
        };

        actions.Controls.Add(_loginButton, 0, 0);
        actions.Controls.Add(_listButton, 1, 0);
        actions.Controls.Add(_rulesButton, 2, 0);
        actions.Controls.Add(_browserButton, 0, 1);
        actions.Controls.Add(_dummyButton, 1, 1);
        actions.Controls.Add(_debugButton, 2, 1);

        actionWrap.Controls.Add(actions);
        actionCard.Controls.Add(actionWrap);
        root.Controls.Add(actionCard, 0, 4);

        _web.Dock = DockStyle.Fill;
        _web.Visible = false;
        _web.NavigationCompleted += async (_, e) =>
        {
            if (!e.IsSuccess)
            {
                _storage.Log($"페이지 이동 실패: {e.WebErrorStatus}");
                SetWeflabConnection(false);
                return;
            }
            await InjectLoginProbeAsync();
            if (_collecting) await InjectCollectorAsync();
        };
        Controls.Add(_web);
        _web.BringToFront();
    }

    private Panel CreateCard()
    {
        return new Panel { Dock = DockStyle.Top, AutoSize = true, Padding = new Padding(1), Margin = new Padding(0,0,0,12), Tag = "card" };
    }

    private static void AddStatusRow(TableLayoutPanel p, int row, string name, Label target, string value)
    {
        var nameLabel = new Label
        {
            Text = name,
            AutoSize = false,
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleLeft,
            Font = new Font("맑은 고딕", 10F, FontStyle.Bold),
            Margin = new Padding(0),
        };
        p.Controls.Add(nameLabel, 0, row);

        target.Text = value;
        target.AutoSize = false;
        target.Dock = DockStyle.Fill;
        target.TextAlign = ContentAlignment.MiddleLeft;
        target.Font = new Font("맑은 고딕", 10.1F, FontStyle.Regular);
        target.Margin = new Padding(0);
        p.Controls.Add(target, 1, row);
    }

    private void RestoreSessionUi()
    {
        var s = _storage.Session;
        if (s is null) { SetStartPickers(_programStartedAtLocal); _forceStartTimeOnce = true; NotifyMainUi(); return; }
        SetStartPickers(s.StartLocal);
        RefreshSessionStats();
        if (s.Active)
        {
            _sessionStatus.Text = $"● 수집 범위 설정됨 · {s.StartLocal:MM-dd HH:mm}~"; _sessionStatus.ForeColor = _darkMode ? Color.FromArgb(91, 226, 147) : Color.FromArgb(31, 143, 82);
            _collectorStatus.Text = "● OFF"; _collectorStatus.ForeColor = (_darkMode ? Color.FromArgb(248, 250, 252) : Color.FromArgb(15, 23, 42));
            _startButton.Enabled = true; SetStartPickersEnabled(true); UpdateCollectionActionButton();
        }
        else
        {
            _sessionStatus.Text = $"● 수집 완료 · {s.StartLocal:MM-dd HH:mm}~{s.EndLocal:MM-dd HH:mm}"; _sessionStatus.ForeColor = (_darkMode ? Color.FromArgb(248, 250, 252) : Color.FromArgb(15, 23, 42));
            // 이전 완료 세션은 제목/통계에 유지하되 새 수집 입력값은
            // 이번 프로그램 실행 시각을 기본값으로 사용합니다.
            SetStartPickers(_programStartedAtLocal);
            _forceStartTimeOnce = true;
        }
        NotifyMainUi();
    }


    private DateTime GetSelectedStartLocal()
    {
        var d = _startDatePicker.Value;
        var t = _startTimePicker.Value;
        return new DateTime(d.Year, d.Month, d.Day, t.Hour, t.Minute, 0, DateTimeKind.Local);
    }

    private void SetStartPickers(DateTime value)
    {
        _startDatePicker.Value = value;
        _startTimePicker.Value = value;
    }

    private void SetStartPickersEnabled(bool enabled)
    {
        _startDatePicker.Enabled = enabled;
        _startTimePicker.Enabled = enabled;
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
                case "startTimeChanged":
                    {
                        var d = payload.TryGetProperty("date", out var de) ? de.GetString() ?? "" : "";
                        var tm = payload.TryGetProperty("time", out var te) ? te.GetString() ?? "" : "";
                        if (DateTime.TryParse($"{d} {tm}", out var picked))
                            SetStartPickers(DateTime.SpecifyKind(picked, DateTimeKind.Local));
                    }
                    break;
                case "toggleCollection":
                    if (_collecting || _storage.Session?.Active == true)
                    {
                        await EndBroadcastSessionAsync();
                    }
                    else
                    {
                        var date = payload.TryGetProperty("date", out var dateElement) ? dateElement.GetString() ?? "" : "";
                        var time = payload.TryGetProperty("time", out var timeElement) ? timeElement.GetString() ?? "" : "";
                        if (!DateTime.TryParse($"{date} {time}", out var selected))
                        {
                            await ShowUiToastAsync("수집 시작 날짜와 시간을 확인해주세요.");
                            break;
                        }
                        SetStartPickers(DateTime.SpecifyKind(selected, DateTimeKind.Local));
                        await StartBroadcastSessionAsync();
                    }
                    await PushMainStateAsync();
                    break;
                case "openWeflab":
                    await OpenWeflabAsync(true);
                    break;
                case "dashboard":
                    await OpenDashboardAsync();
                    break;
                case "openAutomationSettings":
                    QueueVNextAutomationSettingsOpen();
                    return;
                case "screen":
                    var screen = payload.TryGetProperty("screen", out var screenElement) ? screenElement.GetString() ?? "" : "";
                    if (screen == "collection") await PushCollectionAsync();
                    if (screen == "rules")
                    {
                        LoadRulesForUi();
                        await PushRulesAsync();
                    }
                    break;
                case "refreshCollection":
                    await PushCollectionAsync();
                    await ShowUiToastAsync("수집 목록을 새로고침했습니다.");
                    break;
                case "upsertRoulette":
                    await UpsertRouletteFromUiAsync(payload);
                    break;
                case "deleteRoulette":
                    await DeleteRouletteFromUiAsync(payload);
                    break;
                case "upsertFixed":
                    await UpsertFixedFromUiAsync(payload);
                    break;
                case "deleteFixed":
                    await DeleteFixedFromUiAsync(payload);
                    break;
                case "saveRules":
                    await SaveRulesFromUiAsync();
                    break;
                case "cancelRules":
                    LoadRulesForUi();
                    await PushRulesAsync();
                    await ShowUiToastAsync("저장하지 않은 변경을 취소했습니다.");
                    break;
            }
        }
        catch (Exception ex)
        {
            _storage.Log("UI 메시지 처리 실패: " + ex);
            await ShowUiToastAsync("요청을 처리하지 못했습니다: " + ex.Message);
        }
    }

    private async Task OpenDashboardAsync()
    {
        try
        {
            if (string.IsNullOrWhiteSpace(_storage.Config.CollectorToken))
                throw new Exception("별록 에이전트 기기 인증 정보가 없습니다. 프로그램을 다시 로그인해주세요.");

            var baseUrl = _storage.Config.ServerUrl.Trim().TrimEnd('/');
            if (baseUrl.EndsWith("/api/collector", StringComparison.OrdinalIgnoreCase))
                baseUrl = baseUrl[..^"/api/collector".Length];

            var json = JsonSerializer.Serialize(new
            {
                mode = "dashboard_handoff",
                collector_version = CollectorVersion
            });
            using var request = new HttpRequestMessage(HttpMethod.Post, baseUrl + "/api/collector-pair");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _storage.Config.CollectorToken);
            request.Content = new StringContent(json, Encoding.UTF8, "application/json");
            using var response = await _http.SendAsync(request);
            var responseText = await response.Content.ReadAsStringAsync();
            if (!response.IsSuccessStatusCode)
            {
                try
                {
                    using var error = JsonDocument.Parse(responseText);
                    if (error.RootElement.TryGetProperty("message", out var message))
                        throw new Exception(message.GetString() ?? "대시보드 로그인 링크 발급에 실패했습니다.");
                }
                catch (JsonException) { }
                throw new Exception("대시보드 로그인 링크 발급에 실패했습니다.");
            }

            using var document = JsonDocument.Parse(responseText);
            var path = document.RootElement.GetProperty("dashboard_url").GetString() ?? "";
            if (string.IsNullOrWhiteSpace(path))
                throw new Exception("서버에서 대시보드 주소를 받지 못했습니다.");
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
    }

    private void QueueVNextAutomationSettingsOpen(string targetView = "rules")
    {
        // 메인 WebView2 콜백이 반환된 뒤 같은 메인 창 안에 자동화 화면을 올립니다.
        // 별도 모달 창과 중첩 메시지 루프를 만들지 않습니다.
        if (IsDisposed || Disposing || !IsHandleCreated) return;
        _pendingAutomationView = targetView is "rules" or "readiness" or "devices" or "overlays" or "activity"
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
        if (IsDisposed || Disposing || _automationSettingsOpenOrPending) return;
        var form = _automationSettingsForm;
        if (form is not null && !form.IsDisposed && !form.Disposing) return;
        _automationSettingsOpenOrPending = true;
        _automationSettingsShowRequested = false;
        await ShowVNextAutomationSettingsAsync(display: false);
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
        var session = _storage.Session;
        var active = _collecting || session?.Active == true;
        var selected = GetSelectedStartLocal();
        var pending = session is null ? 0 : _storage.PendingUploadCount(session.Id);
        var vNextDevPending = session is null ? 0 : _storage.PendingVNextDevelopmentCount(session.Id);

        string sessionTitle;
        string sessionDescription;
        if (active)
        {
            sessionTitle = "별풍선을 수집하고 있어요";
            sessionDescription = _vNextDevClient.IsSignedIn
                ? "새 데이터는 운영 서버와 뉴별록 자동화로 안전하게 전송됩니다."
                : "새 데이터는 기존 운영 서버로 안전하게 전송됩니다. 뉴별록 연결은 선택 사항입니다.";
        }
        else if (session?.EndLocal is not null)
        {
            sessionTitle = $"수집 완료 · {session.StartLocal:MM-dd HH:mm}~{session.EndLocal:MM-dd HH:mm}";
            sessionDescription = "새 수집을 시작하려면 방송 시작 시각을 지정하세요.";
        }
        else
        {
            sessionTitle = "수집 준비가 완료됐어요";
            sessionDescription = "방송을 시작한 시각을 지정한 뒤 수집을 시작하세요.";
        }

        var uploadText = (_uploadStatus.Text ?? "").Replace("●", "").Trim();
        if (uploadText == "동작 중") uploadText = "정상 동작 중";
        if (string.IsNullOrWhiteSpace(uploadText)) uploadText = "정상 동작 중";

        await ExecuteUiAsync("setMainState", new
        {
            streamerName = _storage.StreamerName,
            collecting = active,
            sessionTitle,
            sessionDesc = sessionDescription,
            startDate = selected.ToString("yyyy-MM-dd"),
            startTime = selected.ToString("HH:mm"),
            forceStartTime = _forceStartTimeOnce,
            releaseLabel = BuildInfo.DisplayVersion,
            developmentMode = true,
            developmentConnected = _vNextDevClient.IsSignedIn,
            developmentRecoveryState = _vNextDevClient.SessionRecoveryState,
            developmentPending = vNextDevPending,
            weflabConnected = _weflabConnected,
            weflabRecovering = _weflabRecoveryInProgress,
            uploadStatus = uploadText,
            pending,
            serverConnected = _storage.HasServerCredential,
            ttsRelayChecked = _ttsRelayChecked,
            ttsRelayConnected = _ttsRelayConnected,
            donations = _sessionDonationCount,
            balloons = _sessionBalloonCount,
            roulette = _sessionRouletteCount,
            lastTransfer = string.IsNullOrWhiteSpace(_lastCheck.Text) ? "없음" : _lastCheck.Text
        });
        _forceStartTimeOnce = false;
    }

    private async Task RefreshTtsRelayHealthAsync()
    {
        if (_ttsHealthCheckInProgress || IsDisposed || Disposing) return;
        _ttsHealthCheckInProgress = true;

        var connected = false;
        try
        {
            using var response = await _ttsHealthHttp.GetAsync(TtsRelayHealthUri);
            response.EnsureSuccessStatusCode();
            if (!string.Equals(
                    response.Content.Headers.ContentType?.MediaType,
                    "application/json",
                    StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException("TTS relay health response is not JSON.");
            }

            await using var responseStream = await response.Content.ReadAsStreamAsync();
            using var document = await JsonDocument.ParseAsync(responseStream);
            var root = document.RootElement;
            connected = root.ValueKind == JsonValueKind.Object &&
                        root.TryGetProperty("healthy", out var healthy) &&
                        healthy.ValueKind == JsonValueKind.True &&
                        root.TryGetProperty("version", out var version) &&
                        version.ValueKind == JsonValueKind.String &&
                        string.Equals(
                            version.GetString(),
                            ExpectedTtsVoiceVersion,
                            StringComparison.Ordinal);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or
                                   JsonException or InvalidDataException or ObjectDisposedException)
        {
            connected = false;
        }
        finally
        {
            var changed = !_ttsRelayChecked || _ttsRelayConnected != connected;
            _ttsRelayChecked = true;
            _ttsRelayConnected = connected;
            _ttsHealthCheckInProgress = false;
            if (changed && !IsDisposed && !Disposing) await PushMainStateAsync();
        }
    }

    private async Task PushCollectionAsync()
    {
        var session = _storage.Session;
        if (session is null)
        {
            await ExecuteUiAsync("setCollection", new { range = "수집 세션 없음", total = 0, normal = 0, issues = 0, items = Array.Empty<object>() });
            return;
        }

        var rules = _storage.LoadSessionRules(session.Id)
            .GroupBy(rule => rule.Balloons)
            .ToDictionary(group => group.Key, group => group.Last());
        var rows = _storage.LoadSessionRows(session.Id);
        var items = rows
            .OrderByDescending(row => GetOccurredLocal(row) ?? DateTime.MinValue)
            .Select(row =>
            {
                var when = GetString(row, "create_time");
                if (string.IsNullOrWhiteSpace(when)) when = GetString(row, "time");
                var amount = GetAmount(row);
                var actual = GetRouletteResults(row).Count;
                rules.TryGetValue(amount, out var rule);
                var normal = rule is not null && actual == rule.ExpectedSpins;
                var status = rule is null ? "일반후원" : normal ? "정상" : actual < rule.ExpectedSpins ? "부족" : "초과";
                var roulette = rule is null ? (actual > 0 ? actual.ToString() : "-") : $"{actual} / {rule.ExpectedSpins}";
                return new
                {
                    time = when,
                    name = GetString(row, "name"),
                    id = GetString(row, "id"),
                    balloons = amount,
                    @event = rule?.EventName ?? "-",
                    roulette,
                    status,
                    normal,
                    result = string.Join(" + ", GetRouletteResults(row).Select(result => result.Result))
                };
            })
            .ToList();
        var normalCount = items.Count(item => item.normal);
        var end = session.EndLocal.HasValue ? session.EndLocal.Value.ToString("MM-dd HH:mm") : "현재";
        await ExecuteUiAsync("setCollection", new
        {
            range = $"{session.StartLocal:MM-dd HH:mm} — {end}",
            total = items.Count,
            normal = normalCount,
            issues = items.Count - normalCount,
            items
        });
    }

    private void LoadRulesForUi()
    {
        var session = _storage.Session;
        var isLive = session?.Active == true;
        _uiRouletteRules = (isLive ? _storage.LoadSessionRules(session!.Id) : _storage.LoadDraftRules())
            .OrderBy(rule => rule.Balloons)
            .ToList();
        _uiFixedRules = (isLive ? _storage.LoadSessionFixedRules(session!.Id) : _storage.LoadDraftFixedRules())
            .OrderBy(rule => rule.Balloons)
            .ThenBy(rule => rule.EventName)
            .ThenBy(rule => rule.UpboType)
            .ToList();
    }

    private Task PushRulesAsync()
    {
        var roulette = _uiRouletteRules.Select(rule => new { balloons = rule.Balloons, spins = rule.ExpectedSpins, eventName = rule.EventName });
        var fixedRules = _uiFixedRules.Select(rule => new { balloons = rule.Balloons, eventName = rule.EventName, upboType = rule.UpboType, quantity = rule.Quantity });
        return ExecuteUiAsync("setRules", new { roulette, @fixed = fixedRules, isLive = _storage.Session?.Active == true });
    }

    private async Task UpsertRouletteFromUiAsync(JsonElement payload)
    {
        var balloons = payload.TryGetProperty("balloons", out var balloonsElement) && balloonsElement.TryGetInt64(out var parsedBalloons) ? parsedBalloons : 0;
        var spins = payload.TryGetProperty("spins", out var spinsElement) && spinsElement.TryGetInt32(out var parsedSpins) ? parsedSpins : 0;
        var eventName = payload.TryGetProperty("eventName", out var eventElement) ? eventElement.GetString()?.Trim() ?? "" : "";
        long? oldBalloons = payload.TryGetProperty("oldBalloons", out var oldElement) && oldElement.ValueKind == JsonValueKind.Number && oldElement.TryGetInt64(out var parsedOld) ? parsedOld : null;
        if (balloons <= 0 || spins <= 0 || string.IsNullOrWhiteSpace(eventName))
        {
            await ShowUiToastAsync("별풍선, 룰렛 횟수, 이벤트명을 모두 입력해주세요.");
            return;
        }
        if (_uiRouletteRules.Any(rule => rule.Balloons == balloons && (!oldBalloons.HasValue || rule.Balloons != oldBalloons.Value)))
        {
            await ShowUiToastAsync("같은 별풍선 금액의 룰렛 규칙이 이미 있습니다.");
            return;
        }
        if (oldBalloons.HasValue) _uiRouletteRules.RemoveAll(rule => rule.Balloons == oldBalloons.Value);
        _uiRouletteRules.Add(new RouletteEventRule(balloons, spins, eventName));
        _uiRouletteRules = _uiRouletteRules.OrderBy(rule => rule.Balloons).ToList();
        await PushRulesAsync();
        await ShowUiToastAsync(oldBalloons.HasValue ? "룰렛 규칙을 수정했습니다." : "룰렛 규칙을 추가했습니다.");
    }

    private async Task DeleteRouletteFromUiAsync(JsonElement payload)
    {
        var balloons = payload.TryGetProperty("balloons", out var element) && element.TryGetInt64(out var parsed) ? parsed : 0;
        _uiRouletteRules.RemoveAll(rule => rule.Balloons == balloons);
        await PushRulesAsync();
        await ShowUiToastAsync("룰렛 규칙을 삭제했습니다.");
    }

    private async Task UpsertFixedFromUiAsync(JsonElement payload)
    {
        var balloons = payload.TryGetProperty("balloons", out var balloonsElement) && balloonsElement.TryGetInt64(out var parsedBalloons) ? parsedBalloons : 0;
        var eventName = payload.TryGetProperty("eventName", out var eventElement) ? eventElement.GetString()?.Trim() ?? "" : "";
        var upboType = payload.TryGetProperty("upboType", out var typeElement) ? typeElement.GetString()?.Trim() ?? "" : "";
        var quantity = payload.TryGetProperty("quantity", out var quantityElement) && quantityElement.TryGetInt32(out var parsedQuantity) ? parsedQuantity : 0;
        var oldKey = payload.TryGetProperty("oldKey", out var keyElement) && keyElement.ValueKind == JsonValueKind.String ? keyElement.GetString() : null;
        if (balloons <= 0 || quantity <= 0 || string.IsNullOrWhiteSpace(eventName) || string.IsNullOrWhiteSpace(upboType))
        {
            await ShowUiToastAsync("별풍선, 이벤트명, 업보 종류, 수량을 모두 입력해주세요.");
            return;
        }
        var editedRule = string.IsNullOrWhiteSpace(oldKey) ? null : FindFixedRuleByKey(oldKey);
        if (_uiFixedRules.Any(rule => !ReferenceEquals(rule, editedRule) && rule.Balloons == balloons && rule.EventName == eventName && rule.UpboType == upboType))
        {
            await ShowUiToastAsync("같은 별풍선·이벤트·업보 종류의 확정 규칙이 이미 있습니다.");
            return;
        }
        if (editedRule is not null) _uiFixedRules.Remove(editedRule);
        _uiFixedRules.Add(new FixedRewardRule(balloons, eventName, upboType, quantity));
        _uiFixedRules = _uiFixedRules.OrderBy(rule => rule.Balloons).ThenBy(rule => rule.EventName).ThenBy(rule => rule.UpboType).ToList();
        await PushRulesAsync();
        await ShowUiToastAsync(string.IsNullOrWhiteSpace(oldKey) ? "확정 규칙을 추가했습니다." : "확정 규칙을 수정했습니다.");
    }

    private async Task DeleteFixedFromUiAsync(JsonElement payload)
    {
        var key = payload.TryGetProperty("key", out var element) ? element.GetString() ?? "" : "";
        RemoveFixedRuleByKey(key);
        await PushRulesAsync();
        await ShowUiToastAsync("확정 규칙을 삭제했습니다.");
    }

    private void RemoveFixedRuleByKey(string key)
    {
        var rule = FindFixedRuleByKey(key);
        if (rule is not null) _uiFixedRules.Remove(rule);
    }

    private FixedRewardRule? FindFixedRuleByKey(string key)
    {
        var parts = key.Split('\u001f');
        if (parts.Length != 3 || !long.TryParse(parts[0], out var balloons)) return null;
        return _uiFixedRules.FirstOrDefault(rule => rule.Balloons == balloons && rule.EventName == parts[1] && rule.UpboType == parts[2]);
    }

    private async Task SaveRulesFromUiAsync()
    {
        var session = _storage.Session;
        if (session?.Active == true)
        {
            _storage.SaveSessionRules(session.Id, _uiRouletteRules);
            _storage.SaveSessionFixedRules(session.Id, _uiFixedRules);
        }
        else
        {
            _storage.SaveDraftRules(_uiRouletteRules);
            _storage.SaveDraftFixedRules(_uiFixedRules);
        }
        _storage.Log($"HTML 규칙 설정 저장: 룰렛 {_uiRouletteRules.Count}개 · 확정 {_uiFixedRules.Count}개");
        RefreshSessionStats();
        await PushRulesAsync();
        await ShowUiToastAsync("업보 규칙을 저장했습니다.");
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

    internal async Task PrepareCollectorWebViewBeforeLoginAsync()
    {
        try
        {
            await PrepareCollectorWebViewAsync();
            _storage.Log("위플랩 수집 WebView2 로그인 전 사전 준비 완료");
        }
        catch (Exception ex)
        {
            // 위플랩 수집 화면은 로그인 자체의 필수 조건이 아닙니다. 사전 준비가
            // 일시적으로 중단되면 로그인은 계속하고, 메인 창이 표시된 뒤 새
            // 컨트롤로 다시 시도합니다.
            _storage.Log("위플랩 수집 WebView2 사전 준비 보류: " + ex.GetType().Name);
            ResetCollectorWebViewAfterFailedInitialization();
            _collectorWebInitializationTask = null;
        }
    }

    private Task PrepareCollectorWebViewAsync()
    {
        if (_webReady) return Task.CompletedTask;
        return _collectorWebInitializationTask ??= InitializeCollectorWebViewWithRetryAsync();
    }

    private async Task InitializeCollectorWebViewWithRetryAsync()
    {
        const int maxAttempts = 2;
        for (var attempt = 1; attempt <= maxAttempts; attempt++)
        {
            try
            {
                await InitializeCollectorWebViewCoreAsync();
                return;
            }
            catch (Exception ex) when (
                attempt < maxAttempts
                && IsTransientCollectorWebViewInitializationFailure(ex)
                && !IsDisposed
                && !Disposing)
            {
                _storage.Log(
                    $"위플랩 수집 WebView2 일시 중단 · attempt={attempt} " +
                    $"hresult=0x{ex.HResult:X8} · 새 컨트롤로 자동 재시도");
                ResetCollectorWebViewAfterFailedInitialization();
                await Task.Delay(150);
            }
        }
    }

    private async Task InitializeCollectorWebViewCoreAsync()
    {
        if (IsDisposed || Disposing)
            throw new ObjectDisposedException(nameof(MainForm));

        if (!IsHandleCreated) CreateControl();
        if (!_web.IsHandleCreated) _web.CreateControl();

        var userData = Path.Combine(_storage.RootPath, "WebView2Data");
        var env = await CoreWebView2Environment.CreateAsync(userDataFolder: userData);
        await _web.EnsureCoreWebView2Async(env);
        _web.CoreWebView2.WebMessageReceived += CoreWebView2_WebMessageReceived;
        // H-06: 허용 호스트 외 navigation 차단
        _web.CoreWebView2.NavigationStarting += CoreWebView2_NavigationStarting;
        _web.CoreWebView2.FrameNavigationStarting += CoreWebView2_FrameNavigationStarting;
        _web.CoreWebView2.NewWindowRequested += CoreWebView2_NewWindowRequested;
        _web.CoreWebView2.PermissionRequested += CoreWebView2_PermissionRequested;
        _web.CoreWebView2.DownloadStarting += CoreWebView2_DownloadStarting;
        // 프로덕션에서는 DevTools/컨텍스트 메뉴 비활성
        _web.CoreWebView2.Settings.AreDevToolsEnabled = false;
        _web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
        _webReady = true;
        SetWeflabConnection(false);
        _storage.Log($"WebView2 준비 완료. 기존 UID {_storage.SeenCount}개 로드");

        if (!_preserveCollectionDuringCollectorWebInitialization)
        {
            // 앱 재실행 시에는 절대 자동수집을 재개하지 않습니다. 다만 실행 중인
            // 세션의 WebView만 복구할 때는 이 초기화 경로를 함께 사용하므로,
            // 그 경우에는 사용자가 시작한 수집 상태를 그대로 보존합니다.
            _collecting = false;
            _collectorStatus.Text = "● OFF";
            _collectorStatus.ForeColor = (_darkMode ? Color.FromArgb(248, 250, 252) : Color.FromArgb(15, 23, 42));
        }
    }

    private void ResetCollectorWebViewAfterFailedInitialization()
    {
        _webReady = false;
        var failed = _web;
        try { failed.NavigationCompleted -= CollectorWeb_NavigationCompleted; } catch { }
        try { Controls.Remove(failed); } catch { }
        try { failed.Dispose(); } catch { }

        _web = new WebView2();
        var shellBackground = _darkMode
            ? Color.FromArgb(7, 18, 38)
            : Color.FromArgb(248, 250, 252);
        ConfigureCollectorWebControl(_web, shellBackground);
        Controls.Add(_web);
        _ui.BringToFront();
    }

    private static bool IsTransientCollectorWebViewInitializationFailure(Exception ex)
    {
        // E_ABORT는 컨트롤 생성과 창 수명 전환이 겹칠 때 WebView2가 반환할 수
        // 있는 일시 오류입니다. Runtime 미설치로 오인하지 않고 새 컨트롤에서
        // 한 번만 재시도합니다. 함께 관찰되는 일시적 controller 상태 코드도
        // 같은 제한된 재시도 대상으로 둡니다.
        return ex.HResult is
            unchecked((int)0x80004004) or // E_ABORT
            unchecked((int)0x8007139F) or // ERROR_INVALID_STATE
            unchecked((int)0x800700AA);   // ERROR_BUSY
    }

    private async Task InitWebAsync()
    {
        try
        {
            await PrepareCollectorWebViewAsync();
        }
        catch (Exception ex)
        {
            SetWeflabConnection(false);
            _storage.Log("WebView2 초기화 실패: " + ex);

            var looksLikeRuntimeMissing =
                ex is WebView2RuntimeNotFoundException ||
                ex is DllNotFoundException ||
                ex is BadImageFormatException ||
                ex.HResult == unchecked((int)0x8007007E);

            if (looksLikeRuntimeMissing)
            {
                var answer = MessageBox.Show(
                    "내장 브라우저(WebView2)를 시작하지 못했습니다.\n\n" +
                    "이 배포판에는 프로그램과 WebView2Loader가 함께 포함되어 있으므로, " +
                    "이 오류가 계속되면 PC의 Microsoft Edge WebView2 Runtime이 없거나 손상되었을 가능성이 있습니다.\n\n" +
                    "Microsoft 설치 페이지를 열까요?\n\n상세 오류: " + ex.Message,
                    "별록 에이전트 · WebView2 확인",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Warning);

                if (answer == DialogResult.Yes)
                {
                    try
                    {
                        Process.Start(new ProcessStartInfo
                        {
                            FileName = "https://developer.microsoft.com/microsoft-edge/webview2/",
                            UseShellExecute = true
                        });
                    }
                    catch { }
                }
                return;
            }

            MessageBox.Show(
                "위플랩 연결 화면을 준비하는 중 Windows가 작업을 중단했습니다.\n\n" +
                "로그인과 저장된 설정은 정상이며, 별록을 한 번 다시 열면 자동으로 재시도합니다.\n\n" +
                "상세 오류: " + ex.Message,
                "별록 에이전트 · 위플랩 연결 준비",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
    }

    private Task RestoreWeflabSessionAsync() =>
        BeginStoredWeflabAuthenticationAsync("앱 시작");

    private Task BeginStoredWeflabAuthenticationAsync(string reason)
    {
        if (!_webReady || _web.CoreWebView2 is null) return Task.CompletedTask;

        try
        {
            // WebView2Data의 쿠키·로컬 저장소를 그대로 재사용합니다. 브라우저는
            // 띄우지 않고 Weflab을 한 번 로드해 기존 로그인 상태만 확인합니다.
            _web.Visible = false;
            _web.CoreWebView2.Navigate("https://weflab.com/");
            _storage.Log($"Weflab 저장 로그인 상태 자동 확인 시작 · {reason}");
        }
        catch (Exception ex)
        {
            SetWeflabConnection(false);
            _storage.Log("Weflab 저장 로그인 상태 자동 확인 실패: " + ex.Message);
        }

        return Task.CompletedTask;
    }

    private async Task StartBroadcastSessionAsync()
    {
        if (_storage.Session?.Active == true) return;
        var startLocal = GetSelectedStartLocal();
        if (startLocal > DateTime.Now.AddMinutes(1)) { MessageBox.Show("수집 시작 시각이 현재보다 미래입니다."); return; }
        var s = _storage.StartSession(startLocal);
        _collecting = true;
        _startButton.Enabled = true; SetStartPickersEnabled(false); UpdateCollectionActionButton();
        _sessionStatus.Text = $"● 수집 범위 설정됨 · {s.StartLocal:MM-dd HH:mm}~"; _sessionStatus.ForeColor = _darkMode ? Color.FromArgb(91, 226, 147) : Color.FromArgb(31, 143, 82);
        _collectorStatus.Text = "● ON"; _collectorStatus.ForeColor = _darkMode ? Color.FromArgb(91, 226, 147) : Color.FromArgb(31, 143, 82);
        RefreshSessionStats();
        ScheduleRealtimeUpload(); // 세션 시작 시 미전송 데이터가 있으면 즉시 자동 전송 예약
        UpdateTrayStatus();
        if (!_webReady) return;
        if (_web.Source is null) await OpenWeflabAsync(true); else await InjectCollectorAsync();
        _storage.Log($"방송 수집 시작: {s.StartLocal:yyyy-MM-dd HH:mm:ss} · 룰렛 규칙 {_storage.LoadSessionRules(s.Id).Count}개 · 고정 규칙 {_storage.LoadSessionFixedRules(s.Id).Count}개");
    }

    private async Task EndBroadcastSessionAsync()
    {
        if (_storage.Session?.Active != true) return;
        var s = _storage.EndSession(DateTime.Now);
        _collecting = false;
        await StopCollectorScriptAsync();
        _collectorStatus.Text = "● OFF"; _collectorStatus.ForeColor = (_darkMode ? Color.FromArgb(248, 250, 252) : Color.FromArgb(15, 23, 42));
        _sessionStatus.Text = $"● 수집 완료 · {s!.StartLocal:MM-dd HH:mm}~{s.EndLocal:MM-dd HH:mm}"; _sessionStatus.ForeColor = (_darkMode ? Color.FromArgb(248, 250, 252) : Color.FromArgb(15, 23, 42));
        _startButton.Enabled = true; SetStartPickersEnabled(true); UpdateCollectionActionButton(); SetStartPickers(DateTime.Now);
        _storage.Log($"방송 수집 종료: {s.EndLocal:yyyy-MM-dd HH:mm:ss}");
        UpdateTrayStatus();
        await UploadSessionCoreAsync(manual: false); // 종료 시 마지막 미반영 구간도 한 번 동기화
        await MirrorVNextDevelopmentAsync(force: true); // DEV 미러 큐는 운영 업로드와 독립적으로 마감 시 한 번 더 처리
        NotifyMainUi();
    }

    private void UpdateCollectionActionButton()
    {
        var active = _collecting || _storage.Session?.Active == true;
        _startButton.Text = active ? "■ 수집 중단" : "▶ 수집 시작";
        _startButton.Enabled = true;
        _startButton.MinimumSize = new Size(190, 44);

        if (active)
        {
            _startButton.BackColor = _darkMode ? Color.FromArgb(39, 55, 78) : Color.FromArgb(242, 244, 248);
            _startButton.ForeColor = _darkMode ? Color.FromArgb(248, 250, 252) : Color.FromArgb(35, 45, 60);
            _startButton.FlatAppearance.BorderColor = _darkMode ? Color.FromArgb(74, 94, 124) : Color.FromArgb(218, 224, 232);
            _startButton.FlatAppearance.BorderSize = 1;
        }
        else
        {
            _startButton.BackColor = Color.FromArgb(251, 190, 55);
            _startButton.ForeColor = Color.FromArgb(29, 35, 48);
            _startButton.FlatAppearance.BorderSize = 0;
        }
        NotifyMainUi();
    }

    private async Task OpenWeflabAsync(bool showBrowser)
    {
        if (!_webReady) return;
        if (showBrowser) ShowBrowser();
        _web.Source = new Uri("https://weflab.com/");
        SetWeflabConnection(false);
        _storage.Log("Weflab 페이지 열기");
        await Task.CompletedTask;
    }

    private void ToggleBrowser() { if (_web.Visible) HideBrowser(); else ShowBrowser(); }
    private void ShowBrowser()
    {
        _web.Visible = true; _web.BringToFront(); _web.Width = ClientSize.Width; _web.Height = Math.Max(320, ClientSize.Height - 55);
        var close = new Button { Text = "브라우저 닫기", AutoSize = true, Anchor = AnchorStyles.Top | AnchorStyles.Right, Location = new Point(ClientSize.Width - 130, 12) };
        close.Click += (_, _) => { close.Dispose(); HideBrowser(); }; Controls.Add(close); close.BringToFront();
    }
    private void HideBrowser() => _web.Visible = false;

    private async Task InjectLoginProbeAsync()
    {
        if (!_webReady) return;
        const string script = """
(function(){try{if(window.__hurogi_login_probe__)clearInterval(window.__hurogi_login_probe__);function post(o){try{window.chrome.webview.postMessage(JSON.stringify(o));}catch(e){}}function probe(){var h=(typeof loginData!=='undefined'&&!!loginData);var idx=h&&loginData.idx!=null?String(loginData.idx):'';var logged=h&&idx!==''&&idx!=='-1'&&idx!=='0';post({kind:'probe',logged:logged,idx:idx,hasLoginData:h,hasJquery:(typeof $!=='undefined'&&!!$.ajax),href:String(location.href),title:String(document.title||'')});}window.__hurogi_login_probe__=setInterval(probe,1500);probe();}catch(e){try{window.chrome.webview.postMessage(JSON.stringify({kind:'probe_error',text:String(e)}));}catch(_){}}})();
""";
        try { await _web.CoreWebView2.ExecuteScriptAsync(script); }
        catch (Exception ex) { _storage.Log("로그인 감지 스크립트 삽입 실패: " + ex.Message); }
    }

    private async Task StopCollectorScriptAsync()
    {
        if (!_webReady) return;
        try { await _web.CoreWebView2.ExecuteScriptAsync("if(window.__hurogi_poll__){clearInterval(window.__hurogi_poll__);window.__hurogi_poll__=null;}if(window.__hurogi_login_watch__){clearInterval(window.__hurogi_login_watch__);window.__hurogi_login_watch__=null;}"); } catch { }
    }

    private async Task InjectCollectorAsync()
    {
        if (!_webReady || !_collecting || _storage.Session?.Active != true) return;
        // 방송 액션은 후원 발생 후 가능한 한 빨리 이어져야 합니다. 레거시 수집
        // 스크립트와 중복 제거 계약은 그대로 두고 실시간 조회 주기만 2초로 줄입니다.
        // 1초 호출은 위플랩 세션/API 부하를 과도하게 키울 수 있어 사용하지 않습니다.
        try { await _web.CoreWebView2.ExecuteScriptAsync(CollectorScript.Build(_storage.Session.StartLocal, intervalMs: 2000)); }
        catch (Exception ex) { _storage.Log("스크립트 삽입 실패: " + ex.Message); }
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

    private void CoreWebView2_NavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        try
        {
            if (!WebViewTrustPolicy.IsAllowedWeflabNavigation(e.Uri, out var reason))
            {
                e.Cancel = true;
                _storage.Log(
                    "H-06 navigation blocked (" + reason + ") · origin=" +
                    WebViewTrustPolicy.SafeOriginForLog(e.Uri));
                return;
            }

            if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var uri) &&
                (uri.AbsolutePath.Contains("login", StringComparison.OrdinalIgnoreCase) ||
                 uri.AbsolutePath.Contains("oauth", StringComparison.OrdinalIgnoreCase) ||
                 uri.AbsolutePath.Contains("auth", StringComparison.OrdinalIgnoreCase) ||
                 !WebViewTrustPolicy.IsAllowedWeflabHost(uri.Host)))
            {
                _storage.Log(
                    "H-06 navigation allow · origin=" +
                    WebViewTrustPolicy.SafeOriginForLog(e.Uri));
            }
        }
        catch (Exception ex)
        {
            e.Cancel = true;
            _storage.Log("H-06 navigation filter error: " + ex.GetType().Name);
        }
    }

    private void CoreWebView2_FrameNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        CoreWebView2_NavigationStarting(sender, e);
    }

    private void CoreWebView2_NewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        // target=_blank / window.open 으로 뜨는 SOOP·위플랩 로그인 팝업
        try
        {
            e.Handled = true;
            var url = e.Uri ?? "";
            if (!WebViewTrustPolicy.IsAllowedWeflabNavigation(url, out var reason))
            {
                _storage.Log(
                    "H-06 popup blocked (" + reason + ") · origin=" +
                    WebViewTrustPolicy.SafeOriginForLog(url));
                return;
            }

            if (string.IsNullOrWhiteSpace(url) ||
                string.Equals(url, "about:blank", StringComparison.OrdinalIgnoreCase)) return;

            _storage.Log(
                "H-06 popup → same WebView · origin=" +
                WebViewTrustPolicy.SafeOriginForLog(url));
            // 같은 프로필·쿠키로 이어서 OAuth 진행
            _web.CoreWebView2.Navigate(url);
        }
        catch (Exception ex)
        {
            _storage.Log("H-06 popup handler error: " + ex.Message);
        }
    }

    private void CoreWebView2_WebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)

    {
        if (!WebViewTrustPolicy.IsTrustedWeflabMessageSource(e.Source))
        {
            _storage.Log("Weflab message blocked (source): " + WebViewTrustPolicy.SafeOriginForLog(e.Source));
            return;
        }

        string raw;
        try { raw = e.WebMessageAsJson; }
        catch
        {
            _storage.Log("Weflab message blocked (unreadable)");
            return;
        }

        if (!WebViewTrustPolicy.TryParseWeflabMessage(raw, out var message, out _, out var reason))
        {
            _storage.Log("Weflab message blocked (" + reason + ")");
            return;
        }

        HandleMessageObject(message);
    }

    private void HandleMessageObject(JsonElement msg)
    {
        if (!msg.TryGetProperty("kind", out var kindEl)) return;
        var kind = kindEl.GetString() ?? "";
        if (kind == "probe")
        {
            var logged = msg.TryGetProperty("logged", out var l) && l.ValueKind == JsonValueKind.True;
            var hasLoginData = msg.TryGetProperty("hasLoginData", out var ld) && ld.ValueKind == JsonValueKind.True;
            var hasJquery = msg.TryGetProperty("hasJquery", out var jq) && jq.ValueKind == JsonValueKind.True;
            var href = msg.TryGetProperty("href", out var h) ? h.GetString() ?? "" : "";
            var origin = WebViewTrustPolicy.SafeOriginForLog(href);
            BeginInvoke(() => HandleWeflabLoginCandidate(logged, "로그인 상태 확인"));
            var sig = $"{logged}|{hasLoginData}|{hasJquery}|{origin}";
            if (sig != _lastProbeSignature)
            {
                _lastProbeSignature = sig;
                _storage.Log($"probe logged={logged} loginData={hasLoginData} jquery={hasJquery} origin={origin}");
            }
            return;
        }
        if (kind == "probe_error") { _storage.Log("probe script error received"); return; }
        if (kind == "status") { var state = msg.TryGetProperty("state", out var s) ? s.GetString() ?? "" : ""; var text = msg.TryGetProperty("text", out var t) ? t.GetString() ?? "" : ""; BeginInvoke(() => ApplyStatus(state,text)); return; }
        if (kind == "rows" && msg.TryGetProperty("payload", out var payload)) { var safePayload = payload.Clone(); BeginInvoke(() => { try { ProcessPayload(safePayload); } catch (Exception ex) { _storage.Log("수집 데이터 처리 실패: " + ex); HandleWeflabApiFailure("후원 응답 처리 실패"); } }); }
    }

    private void ApplyStatus(string state, string text)
    {
        if (state == "auth_on") HandleWeflabLoginCandidate(true, text);
        else if (state == "on") HandleWeflabApiSuccess(text);
        else if (state is "nologin" or "error") HandleWeflabApiFailure(text);
    }

    private async void HandleWeflabLoginCandidate(bool loggedIn, string detail)
    {
        if (IsDisposed) return;
        _weflabRecoveryGate.Observe(WeflabHealthSignal.LoginCandidate);
        if (loggedIn)
        {
            var shouldReconnect = _weflabReconnectPending && _collecting && _storage.Session?.Active == true;
            _weflabLoginNoticeShown = false;
            if (!_collecting) SetWeflabConnection(true);
            if (!shouldReconnect) return;

            try
            {
                await InjectCollectorAsync();
                _storage.Log("Weflab 로그인 후보 확인 · 실제 후원 API 검증 시작");
            }
            catch (Exception ex)
            {
                _storage.Log("Weflab 로그인 복구 후 수집 재연결 실패: " + ex.Message);
            }
            return;
        }

        HandleWeflabApiFailure(detail);
    }

    private void HandleWeflabApiSuccess(string detail)
    {
        _weflabRecoveryGate.Observe(WeflabHealthSignal.ApiSuccess);
        SetWeflabConnection(true);
        _storage.MarkWeflabObserved(DateTimeOffset.UtcNow);
        _weflabRecoverySignal?.TrySetResult(true);
        var recovered = _weflabReconnectPending;
        _weflabReconnectPending = false;
        _weflabLoginNoticeShown = false;
        if (recovered)
        {
            _storage.Log("Weflab 재로그인 완료 · 실제 후원 API 검증 및 수집 자동 재연결");
            _ = ShowUiToastAsync("위플랩 연결을 복구해 수집을 자동으로 다시 시작했습니다.");
        }
    }

    private async void HandleWeflabApiFailure(string detail)
    {
        if (IsDisposed || Disposing) return;
        var wasConnected = _weflabConnected;
        SetWeflabConnection(false);

        // 첫 실행에서 아직 로그인하지 않은 상태는 조용히 표시합니다. 이미 연결돼
        // 있었거나 수집 중인 세션이 끊겼을 때만 실제 만료로 보고 안내합니다.
        if (!wasConnected && !_collecting) return;

        _weflabReconnectPending = _collecting && _storage.Session?.Active == true;
        if (!_weflabReconnectPending) return;
        if (_weflabLoginNoticeShown) return;

        // 페이지 이동·일시 네트워크 오류를 실제 만료로 오인하지 않도록 실제 후원
        // API 실패가 연속된 두 신호인지 확인합니다. 로그인 후보 신호는 실패 횟수를
        // 초기화하지 않습니다. 복구 중 들어오는 추가
        // 신호는 같은 복구 작업에 합치므로 WebView를 여러 번 만들지 않습니다.
        if (_weflabRecoveryInProgress || !_weflabRecoveryGate.Observe(WeflabHealthSignal.ApiFailure)) return;

        var recovered = await TryRecoverWeflabSessionWithoutUserAsync(detail);
        if (recovered || _weflabConnected || IsDisposed || Disposing || !_collecting || _storage.Session?.Active != true)
            return;

        if (_weflabLoginNoticeShown) return;

        _weflabLoginNoticeShown = true;
        _storage.Log("Weflab 로그인 세션 만료 감지" + (string.IsNullOrWhiteSpace(detail) ? "" : " · " + detail));
        ShowBrowser();
        MessageBox.Show(
            "위플랩 로그인 세션이 만료되어 수집이 일시 중지됐습니다.\n\n" +
            "열린 위플랩 화면에서 다시 로그인해 주세요. 로그인에 성공하면 별록이 수집 스크립트를 자동으로 다시 연결합니다.",
            "별록 에이전트 · 위플랩 재로그인 필요",
            MessageBoxButtons.OK,
            MessageBoxIcon.Warning);
    }

    private async Task<bool> TryRecoverWeflabSessionWithoutUserAsync(string detail)
    {
        if (_weflabRecoveryInProgress || !_webReady || _web.CoreWebView2 is null)
            return false;

        _weflabRecoveryInProgress = true;
        _storage.Log(
            "Weflab 로그인 세션 만료 감지 · 사용자 개입 없는 자동 복구 시작" +
            (string.IsNullOrWhiteSpace(detail) ? "" : " · " + detail));
        NotifyMainUi();

        try
        {
            // 1차는 앱 시작 때와 같은 루트 페이지 재탐색입니다. 저장된 쿠키와
            // 갱신 토큰이 유효하면 Weflab이 로그인 상태를 자동으로 되살립니다.
            if (await RunWeflabRecoveryAttemptAsync(
                    attempt: 1,
                    timeout: TimeSpan.FromSeconds(30),
                    restartCollectorWebView: false))
                return true;

            if (!_collecting || _storage.Session?.Active != true)
                return false;

            // 2차는 별록 전체가 아니라 수집 전용 WebView2만 새로 만듭니다.
            // 사용자 데이터 폴더는 그대로 재사용하므로 로그인·설정은 지우지
            // 않으면서 실제 앱 재실행과 같은 새 브라우저 수명을 얻습니다.
            return await RunWeflabRecoveryAttemptAsync(
                attempt: 2,
                timeout: TimeSpan.FromSeconds(60),
                restartCollectorWebView: true);
        }
        catch (OperationCanceledException) when (_weflabRecoveryLifetime.IsCancellationRequested)
        {
            return false;
        }
        catch (Exception ex)
        {
            _storage.Log("Weflab 자동 세션 복구 실패: " + ex.GetType().Name);
            return false;
        }
        finally
        {
            _weflabRecoverySignal = null;
            _weflabRecoveryInProgress = false;
            NotifyMainUi();
        }
    }

    private async Task<bool> RunWeflabRecoveryAttemptAsync(
        int attempt,
        TimeSpan timeout,
        bool restartCollectorWebView)
    {
        if (IsDisposed || Disposing || !_collecting || _storage.Session?.Active != true)
            return false;

        var signal = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        _weflabRecoverySignal = signal;

        await StopCollectorScriptAsync();
        if (restartCollectorWebView)
        {
            _storage.Log($"Weflab 자동 복구 {attempt}/2 · 수집 WebView2 새 수명으로 재시작");
            _collectorWebInitializationTask = null;
            ResetCollectorWebViewAfterFailedInitialization();
            await Task.Delay(1000, _weflabRecoveryLifetime.Token);
            _preserveCollectionDuringCollectorWebInitialization = true;
            try
            {
                await PrepareCollectorWebViewAsync();
            }
            finally
            {
                _preserveCollectionDuringCollectorWebInitialization = false;
            }
        }
        else
        {
            _storage.Log($"Weflab 자동 복구 {attempt}/2 · 저장 로그인 상태 다시 불러오기");
        }

        await BeginStoredWeflabAuthenticationAsync($"자동 복구 {attempt}/2");

        var timeoutTask = Task.Delay(timeout, _weflabRecoveryLifetime.Token);
        var completed = await Task.WhenAny(signal.Task, timeoutTask);
        // 페이지 로그인 후보나 WebView 로드만으로는 성공 처리하지 않습니다.
        // alertlist_load가 유효한 배열을 반환한 경우에만 이 신호가 완료됩니다.
        var recovered = completed == signal.Task && await signal.Task;
        if (recovered)
        {
            _storage.Log($"Weflab 자동 세션 복구 완료 · attempt={attempt}");
            try { await ShowUiToastAsync("위플랩 연결을 자동으로 복구했습니다."); }
            catch (Exception ex) { _storage.Log("Weflab 자동 복구 안내 표시 보류: " + ex.GetType().Name); }
        }
        else
        {
            _storage.Log($"Weflab 자동 세션 복구 응답 없음 · attempt={attempt}");
        }

        if (ReferenceEquals(_weflabRecoverySignal, signal))
            _weflabRecoverySignal = null;
        return recovered;
    }

    private void ProcessPayload(JsonElement payload)
    {
        if (_storage.Session?.Active != true) return;

        // 위플랩 alertlist_load 응답은 버전/페이지 상태에 따라 data가 바로 배열이거나
        // data/rows/list 아래에 한 번 더 감싸져 올 수 있습니다.
        // 예전 코드는 { result:"success", data:[...] } 한 형태만 허용해서
        // 실제 응답 형식이 조금만 달라도 모든 실데이터를 버렸습니다.
        if (payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty("result", out var result))
        {
            var resultText = result.ToString();
            var explicitFailure = result.ValueKind == JsonValueKind.False ||
                                  resultText.Equals("fail", StringComparison.OrdinalIgnoreCase) ||
                                  resultText.Equals("failed", StringComparison.OrdinalIgnoreCase) ||
                                  resultText.Equals("error", StringComparison.OrdinalIgnoreCase);
            if (explicitFailure)
            {
                _storage.Log($"Weflab 응답 실패 result={resultText}");
                HandleWeflabApiFailure("후원 API가 세션 실패를 반환함");
                return;
            }
        }

        if (!TryFindDonationRows(payload, out var data))
        {
            _storage.Log(
                "Weflab 후원 배열을 찾지 못함 · payload_kind=" +
                payload.ValueKind);
            HandleWeflabApiFailure("후원 API 응답 형식 확인 실패");
            return;
        }

        HandleWeflabApiSuccess("후원 API 정상 응답");

        var start = _storage.Session.StartLocal;
        var added = 0;
        var fallbackUidCount = 0;
        var rejectedNoIdentity = 0;
        var observedAtUtc = DateTimeOffset.UtcNow;
        long? maximumSourceAgeMs = null;
        foreach (var sourceRow in data.EnumerateArray().Reverse())
        {
            if (sourceRow.ValueKind != JsonValueKind.Object) continue;
            var row = sourceRow.Clone();
            var uid = GetString(row,"uid");
            if (string.IsNullOrWhiteSpace(uid))
            {
                uid = BuildFallbackUid(row);
                if (string.IsNullOrWhiteSpace(uid)) { rejectedNoIdentity++; continue; }
                row = WithUid(row, uid);
                fallbackUidCount++;
            }
            var occurred = GetOccurredLocal(row);
            if (occurred.HasValue && occurred.Value < start.AddMinutes(-1)) continue;
            if (!_storage.TrySave(uid,row)) continue;
            added++;
            var occurredAtUtc = GetVNextOccurredAtUtc(row);
            if (occurredAtUtc.HasValue)
            {
                var sourceAgeMs = Math.Max(
                    0L,
                    (long)(observedAtUtc - occurredAtUtc.Value).TotalMilliseconds);
                maximumSourceAgeMs = maximumSourceAgeMs.HasValue
                    ? Math.Max(maximumSourceAgeMs.Value, sourceAgeMs)
                    : sourceAgeMs;
            }
            AddToUi(row);
        }
        RefreshSessionStats();
        if (added > 0)
        {
            _storage.Log(
                $"새 후원 {added}건 저장 · sourceAgeMaxMs={maximumSourceAgeMs?.ToString() ?? "unknown"} · 방송 시작 {start:yyyy-MM-dd HH:mm}" +
                (fallbackUidCount > 0 ? $" · 대체 UID {fallbackUidCount}건" : ""));
            ScheduleRealtimeUpload();
        }
        if (rejectedNoIdentity > 0) _storage.Log($"후원처럼 보이지만 안정적인 UID를 만들 수 없어 제외 {rejectedNoIdentity}건");
    }

    private static bool TryFindDonationRows(JsonElement root, out JsonElement rows)
    {
        // 1) 가장 흔한 경로를 우선 검사
        if (root.ValueKind == JsonValueKind.Array && (root.GetArrayLength() == 0 || LooksLikeDonationArray(root)))
        {
            rows = root.Clone();
            return true;
        }

        if (root.ValueKind == JsonValueKind.Object)
        {
            foreach (var key in new[] { "data", "rows", "records", "items", "list" })
            {
                if (!root.TryGetProperty(key, out var v)) continue;
                if (v.ValueKind == JsonValueKind.Array && (v.GetArrayLength() == 0 || LooksLikeDonationArray(v)))
                {
                    rows = v.Clone();
                    return true;
                }
                if (v.ValueKind == JsonValueKind.Object && TryFindDonationRowsDepth(v, 1, out rows)) return true;
            }
            if (TryFindDonationRowsDepth(root, 0, out rows)) return true;
        }

        rows = default;
        return false;
    }

    private static bool TryFindDonationRowsDepth(JsonElement node, int depth, out JsonElement rows)
    {
        if (depth > 4) { rows = default; return false; }
        if (node.ValueKind != JsonValueKind.Object) { rows = default; return false; }

        foreach (var prop in node.EnumerateObject())
        {
            var v = prop.Value;
            if (v.ValueKind == JsonValueKind.Array && LooksLikeDonationArray(v))
            {
                rows = v.Clone();
                return true;
            }
            if (v.ValueKind == JsonValueKind.Object && TryFindDonationRowsDepth(v, depth + 1, out rows)) return true;
        }

        rows = default;
        return false;
    }

    private static bool LooksLikeDonationArray(JsonElement arr)
    {
        if (arr.ValueKind != JsonValueKind.Array) return false;
        var checkedCount = 0;
        foreach (var item in arr.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object) continue;
            checkedCount++;
            // uid가 없는 과거/변형 응답도 후원 필드 조합이 있으면 후보 배열로 인정합니다.
            // 실제 저장 시에는 안정적인 fallback UID를 생성합니다.
            var hasWho = item.TryGetProperty("name", out _) || item.TryGetProperty("id", out _) || item.TryGetProperty("bjid", out _);
            var hasAmount = item.TryGetProperty("value", out _) || item.TryGetProperty("currency", out _);
            var hasTime = item.TryGetProperty("create_time", out _) || item.TryGetProperty("time", out _);
            var hasRoulette = item.TryGetProperty("roulette", out _) || item.TryGetProperty("list", out _);
            if ((hasWho && (hasAmount || hasTime)) || (hasAmount && hasTime) || hasRoulette) return true;
            if (checkedCount >= 8) break;
        }
        return false;
    }

    private void AddToUi(JsonElement row)
    {
        var amount = GetAmount(row); var roulette = GetString(row,"roulette"); var who = GetString(row,"name"); if (string.IsNullOrWhiteSpace(who)) who = GetString(row,"id");
        var when = GetString(row,"create_time"); if (string.IsNullOrWhiteSpace(when)) when = GetString(row,"time");
    }

    private void AddDummyDonation()
    {
        try
        {
            if (_storage.Session?.Active != true)
            {
                var answer = MessageBox.Show(
                    "현재 활성 수집 세션이 없습니다.\n\n테스트용 수집 세션을 지금 시작하고 더미 후원을 추가할까요?",
                    "더미 데이터 추가",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Question,
                    MessageBoxDefaultButton.Button1);
                if (answer != DialogResult.Yes) return;

                var startLocal = DateTime.Now.AddMinutes(-1);
                var session = _storage.StartSession(startLocal);
                _collecting = true;
                _startButton.Enabled = true;
                SetStartPickersEnabled(false);
                UpdateCollectionActionButton();
                SetStartPickers(startLocal);
                _sessionStatus.Text = $"● 수집 범위 설정됨 · {session.StartLocal:MM-dd HH:mm}~";
                _sessionStatus.ForeColor = _darkMode ? Color.FromArgb(91, 226, 147) : Color.FromArgb(31, 143, 82);
                _collectorStatus.Text = "● ON";
                _collectorStatus.ForeColor = _darkMode ? Color.FromArgb(91, 226, 147) : Color.FromArgb(31, 143, 82);
                ScheduleRealtimeUpload();
                UpdateTrayStatus();
            }

            var sessionId = _storage.Session!.Id;
            var rules = _storage.LoadSessionRules(sessionId);
            if (rules.Count == 0)
                rules = _storage.LoadDraftRules();

            var rule = rules.OrderBy(r => r.Balloons).FirstOrDefault();
            var fixedRule = _storage.LoadSessionFixedRules(sessionId).OrderBy(r => r.Balloons).FirstOrDefault();
            var amount = rule?.Balloons ?? fixedRule?.Balloons ?? 30L;
            var spins = Math.Max(1, rule?.ExpectedSpins ?? 1);
            var now = DateTime.Now;
            var uid = $"dummy-{now:yyyyMMddHHmmss}-{Guid.NewGuid():N}";

            var rouletteItems = Enumerable.Range(1, spins)
                .Select(i => new object[] { i == 1 ? "더미 단컷" : $"더미 결과 {i}", "TEST" })
                .ToArray();

            var payload = new
            {
                uid,
                create_time = now.ToString("yyyy-MM-dd HH:mm:ss"),
                time = now.ToString("yyyy-MM-dd HH:mm:ss"),
                name = "더미테스터",
                id = "dummy_test",
                value = amount,
                currency = new { real = amount },
                roulette = rouletteItems[0][0].ToString(),
                percent = "TEST",
                list = rouletteItems,
                message = "Collector TEST dummy donation",
                is_dummy = true
            };

            using var doc = JsonDocument.Parse(JsonSerializer.Serialize(payload));
            var row = doc.RootElement.Clone();
            if (!_storage.TrySave(uid, row))
            {
                MessageBox.Show("더미 데이터 저장에 실패했습니다.", "더미 데이터 추가", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            AddToUi(row);
            RefreshSessionStats();
            _storage.Log($"TEST 더미 후원 추가 · uid={uid} · {amount:N0}개 · 룰렛 {spins}회");
            ScheduleRealtimeUpload();

            var eventText = rule is null ? "미분류(룰렛 설정 없음)" : $"{rule.EventName} / 룰렛 {spins}회";
            MessageBox.Show(
                $"더미 후원 1건을 추가했습니다.\n\n닉네임: 더미테스터\nSOOP ID: dummy_test\n별풍선: {amount:N0}개\n판정: {eventText}\n\n이 데이터는 실제 수집 데이터처럼 서버 업로드 대상에 포함됩니다.",
                "더미 데이터 추가",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }
        catch (Exception ex)
        {
            _storage.Log("TEST 더미 후원 추가 실패: " + ex);
            MessageBox.Show("더미 데이터 추가 실패\n\n" + ex.Message, "별록 에이전트", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private void RefreshSessionStats()
    {
        _sessionDonationCount=0; _sessionBalloonCount=0; _sessionRouletteCount=0;
        var s = _storage.Session;
        if (s is not null)
        {
            foreach (var row in _storage.LoadSessionRows(s.Id))
            {
                _sessionDonationCount++; _sessionBalloonCount += GetAmount(row); if (!string.IsNullOrWhiteSpace(GetString(row,"roulette"))) _sessionRouletteCount++;
            }
        }
        _todayDonations.Text = $"이번 수집 후원\n{_sessionDonationCount:N0}건";
        _todayBalloons.Text = $"이번 수집 별풍선\n{_sessionBalloonCount:N0}개";
        _todayRoulette.Text = $"룰렛 포함\n{_sessionRouletteCount:N0}건";
        NotifyMainUi();
    }

    private void ShowSessionList()
    {
        var s = _storage.Session;
        if (s is null)
        {
            MessageBox.Show("아직 수집 세션이 없습니다.", "별록 에이전트", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        var rows = _storage.LoadSessionRows(s.Id);
        var rules = _storage.LoadSessionRules(s.Id).ToDictionary(r => r.Balloons);
        var form = new Form
        {
            Text = "수집 목록 보기",
            Width = 1180,
            Height = 700,
            MinimumSize = new Size(980, 640),
            StartPosition = FormStartPosition.CenterParent,
            Font = new Font("맑은 고딕", 10F),
            AutoScaleMode = AutoScaleMode.Dpi
        };

        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(22, 20, 22, 18),
            ColumnCount = 1,
            RowCount = 3,
            Margin = new Padding(0)
        };
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 72));

        var header = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            ColumnCount = 1,
            RowCount = 2,
            Margin = new Padding(0, 0, 0, 14)
        };
        var title = new Label
        {
            Text = "수집 목록",
            AutoSize = true,
            Font = new Font("맑은 고딕", 17F, FontStyle.Bold),
            Margin = new Padding(0, 0, 0, 3)
        };
        var rangeEnd = s.EndLocal.HasValue ? s.EndLocal.Value.ToString("MM-dd HH:mm") : "현재";
        var sub = new Label
        {
            Text = $"{s.StartLocal:MM-dd HH:mm} ~ {rangeEnd} · 총 {rows.Count:N0}건 · 서버 전송 전 원본 기록",
            AutoSize = true,
            Tag = "muted",
            Margin = new Padding(0)
        };
        header.Controls.Add(title, 0, 0);
        header.Controls.Add(sub, 0, 1);
        root.Controls.Add(header, 0, 0);

        var card = new Panel { Dock = DockStyle.Fill, Padding = new Padding(1), Margin = new Padding(0), Tag = "card" };
        var grid = new DataGridView
        {
            Dock = DockStyle.Fill,
            AutoGenerateColumns = false,
            AllowUserToAddRows = false,
            AllowUserToDeleteRows = false,
            AllowUserToResizeRows = false,
            ReadOnly = true,
            RowHeadersVisible = false,
            SelectionMode = DataGridViewSelectionMode.FullRowSelect,
            MultiSelect = false,
            AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill,
            Margin = new Padding(0),
            BorderStyle = BorderStyle.None
        };
        grid.Columns.Add(new DataGridViewTextBoxColumn { Name = "Time", HeaderText = "시간", FillWeight = 17 });
        grid.Columns.Add(new DataGridViewTextBoxColumn { Name = "Name", HeaderText = "닉네임", FillWeight = 14 });
        grid.Columns.Add(new DataGridViewTextBoxColumn { Name = "Id", HeaderText = "SOOP ID", FillWeight = 13 });
        grid.Columns.Add(new DataGridViewTextBoxColumn { Name = "Balloons", HeaderText = "별풍선", FillWeight = 9 });
        grid.Columns.Add(new DataGridViewTextBoxColumn { Name = "Event", HeaderText = "이벤트", FillWeight = 14 });
        grid.Columns.Add(new DataGridViewTextBoxColumn { Name = "Roulette", HeaderText = "룰렛", FillWeight = 10 });
        grid.Columns.Add(new DataGridViewTextBoxColumn { Name = "State", HeaderText = "상태", FillWeight = 11 });
        grid.Columns.Add(new DataGridViewTextBoxColumn { Name = "Result", HeaderText = "대표 결과", FillWeight = 22 });

        foreach (var r in rows.OrderByDescending(x => GetOccurredLocal(x) ?? DateTime.MinValue))
        {
            var when = GetString(r, "create_time");
            if (string.IsNullOrWhiteSpace(when)) when = GetString(r, "time");
            var amount = GetAmount(r);
            var actual = GetRouletteResults(r).Count;
            rules.TryGetValue(amount, out var rule);
            var evt = rule?.EventName ?? "-";
            var rouletteText = rule is null ? (actual > 0 ? actual.ToString() : "-") : $"{actual}/{rule.ExpectedSpins}";
            var state = rule is null ? "일반후원" : actual == rule.ExpectedSpins ? "정상" : (actual < rule.ExpectedSpins ? "부족" : "초과");
            var results = string.Join(" + ", GetRouletteResults(r).Select(x => x.Result));
            grid.Rows.Add(when, GetString(r, "name"), GetString(r, "id"), amount.ToString("N0"), evt, rouletteText, state, results);
        }

        card.Controls.Add(grid);
        root.Controls.Add(card, 0, 1);

        var footer = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.RightToLeft,
            WrapContents = false,
            Padding = new Padding(0, 10, 0, 8),
            Margin = new Padding(0)
        };
        var close = new Button
        {
            Text = "닫기",
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            MinimumSize = new Size(108, 44),
            Padding = new Padding(18, 6, 18, 6),
            Margin = new Padding(0)
        };
        close.Click += (_, _) => form.Close();
        footer.Controls.Add(close);
        root.Controls.Add(footer, 0, 2);

        form.Controls.Add(root);
        ApplyThemeToDialog(form);
        form.ShowDialog(this);
    }

    private void ShowRouletteSettings()
    {
        var s = _storage.Session;
        var isLive = s?.Active == true;
        var workingRules = (isLive ? _storage.LoadSessionRules(s!.Id) : _storage.LoadDraftRules())
            .OrderBy(r => r.Balloons).ToList();
        var workingFixedRules = (isLive ? _storage.LoadSessionFixedRules(s!.Id) : _storage.LoadDraftFixedRules())
            .OrderBy(r => r.Balloons).ThenBy(r => r.EventName).ThenBy(r => r.UpboType).ToList();

        // 규칙 설정 창은 메인 Collector와 같은 별록 네이비/옐로우 팔레트를 사용합니다.
        // 기존 전역 다이얼로그 테마의 회색 계열을 쓰지 않아 다크/화이트 모드 모두 일관된 인상을 유지합니다.
        var bg = _darkMode ? Color.FromArgb(8, 21, 43) : Color.FromArgb(246, 248, 252);
        var surface = _darkMode ? Color.FromArgb(17, 37, 67) : Color.White;
        var surfaceAlt = _darkMode ? Color.FromArgb(24, 48, 82) : Color.FromArgb(248, 250, 253);
        var fieldBg = _darkMode ? Color.FromArgb(11, 30, 55) : Color.White;
        var text = _darkMode ? Color.FromArgb(248, 250, 252) : Color.FromArgb(15, 23, 42);
        var muted = _darkMode ? Color.FromArgb(177, 191, 211) : Color.FromArgb(100, 116, 139);
        var border = _darkMode ? Color.FromArgb(48, 73, 108) : Color.FromArgb(224, 230, 239);
        var accent = Color.FromArgb(251, 190, 55);
        var accentHover = Color.FromArgb(255, 205, 92);
        var accentDown = Color.FromArgb(235, 167, 27);
        var danger = _darkMode ? Color.FromArgb(255, 140, 140) : Color.FromArgb(190, 55, 55);
        var dangerBg = _darkMode ? Color.FromArgb(67, 35, 48) : Color.FromArgb(255, 244, 244);

        var form = new Form
        {
            Text = isLive ? "현재 수집 규칙 설정" : "다음 방송 규칙 설정",
            Width = 1120,
            Height = 830,
            MinimumSize = new Size(1040, 770),
            StartPosition = FormStartPosition.CenterParent,
            BackColor = bg,
            ForeColor = text,
            Font = new Font("맑은 고딕", 10F),
            AutoScaleMode = AutoScaleMode.None,
            FormBorderStyle = FormBorderStyle.None,
            MaximizeBox = false,
            MinimizeBox = false,
            ShowInTaskbar = false
        };

        Label MakeLabel(string value, float size = 10F, bool bold = false, Color? color = null) => new()
        {
            Text = value,
            AutoSize = true,
            ForeColor = color ?? text,
            BackColor = Color.Transparent,
            Font = new Font("맑은 고딕", size, bold ? FontStyle.Bold : FontStyle.Regular)
        };

        void Round(Control c, int radius)
        {
            void Apply() => ApplyRoundedRegion(c, radius);
            Apply();
            c.Resize += (_, _) => Apply();
        }

        void PaintCardBorder(Panel card, int radius = 14)
        {
            card.Paint += (_, e) =>
            {
                if (card.Width < 4 || card.Height < 4) return;
                e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                using var path = RoundedPath(new Rectangle(1, 1, card.Width - 2, card.Height - 2), radius);
                using var pen = new Pen(border, 1F);
                e.Graphics.DrawPath(pen, path);
            };
            Round(card, radius);
        }

        Panel MakeCard()
        {
            var p = new Panel
            {
                Dock = DockStyle.Fill,
                BackColor = surface,
                Padding = new Padding(12, 8, 12, 8),
                Margin = new Padding(0)
            };
            PaintCardBorder(p);
            return p;
        }

        void StyleInput(Control c)
        {
            c.BackColor = fieldBg;
            c.ForeColor = text;
            c.Font = new Font("맑은 고딕", 10F);
            c.Margin = new Padding(0);
            // DPI 배율에서 네이티브 편집 컨트롤의 권장 높이보다 작아져
            // 하단이 잘리는 문제를 막기 위해 입력 높이를 넉넉히 확보합니다.
            c.MinimumSize = Size.Empty;
            if (c is TextBox tb)
            {
                tb.AutoSize = false;
                tb.MinimumSize = Size.Empty;
                tb.MaximumSize = Size.Empty;
            }
        }

        TextBox MakeRuleNumberInput(string initialValue, int maxLength)
        {
            var tb = new TextBox
            {
                Text = initialValue,
                TextAlign = HorizontalAlignment.Left,
                MaxLength = maxLength,
                AutoSize = false,
                BorderStyle = BorderStyle.None
            };
            tb.KeyPress += (_, e) =>
            {
                if (!char.IsControl(e.KeyChar) && !char.IsDigit(e.KeyChar)) e.Handled = true;
            };
            return tb;
        }

        void StyleButton(Button b, bool primary = false, bool isDanger = false)
        {
            b.FlatStyle = FlatStyle.Flat;
            b.UseVisualStyleBackColor = false;
            b.Cursor = Cursors.Hand;
            b.Font = new Font("맑은 고딕", 9.8F, FontStyle.Bold);
            b.Padding = Padding.Empty;
            b.MinimumSize = Size.Empty;
            b.MaximumSize = Size.Empty;
            b.TextAlign = ContentAlignment.MiddleCenter;
            b.FlatAppearance.BorderSize = 0;

            if (primary)
            {
                b.BackColor = accent;
                b.ForeColor = Color.FromArgb(22, 31, 47);
                b.FlatAppearance.BorderColor = Color.FromArgb(228, 158, 20);
                b.FlatAppearance.MouseOverBackColor = accentHover;
                b.FlatAppearance.MouseDownBackColor = accentDown;
            }
            else if (isDanger)
            {
                b.BackColor = dangerBg;
                b.ForeColor = danger;
                b.FlatAppearance.BorderColor = _darkMode ? Color.FromArgb(104, 57, 67) : Color.FromArgb(244, 197, 197);
                b.FlatAppearance.MouseOverBackColor = _darkMode ? Color.FromArgb(83, 43, 57) : Color.FromArgb(255, 235, 235);
                b.FlatAppearance.MouseDownBackColor = _darkMode ? Color.FromArgb(92, 47, 61) : Color.FromArgb(250, 224, 224);
            }
            else
            {
                b.BackColor = surfaceAlt;
                b.ForeColor = text;
                b.FlatAppearance.BorderColor = border;
                b.FlatAppearance.MouseOverBackColor = _darkMode ? Color.FromArgb(31, 57, 92) : Color.FromArgb(241, 245, 249);
                b.FlatAppearance.MouseDownBackColor = _darkMode ? Color.FromArgb(38, 66, 104) : Color.FromArgb(232, 238, 245);
            }

            Color CanvasColor()
            {
                Control? c = b.Parent;
                while (c is not null && c.BackColor == Color.Transparent)
                    c = c.Parent;
                return c?.BackColor ?? bg;
            }

            var hovered = false;
            var pressed = false;
            b.MouseEnter += (_, _) => { hovered = true; b.Invalidate(); };
            b.MouseLeave += (_, _) => { hovered = false; pressed = false; b.Invalidate(); };
            b.MouseDown += (_, e) =>
            {
                if (e.Button != MouseButtons.Left) return;
                pressed = true;
                b.Invalidate();
            };
            b.MouseUp += (_, _) =>
            {
                pressed = false;
                b.Invalidate();
            };

            b.Paint += (_, e) =>
            {
                if (b.ClientSize.Width < 8 || b.ClientSize.Height < 8) return;

                // Control.Region을 전혀 사용하지 않습니다.
                // 전체 컨트롤을 부모 배경색으로 먼저 지운 뒤,
                // 사방 2px 안쪽에 rounded 버튼을 그려 아래/오른쪽 clipping을 차단합니다.
                e.Graphics.Clear(CanvasColor());
                e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;

                var fill = pressed
                    ? b.FlatAppearance.MouseDownBackColor
                    : hovered
                        ? b.FlatAppearance.MouseOverBackColor
                        : b.BackColor;

                var rect = new Rectangle(
                    2,
                    2,
                    Math.Max(1, b.ClientSize.Width - 5),
                    Math.Max(1, b.ClientSize.Height - 5));

                using var path = RoundedPath(rect, 8);
                using var brush = new SolidBrush(fill);
                using var pen = new Pen(b.FlatAppearance.BorderColor, 1F);

                e.Graphics.FillPath(brush, path);
                e.Graphics.DrawPath(pen, path);

                var textRect = Rectangle.Inflate(rect, -8, -3);
                TextRenderer.DrawText(
                    e.Graphics,
                    b.Text,
                    b.Font,
                    textRect,
                    b.ForeColor,
                    TextFormatFlags.HorizontalCenter |
                    TextFormatFlags.VerticalCenter |
                    TextFormatFlags.SingleLine |
                    TextFormatFlags.NoPrefix |
                    TextFormatFlags.EndEllipsis);
            };
        }

        Panel MakeField(string caption, Control input)
        {
            StyleInput(input);

            // 부모 row 높이와 무관하게 항상 같은 높이를 유지합니다.
            var box = new Panel
            {
                Dock = DockStyle.None,
                Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Top,
                Height = 58,
                Margin = new Padding(0, 0, 8, 0),
                BackColor = Color.Transparent,
            };

            var label = MakeLabel(caption, 9.2F, true, muted);
            label.AutoSize = false;
            label.Location = new Point(1, 0);
            label.Height = 22;
            label.TextAlign = ContentAlignment.MiddleLeft;
            label.Anchor = AnchorStyles.Left | AnchorStyles.Top | AnchorStyles.Right;

            var shell = new Panel
            {
                Location = new Point(0, 24),
                Height = 34,
                BackColor = fieldBg,
                Cursor = Cursors.IBeam,
                TabStop = false,
                Anchor = AnchorStyles.Left | AnchorStyles.Top | AnchorStyles.Right,
            };

            bool shellHover = false;
            bool shellFocus = false;

            void ResizeField()
            {
                box.Height = 58;
                label.Width = Math.Max(1, box.ClientSize.Width - 1);
                shell.Width = Math.Max(1, box.ClientSize.Width);

                const int left = 10;
                const int right = 10;
                const int inputHeight = 22;
                var y = Math.Max(1, (shell.ClientSize.Height - inputHeight) / 2);
                input.Bounds = new Rectangle(
                    left,
                    y,
                    Math.Max(10, shell.ClientSize.Width - left - right),
                    inputHeight);
            }

            shell.Paint += (_, e) =>
            {
                if (shell.ClientSize.Width < 5 || shell.ClientSize.Height < 5) return;

                e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                using var path = RoundedPath(
                    new Rectangle(1, 1, shell.ClientSize.Width - 3, shell.ClientSize.Height - 3),
                    8);

                using var fill = new SolidBrush(fieldBg);
                using var pen = new Pen(
                    (shellHover || shellFocus) ? accentHover : accent,
                    shellFocus ? 1.7F : 1.15F);

                e.Graphics.FillPath(fill, path);
                e.Graphics.DrawPath(pen, path);
            };

            input.Dock = DockStyle.None;
            input.Anchor = AnchorStyles.None;
            input.Margin = Padding.Empty;
            input.BackColor = fieldBg;
            input.ForeColor = text;
            input.Font = new Font("맑은 고딕", 9.6F, FontStyle.Regular);
            input.TabStop = true;

            if (input is TextBox tb)
            {
                tb.BorderStyle = BorderStyle.None;
                tb.AutoSize = false;
                tb.Multiline = false;
                tb.Height = 22;
            }

            shell.MouseEnter += (_, _) => { shellHover = true; shell.Invalidate(); };
            shell.MouseLeave += (_, _) => { shellHover = false; shell.Invalidate(); };
            shell.Click += (_, _) => input.Focus();

            input.Enter += (_, _) => { shellFocus = true; shell.Invalidate(); };
            input.Leave += (_, _) => { shellFocus = false; shell.Invalidate(); };
            input.MouseEnter += (_, _) => { shellHover = true; shell.Invalidate(); };
            input.MouseLeave += (_, _) => { shellHover = false; shell.Invalidate(); };

            shell.Controls.Add(input);
            box.Controls.Add(label);
            box.Controls.Add(shell);

            box.Resize += (_, _) => ResizeField();
            shell.Resize += (_, _) => ResizeField();
            ResizeField();

            return box;
        }

        Panel MakeActionField(string caption, Button button)
        {
            var box = new Panel
            {
                Dock = DockStyle.None,
                Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Top,
                Height = 58,
                Margin = new Padding(0),
                BackColor = Color.Transparent,
            };

            var label = MakeLabel(caption, 9.2F, true, muted);
            label.AutoSize = false;
            label.Location = new Point(1, 0);
            label.Height = 22;
            label.TextAlign = ContentAlignment.MiddleLeft;
            label.Anchor = AnchorStyles.Left | AnchorStyles.Top | AnchorStyles.Right;

            button.Dock = DockStyle.None;
            button.AutoSize = false;
            button.MinimumSize = Size.Empty;
            button.MaximumSize = Size.Empty;
            button.Height = 34;
            button.Margin = Padding.Empty;
            button.Padding = Padding.Empty;
            button.TextAlign = ContentAlignment.MiddleCenter;
            button.Anchor = AnchorStyles.Left | AnchorStyles.Top | AnchorStyles.Right;

            void ResizeAction()
            {
                box.Height = 58;
                label.Width = Math.Max(1, box.ClientSize.Width - 1);
                button.Bounds = new Rectangle(
                    2,
                    25,
                    Math.Max(1, box.ClientSize.Width - 4),
                    32);
            }

            box.Controls.Add(label);
            box.Controls.Add(button);
            box.Resize += (_, _) => ResizeAction();
            ResizeAction();

            return box;
        }

        void StyleGrid(DataGridView g)
        {
            g.BackgroundColor = surface;
            g.BorderStyle = BorderStyle.None;
            g.CellBorderStyle = DataGridViewCellBorderStyle.SingleHorizontal;
            g.ColumnHeadersBorderStyle = DataGridViewHeaderBorderStyle.None;
            g.GridColor = border;
            g.EnableHeadersVisualStyles = false;
            g.ColumnHeadersHeight = 42;
            g.ColumnHeadersHeightSizeMode = DataGridViewColumnHeadersHeightSizeMode.DisableResizing;
            g.RowTemplate.Height = 42;
            g.DefaultCellStyle.BackColor = surface;
            g.DefaultCellStyle.ForeColor = text;
            g.DefaultCellStyle.SelectionBackColor = _darkMode ? Color.FromArgb(38, 61, 92) : Color.FromArgb(255, 248, 229);
            g.DefaultCellStyle.SelectionForeColor = text;
            g.DefaultCellStyle.Font = new Font("맑은 고딕", 9.6F);
            g.DefaultCellStyle.Padding = new Padding(8, 0, 8, 0);
            g.ColumnHeadersDefaultCellStyle.BackColor = surfaceAlt;
            g.ColumnHeadersDefaultCellStyle.ForeColor = muted;
            // 포커스/정렬 상태에서도 Windows 기본 파란 헤더가 튀어나오지 않도록
            // 선택 헤더 색도 별록 테마 색으로 고정합니다.
            g.ColumnHeadersDefaultCellStyle.SelectionBackColor = surfaceAlt;
            g.ColumnHeadersDefaultCellStyle.SelectionForeColor = muted;
            g.ColumnHeadersDefaultCellStyle.Font = new Font("맑은 고딕", 9.2F, FontStyle.Bold);
            g.ColumnHeadersDefaultCellStyle.Padding = new Padding(8, 0, 8, 0);
            g.DefaultCellStyle.WrapMode = DataGridViewTriState.False;
            g.ColumnAdded += (_, e) =>
            {
                // 규칙 목록은 편집/삭제 버튼으로 조작하므로 헤더 정렬 UI가 필요 없습니다.
                // 자동 정렬을 끄면 클릭/포커스 시 시스템 파란색 헤더가 나타나는 문제도 사라집니다.
                e.Column.SortMode = DataGridViewColumnSortMode.NotSortable;
                e.Column.HeaderCell.Style.SelectionBackColor = surfaceAlt;
                e.Column.HeaderCell.Style.SelectionForeColor = muted;
            };
        }

        void StyleGridButtonColumn(DataGridViewButtonColumn col, bool isDelete = false)
        {
            col.FlatStyle = FlatStyle.Flat;
            col.DefaultCellStyle.Alignment = DataGridViewContentAlignment.MiddleCenter;
            col.DefaultCellStyle.Padding = new Padding(7, 6, 7, 6);
            col.DefaultCellStyle.BackColor = isDelete ? dangerBg : surfaceAlt;
            col.DefaultCellStyle.ForeColor = isDelete ? danger : text;
            col.DefaultCellStyle.SelectionBackColor = isDelete ? dangerBg : surfaceAlt;
            col.DefaultCellStyle.SelectionForeColor = isDelete ? danger : text;
        }

        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(22, 24, 22, 18),
            RowCount = 4,
            ColumnCount = 1,
            BackColor = bg
        };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 100));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 58));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 88));

        var header = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            AutoSize = false,
            ColumnCount = 1,
            RowCount = 2,
            BackColor = Color.Transparent,
            Margin = new Padding(0, 0, 0, 10)
        };
        header.RowStyles.Add(new RowStyle(SizeType.Absolute, 46));
        header.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        var headerTitle = MakeLabel(isLive ? "현재 수집 규칙" : "다음 방송 규칙", 17F, true);
        headerTitle.Margin = new Padding(0, 0, 0, 4);
        var headerSub = MakeLabel(
            "별풍선 금액별 룰렛 규칙과 고정 업보 규칙을 설정합니다. 두 규칙은 서로 독립적으로 함께 적용할 수 있습니다.",
            9.4F, false, muted);
        header.Controls.Add(headerTitle, 0, 0);
        header.Controls.Add(headerSub, 0, 1);
        root.Controls.Add(header, 0, 0);

        // 네이티브 타이틀바가 없으므로 규칙 설정창의 상단 전체를 드래그 영역으로 사용합니다.
        bool rulesDragging = false;
        Point rulesDragCursor = Point.Empty;
        Point rulesDragForm = Point.Empty;

        void RulesDragBegin(object? sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;
            rulesDragging = true;
            rulesDragCursor = Cursor.Position;
            rulesDragForm = form.Location;
        }

        void RulesDragMove(object? sender, MouseEventArgs e)
        {
            if (!rulesDragging || e.Button != MouseButtons.Left) return;
            var delta = new Point(Cursor.Position.X - rulesDragCursor.X, Cursor.Position.Y - rulesDragCursor.Y);
            form.Location = new Point(rulesDragForm.X + delta.X, rulesDragForm.Y + delta.Y);
        }

        void RulesDragEnd(object? sender, MouseEventArgs e) => rulesDragging = false;

        foreach (Control dragControl in new Control[] { form, root, header, headerTitle, headerSub })
        {
            dragControl.MouseDown += RulesDragBegin;
            dragControl.MouseMove += RulesDragMove;
            dragControl.MouseUp += RulesDragEnd;
        }


        var nav = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false,
            BackColor = Color.Transparent,
            Padding = new Padding(0),
            Margin = new Padding(0)
        };
        var rouletteNav = new Button { Text = "룰렛 규칙", Width = 142, Height = 42, Margin = new Padding(0, 5, 8, 5) };
        var fixedNav = new Button { Text = "고정 규칙", Width = 142, Height = 42, Margin = new Padding(0, 5, 0, 5) };
        StyleButton(rouletteNav);
        StyleButton(fixedNav);
        nav.Controls.Add(rouletteNav);
        nav.Controls.Add(fixedNav);
        root.Controls.Add(nav, 0, 1);

        var contentHost = new Panel { Dock = DockStyle.Fill, BackColor = bg, Margin = new Padding(0) };
        root.Controls.Add(contentHost, 0, 2);

        // ── 룰렛 규칙 페이지 ─────────────────────────────────────
        var roulettePage = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 2,
            BackColor = bg,
            Padding = new Padding(0),
            Margin = new Padding(0)
        };
        roulettePage.RowStyles.Add(new RowStyle(SizeType.Absolute, 156));
        roulettePage.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

        var rouletteInputCard = MakeCard();
        rouletteInputCard.Margin = new Padding(0, 0, 0, 12);
        var rouletteInputRoot = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 3,
            BackColor = Color.Transparent,
            Margin = new Padding(0)
        };
        rouletteInputRoot.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
        rouletteInputRoot.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
        rouletteInputRoot.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        var rouletteTitle = MakeLabel("새 룰렛 규칙", 11.3F, true);
        var rouletteHint = MakeLabel("별풍선 금액에 따라 예상 룰렛 횟수와 이벤트명을 지정합니다.", 9.1F, false, muted);
        rouletteTitle.Margin = new Padding(0);
        rouletteHint.Margin = new Padding(0);
        rouletteInputRoot.Controls.Add(rouletteTitle, 0, 0);
        rouletteInputRoot.Controls.Add(rouletteHint, 0, 1);

        var balloons = MakeRuleNumberInput("1", 8);
        var spins = MakeRuleNumberInput("1", 4);
        var eventName = new TextBox { PlaceholderText = "예: 8월 이벤트", AutoSize = false };
        var add = new Button { Text = "+ 규칙 추가" };
        StyleButton(add, primary: true);

        var rouletteFields = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            Height = 58,
            ColumnCount = 5,
            RowCount = 1,
            BackColor = Color.Transparent,
            Margin = new Padding(0, 2, 0, 0),
            Padding = new Padding(0)
        };
        rouletteFields.RowStyles.Add(new RowStyle(SizeType.Absolute, 58));
        // 입력칸은 더 이상 창 폭 전체에 비례해 커지지 않습니다.
        rouletteFields.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 85));
        rouletteFields.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 85));
        rouletteFields.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 165));
        rouletteFields.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 190));
        rouletteFields.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        rouletteFields.Controls.Add(MakeField("별풍선", balloons), 0, 0);
        rouletteFields.Controls.Add(MakeField("룰렛 횟수", spins), 1, 0);
        rouletteFields.Controls.Add(MakeField("이벤트명", eventName), 2, 0);
        rouletteFields.Controls.Add(MakeActionField("작업", add), 3, 0);
        rouletteInputRoot.Controls.Add(rouletteFields, 0, 2);
        rouletteInputCard.Controls.Add(rouletteInputRoot);
        roulettePage.Controls.Add(rouletteInputCard, 0, 0);

        var rouletteListCard = MakeCard();
        var rouletteListRoot = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 2,
            BackColor = Color.Transparent,
            Margin = new Padding(0)
        };
        rouletteListRoot.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
        rouletteListRoot.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        var rouletteListHeader = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.LeftToRight, WrapContents = false, BackColor = Color.Transparent, Margin = new Padding(0) };
        var rouletteListTitle = MakeLabel("등록된 룰렛 규칙", 11F, true);
        var rouletteCount = MakeLabel("0개", 9.2F, false, muted);
        rouletteListTitle.Margin = new Padding(0, 2, 8, 0);
        rouletteCount.Margin = new Padding(0, 5, 0, 0);
        rouletteListHeader.Controls.Add(rouletteListTitle);
        rouletteListHeader.Controls.Add(rouletteCount);
        rouletteListRoot.Controls.Add(rouletteListHeader, 0, 0);

        var grid = new DataGridView
        {
            Dock = DockStyle.Fill,
            AutoGenerateColumns = false,
            AllowUserToAddRows = false,
            AllowUserToDeleteRows = false,
            AllowUserToResizeRows = false,
            ReadOnly = true,
            RowHeadersVisible = false,
            SelectionMode = DataGridViewSelectionMode.FullRowSelect,
            MultiSelect = false,
            AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill,
            Margin = new Padding(0)
        };
        StyleGrid(grid);
        grid.Columns.Add(new DataGridViewTextBoxColumn { Name = "Balloons", HeaderText = "별풍선", FillWeight = 18 });
        grid.Columns.Add(new DataGridViewTextBoxColumn { Name = "Spins", HeaderText = "룰렛 횟수", FillWeight = 18 });
        grid.Columns.Add(new DataGridViewTextBoxColumn { Name = "Event", HeaderText = "이벤트명", FillWeight = 42 });
        var rouletteEditColumn = new DataGridViewButtonColumn { Name = "Edit", HeaderText = "수정", Text = "수정", UseColumnTextForButtonValue = true, FillWeight = 11 };
        var rouletteDeleteColumn = new DataGridViewButtonColumn { Name = "Delete", HeaderText = "삭제", Text = "삭제", UseColumnTextForButtonValue = true, FillWeight = 11 };
        StyleGridButtonColumn(rouletteEditColumn);
        StyleGridButtonColumn(rouletteDeleteColumn, true);
        grid.Columns.Add(rouletteEditColumn);
        grid.Columns.Add(rouletteDeleteColumn);
        rouletteListRoot.Controls.Add(grid, 0, 1);
        rouletteListCard.Controls.Add(rouletteListRoot);
        roulettePage.Controls.Add(rouletteListCard, 0, 1);

        // ── 고정 규칙 페이지 ─────────────────────────────────────
        var fixedPage = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 2,
            BackColor = bg,
            Padding = new Padding(0),
            Margin = new Padding(0)
        };
        fixedPage.RowStyles.Add(new RowStyle(SizeType.Absolute, 156));
        fixedPage.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

        var fixedInputCard = MakeCard();
        fixedInputCard.Margin = new Padding(0, 0, 0, 12);
        var fixedInputRoot = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 3,
            BackColor = Color.Transparent,
            Margin = new Padding(0)
        };
        fixedInputRoot.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
        fixedInputRoot.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
        fixedInputRoot.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        var fixedTitle = MakeLabel("새 고정 규칙", 11.3F, true);
        var fixedHint = MakeLabel("정해진 후원 금액에 고정으로 증정할 업보를 지정합니다. 룰렛 규칙과 동시에 적용할 수 있습니다.", 9.1F, false, muted);
        fixedTitle.Margin = new Padding(0);
        fixedHint.Margin = new Padding(0);
        fixedInputRoot.Controls.Add(fixedTitle, 0, 0);
        fixedInputRoot.Controls.Add(fixedHint, 0, 1);

        var fb = MakeRuleNumberInput("1", 8);
        var fe = new TextBox { PlaceholderText = "예: 8월 이벤트", AutoSize = false };
        var ft = new TextBox { PlaceholderText = "예: 고정", AutoSize = false };
        var fq = MakeRuleNumberInput("1", 4);
        var fa = new Button { Text = "+ 규칙 추가" };
        StyleButton(fa, primary: true);

        var fixedFields = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            Height = 58,
            ColumnCount = 6,
            RowCount = 1,
            BackColor = Color.Transparent,
            Margin = new Padding(0, 2, 0, 0),
            Padding = new Padding(0)
        };
        fixedFields.RowStyles.Add(new RowStyle(SizeType.Absolute, 58));
        fixedFields.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 80));
        fixedFields.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 135));
        fixedFields.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 135));
        fixedFields.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 70));
        fixedFields.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 180));
        fixedFields.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        fixedFields.Controls.Add(MakeField("별풍선", fb), 0, 0);
        fixedFields.Controls.Add(MakeField("이벤트명", fe), 1, 0);
        fixedFields.Controls.Add(MakeField("업보종류", ft), 2, 0);
        fixedFields.Controls.Add(MakeField("수량", fq), 3, 0);
        fixedFields.Controls.Add(MakeActionField("작업", fa), 4, 0);
        fixedInputRoot.Controls.Add(fixedFields, 0, 2);
        fixedInputCard.Controls.Add(fixedInputRoot);
        fixedPage.Controls.Add(fixedInputCard, 0, 0);

        var fixedListCard = MakeCard();
        var fixedListRoot = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 2,
            BackColor = Color.Transparent,
            Margin = new Padding(0)
        };
        fixedListRoot.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
        fixedListRoot.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        var fixedListHeader = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.LeftToRight, WrapContents = false, BackColor = Color.Transparent, Margin = new Padding(0) };
        var fixedListTitle = MakeLabel("등록된 고정 규칙", 11F, true);
        var fixedCount = MakeLabel("0개", 9.2F, false, muted);
        fixedListTitle.Margin = new Padding(0, 2, 8, 0);
        fixedCount.Margin = new Padding(0, 5, 0, 0);
        fixedListHeader.Controls.Add(fixedListTitle);
        fixedListHeader.Controls.Add(fixedCount);
        fixedListRoot.Controls.Add(fixedListHeader, 0, 0);

        var fixedGrid = new DataGridView
        {
            Dock = DockStyle.Fill,
            AutoGenerateColumns = false,
            AllowUserToAddRows = false,
            AllowUserToDeleteRows = false,
            AllowUserToResizeRows = false,
            ReadOnly = true,
            RowHeadersVisible = false,
            SelectionMode = DataGridViewSelectionMode.FullRowSelect,
            MultiSelect = false,
            AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill,
            Margin = new Padding(0)
        };
        StyleGrid(fixedGrid);
        fixedGrid.Columns.Add(new DataGridViewTextBoxColumn { Name = "Balloons", HeaderText = "별풍선", FillWeight = 16 });
        fixedGrid.Columns.Add(new DataGridViewTextBoxColumn { Name = "Event", HeaderText = "이벤트명", FillWeight = 28 });
        fixedGrid.Columns.Add(new DataGridViewTextBoxColumn { Name = "Type", HeaderText = "업보종류", FillWeight = 26 });
        fixedGrid.Columns.Add(new DataGridViewTextBoxColumn { Name = "Qty", HeaderText = "수량", FillWeight = 10 });
        var fixedEditColumn = new DataGridViewButtonColumn { Name = "Edit", HeaderText = "수정", Text = "수정", UseColumnTextForButtonValue = true, FillWeight = 10 };
        var fixedDeleteColumn = new DataGridViewButtonColumn { Name = "Delete", HeaderText = "삭제", Text = "삭제", UseColumnTextForButtonValue = true, FillWeight = 10 };
        StyleGridButtonColumn(fixedEditColumn);
        StyleGridButtonColumn(fixedDeleteColumn, true);
        fixedGrid.Columns.Add(fixedEditColumn);
        fixedGrid.Columns.Add(fixedDeleteColumn);
        fixedListRoot.Controls.Add(fixedGrid, 0, 1);
        fixedListCard.Controls.Add(fixedListRoot);
        fixedPage.Controls.Add(fixedListCard, 0, 1);

        contentHost.Controls.Add(roulettePage);
        contentHost.Controls.Add(fixedPage);

        void SetPage(bool fixedMode)
        {
            roulettePage.Visible = !fixedMode;
            fixedPage.Visible = fixedMode;
            if (fixedMode) fixedPage.BringToFront(); else roulettePage.BringToFront();

            void SetNav(Button b, bool active)
            {
                b.BackColor = active ? accent : surfaceAlt;
                b.ForeColor = active ? Color.FromArgb(22, 31, 47) : text;
                b.FlatAppearance.BorderColor = active ? Color.FromArgb(228, 158, 20) : border;
                b.FlatAppearance.MouseOverBackColor = active ? accentHover : (_darkMode ? Color.FromArgb(31, 57, 92) : Color.FromArgb(241, 245, 249));
                b.FlatAppearance.MouseDownBackColor = active ? accentDown : (_darkMode ? Color.FromArgb(38, 66, 104) : Color.FromArgb(232, 238, 245));
            }
            SetNav(rouletteNav, !fixedMode);
            SetNav(fixedNav, fixedMode);
        }
        rouletteNav.Click += (_, _) => SetPage(false);
        fixedNav.Click += (_, _) => SetPage(true);

        void RefreshGrid()
        {
            grid.Rows.Clear();
            foreach (var r in workingRules.OrderBy(r => r.Balloons))
                grid.Rows.Add(r.Balloons, r.ExpectedSpins, r.EventName);
            rouletteCount.Text = $"{workingRules.Count:N0}개";
        }

        void RefreshFixedGrid()
        {
            fixedGrid.Rows.Clear();
            foreach (var r in workingFixedRules.OrderBy(r => r.Balloons).ThenBy(r => r.EventName).ThenBy(r => r.UpboType))
                fixedGrid.Rows.Add(r.Balloons, r.EventName, r.UpboType, r.Quantity);
            fixedCount.Text = $"{workingFixedRules.Count:N0}개";
        }

        bool FixedDuplicate(FixedRewardRule r, FixedRewardRule? except = null) =>
            workingFixedRules.Any(x => !ReferenceEquals(x, except)
                && x.Balloons == r.Balloons
                && string.Equals(x.EventName.Trim(), r.EventName.Trim(), StringComparison.Ordinal)
                && string.Equals(x.UpboType.Trim(), r.UpboType.Trim(), StringComparison.Ordinal));

        Form MakeEditDialog(string title, int height)
        {
            var edit = new Form
            {
                Text = title,
                Width = 520,
                Height = height,
                MinimumSize = new Size(500, height),
                StartPosition = FormStartPosition.CenterParent,
                FormBorderStyle = FormBorderStyle.FixedDialog,
                MaximizeBox = false,
                MinimizeBox = false,
                BackColor = bg,
                ForeColor = text,
                Font = new Font("맑은 고딕", 10F),
                AutoScaleMode = AutoScaleMode.Dpi
            };
            return edit;
        }

        void AddEditRow(TableLayoutPanel panel, int row, string caption, Control input)
        {
            StyleInput(input);
            input.Dock = DockStyle.Fill;
            input.Margin = new Padding(0, 5, 0, 5);
            var label = MakeLabel(caption, 9.4F, true, muted);
            label.Anchor = AnchorStyles.Left;
            label.Margin = new Padding(0);
            panel.Controls.Add(label, 0, row);
            panel.Controls.Add(input, 1, row);
        }

        add.Click += (_, _) =>
        {
            if (!long.TryParse(balloons.Text.Trim(), out var b) || b < 1 || b > 10000000)
            {
                MessageBox.Show("별풍선은 1~10,000,000 사이의 숫자로 입력해주세요.", "룰렛 설정");
                balloons.Focus();
                return;
            }
            if (!int.TryParse(spins.Text.Trim(), out var sp) || sp < 1 || sp > 1000)
            {
                MessageBox.Show("룰렛 횟수는 1~1,000 사이의 숫자로 입력해주세요.", "룰렛 설정");
                spins.Focus();
                return;
            }
            var ev = eventName.Text.Trim();
            if (ev.Length == 0) { MessageBox.Show("이벤트명을 입력해주세요.", "룰렛 설정"); return; }
            if (workingRules.Any(r => r.Balloons == b)) { MessageBox.Show("같은 별풍선 금액의 룰렛 규칙이 이미 있습니다. 아래 목록에서 수정해주세요.", "룰렛 설정"); return; }
            workingRules.Add(new RouletteEventRule(b, sp, ev));
            eventName.Clear();
            eventName.Focus();
            RefreshGrid();
        };

        fa.Click += (_, _) =>
        {
            if (!long.TryParse(fb.Text.Trim(), out var fixedBalloons) || fixedBalloons < 1 || fixedBalloons > 10000000)
            {
                MessageBox.Show("별풍선은 1~10,000,000 사이의 숫자로 입력해주세요.", "고정 규칙 설정");
                fb.Focus();
                return;
            }
            if (!int.TryParse(fq.Text.Trim(), out var fixedQuantity) || fixedQuantity < 1 || fixedQuantity > 1000)
            {
                MessageBox.Show("수량은 1~1,000 사이의 숫자로 입력해주세요.", "고정 규칙 설정");
                fq.Focus();
                return;
            }
            var rule = new FixedRewardRule(fixedBalloons, fe.Text.Trim(), ft.Text.Trim(), fixedQuantity);
            if (rule.EventName.Length == 0) { MessageBox.Show("이벤트명을 입력해주세요.", "고정 규칙 설정"); return; }
            if (rule.UpboType.Length == 0) { MessageBox.Show("업보종류를 입력해주세요.", "고정 규칙 설정"); return; }
            if (FixedDuplicate(rule)) { MessageBox.Show("같은 별풍선·이벤트·업보종류의 고정 규칙이 이미 있습니다. 아래 목록에서 수정해주세요.", "고정 규칙 설정"); return; }
            workingFixedRules.Add(rule);
            ft.Clear();
            ft.Focus();
            RefreshFixedGrid();
        };

        grid.CellContentClick += (_, e) =>
        {
            if (e.RowIndex < 0 || e.ColumnIndex < 0) return;
            var columnName = grid.Columns[e.ColumnIndex].Name;
            if (columnName != "Edit" && columnName != "Delete") return;
            var b = Convert.ToInt64(grid.Rows[e.RowIndex].Cells["Balloons"].Value);
            var current = workingRules.FirstOrDefault(r => r.Balloons == b);
            if (current is null) return;

            if (columnName == "Delete")
            {
                if (MessageBox.Show($"{current.Balloons:N0}개 룰렛 규칙을 삭제할까요?", "룰렛 설정", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
                workingRules.Remove(current);
                RefreshGrid();
                return;
            }

            var edit = MakeEditDialog("룰렛 규칙 수정", 360);
            var eroot = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                Padding = new Padding(22),
                ColumnCount = 2,
                RowCount = 5,
                BackColor = bg
            };
            eroot.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 105));
            eroot.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            eroot.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
            eroot.RowStyles.Add(new RowStyle(SizeType.Absolute, 54));
            eroot.RowStyles.Add(new RowStyle(SizeType.Absolute, 54));
            eroot.RowStyles.Add(new RowStyle(SizeType.Absolute, 54));
            eroot.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            var eTitle = MakeLabel("룰렛 규칙 수정", 14F, true);
            eroot.Controls.Add(eTitle, 0, 0);
            eroot.SetColumnSpan(eTitle, 2);
            var eb = MakeRuleNumberInput(Math.Min(10000000, current.Balloons).ToString(), 8);
            var es = MakeRuleNumberInput(Math.Min(1000, current.ExpectedSpins).ToString(), 4);
            var ee = new TextBox { Text = current.EventName, AutoSize = false, Height = 42, MinimumSize = new Size(0, 42), MaximumSize = new Size(0, 42) };
            AddEditRow(eroot, 1, "별풍선", eb);
            AddEditRow(eroot, 2, "룰렛 횟수", es);
            AddEditRow(eroot, 3, "이벤트명", ee);
            var eFooter = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, WrapContents = false, BackColor = Color.Transparent, Padding = new Padding(0, 12, 0, 0) };
            var eSave = new Button { Text = "수정 저장", Width = 110, Height = 40, Margin = new Padding(8, 0, 0, 0) };
            var eCancel = new Button { Text = "취소", Width = 88, Height = 40, Margin = new Padding(0) };
            StyleButton(eSave, true);
            StyleButton(eCancel);
            eFooter.Controls.Add(eSave);
            eFooter.Controls.Add(eCancel);
            eroot.Controls.Add(eFooter, 0, 4);
            eroot.SetColumnSpan(eFooter, 2);
            eCancel.Click += (_, _) => edit.Close();
            eSave.Click += (_, _) =>
            {
                if (!long.TryParse(eb.Text.Trim(), out var nb) || nb < 1 || nb > 10000000)
                {
                    MessageBox.Show("별풍선은 1~10,000,000 사이의 숫자로 입력해주세요.");
                    eb.Focus();
                    return;
                }
                if (!int.TryParse(es.Text.Trim(), out var nsp) || nsp < 1 || nsp > 1000)
                {
                    MessageBox.Show("룰렛 횟수는 1~1,000 사이의 숫자로 입력해주세요.");
                    es.Focus();
                    return;
                }
                var nev = ee.Text.Trim();
                if (nev.Length == 0) { MessageBox.Show("이벤트명을 입력해주세요."); return; }
                if (workingRules.Any(r => !ReferenceEquals(r, current) && r.Balloons == nb)) { MessageBox.Show("같은 별풍선 금액의 룰렛 규칙이 이미 있습니다."); return; }
                var idx = workingRules.IndexOf(current);
                workingRules[idx] = new RouletteEventRule(nb, nsp, nev);
                edit.DialogResult = DialogResult.OK;
                edit.Close();
            };
            edit.Controls.Add(eroot);
            if (edit.ShowDialog(form) == DialogResult.OK) RefreshGrid();
        };

        fixedGrid.CellContentClick += (_, e) =>
        {
            if (e.RowIndex < 0 || e.ColumnIndex < 0) return;
            var columnName = fixedGrid.Columns[e.ColumnIndex].Name;
            if (columnName != "Edit" && columnName != "Delete") return;
            var b = Convert.ToInt64(fixedGrid.Rows[e.RowIndex].Cells["Balloons"].Value);
            var ev = Convert.ToString(fixedGrid.Rows[e.RowIndex].Cells["Event"].Value) ?? "";
            var ty = Convert.ToString(fixedGrid.Rows[e.RowIndex].Cells["Type"].Value) ?? "";
            var current = workingFixedRules.FirstOrDefault(r => r.Balloons == b && r.EventName == ev && r.UpboType == ty);
            if (current is null) return;

            if (columnName == "Delete")
            {
                if (MessageBox.Show($"{current.Balloons:N0}개 · {current.EventName} · {current.UpboType} {current.Quantity}장 규칙을 삭제할까요?", "고정 규칙 설정", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
                workingFixedRules.Remove(current);
                RefreshFixedGrid();
                return;
            }

            var edit = MakeEditDialog("고정 규칙 수정", 420);
            var eroot = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                Padding = new Padding(22),
                ColumnCount = 2,
                RowCount = 6,
                BackColor = bg
            };
            eroot.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 105));
            eroot.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            eroot.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
            for (var i = 1; i <= 4; i++) eroot.RowStyles.Add(new RowStyle(SizeType.Absolute, 54));
            eroot.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            var eTitle = MakeLabel("고정 규칙 수정", 14F, true);
            eroot.Controls.Add(eTitle, 0, 0);
            eroot.SetColumnSpan(eTitle, 2);
            var eb = MakeRuleNumberInput(Math.Min(10000000, current.Balloons).ToString(), 8);
            var ee = new TextBox { Text = current.EventName, AutoSize = false, Height = 42, MinimumSize = new Size(0, 42), MaximumSize = new Size(0, 42) };
            var et = new TextBox { Text = current.UpboType, AutoSize = false, Height = 42, MinimumSize = new Size(0, 42), MaximumSize = new Size(0, 42) };
            var eq = MakeRuleNumberInput(Math.Min(1000, current.Quantity).ToString(), 4);
            AddEditRow(eroot, 1, "별풍선", eb);
            AddEditRow(eroot, 2, "이벤트명", ee);
            AddEditRow(eroot, 3, "업보종류", et);
            AddEditRow(eroot, 4, "수량", eq);
            var eFooter = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, WrapContents = false, BackColor = Color.Transparent, Padding = new Padding(0, 12, 0, 0) };
            var eSave = new Button { Text = "수정 저장", Width = 110, Height = 40, Margin = new Padding(8, 0, 0, 0) };
            var eCancel = new Button { Text = "취소", Width = 88, Height = 40, Margin = new Padding(0) };
            StyleButton(eSave, true);
            StyleButton(eCancel);
            eFooter.Controls.Add(eSave);
            eFooter.Controls.Add(eCancel);
            eroot.Controls.Add(eFooter, 0, 5);
            eroot.SetColumnSpan(eFooter, 2);
            eCancel.Click += (_, _) => edit.Close();
            eSave.Click += (_, _) =>
            {
                if (!long.TryParse(eb.Text.Trim(), out var editBalloons) || editBalloons < 1 || editBalloons > 10000000)
                {
                    MessageBox.Show("별풍선은 1~10,000,000 사이의 숫자로 입력해주세요.");
                    eb.Focus();
                    return;
                }
                if (!int.TryParse(eq.Text.Trim(), out var editQuantity) || editQuantity < 1 || editQuantity > 1000)
                {
                    MessageBox.Show("수량은 1~1,000 사이의 숫자로 입력해주세요.");
                    eq.Focus();
                    return;
                }
                var nr = new FixedRewardRule(editBalloons, ee.Text.Trim(), et.Text.Trim(), editQuantity);
                if (nr.EventName.Length == 0) { MessageBox.Show("이벤트명을 입력해주세요."); return; }
                if (nr.UpboType.Length == 0) { MessageBox.Show("업보종류를 입력해주세요."); return; }
                if (FixedDuplicate(nr, current)) { MessageBox.Show("같은 별풍선·이벤트·업보종류의 고정 규칙이 이미 있습니다."); return; }
                var idx = workingFixedRules.IndexOf(current);
                workingFixedRules[idx] = nr;
                edit.DialogResult = DialogResult.OK;
                edit.Close();
            };
            edit.Controls.Add(eroot);
            if (edit.ShowDialog(form) == DialogResult.OK) RefreshFixedGrid();
        };

        // ── 하단 액션 ─────────────────────────────────────────────
        var footer = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            RowCount = 1,
            BackColor = Color.Transparent,
            Margin = new Padding(0, 8, 0, 0),
            Padding = new Padding(0, 4, 0, 4)
        };
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 280));
        var footerNote = MakeLabel("변경 내용은 ‘설정 저장’을 눌러야 적용됩니다.", 9F, false, muted);
        footerNote.Anchor = AnchorStyles.Left | AnchorStyles.Top | AnchorStyles.Bottom;
        footerNote.TextAlign = ContentAlignment.MiddleLeft;
        var footerActions = new FlowLayoutPanel
        {
            AutoSize = false,
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.RightToLeft,
            WrapContents = false,
            BackColor = Color.Transparent,
            Margin = new Padding(0),
            Padding = new Padding(0, 6, 0, 6)
        };
        var save = new Button
        {
            Text = "설정 저장",
            AutoSize = false,
            Size = new Size(148, 46),
            MinimumSize = Size.Empty,
            MaximumSize = Size.Empty,
            Padding = Padding.Empty,
            Margin = new Padding(8, 8, 0, 8),
            TextAlign = ContentAlignment.MiddleCenter
        };
        var close = new Button
        {
            Text = "닫기",
            AutoSize = false,
            Size = new Size(104, 46),
            MinimumSize = Size.Empty,
            MaximumSize = Size.Empty,
            Padding = Padding.Empty,
            Margin = new Padding(0, 8, 0, 8),
            TextAlign = ContentAlignment.MiddleCenter
        };
        StyleButton(save, true);
        StyleButton(close);
        footerActions.Controls.Add(save);
        footerActions.Controls.Add(close);
        footer.Controls.Add(footerNote, 0, 0);
        footer.Controls.Add(footerActions, 1, 0);
        root.Controls.Add(footer, 0, 3);

        save.Click += (_, _) =>
        {
            if (isLive)
            {
                _storage.SaveSessionRules(s!.Id, workingRules);
                _storage.SaveSessionFixedRules(s.Id, workingFixedRules);
            }
            else
            {
                _storage.SaveDraftRules(workingRules);
                _storage.SaveDraftFixedRules(workingFixedRules);
            }
            _storage.Log($"규칙 설정 저장: 룰렛 {workingRules.Count}개 · 고정 {workingFixedRules.Count}개 · {(isLive ? "현재 수집" : "다음 방송")}");
            RefreshSessionStats();
            MessageBox.Show("룰렛 규칙과 고정 규칙을 저장했습니다.", "규칙 설정");
        };
        close.Click += (_, _) => form.Close();

        RefreshGrid();
        RefreshFixedGrid();
        SetPage(false);
        form.Controls.Add(root);
        ApplyRoundedRegion(form, 18);
        form.Resize += (_, _) => ApplyRoundedRegion(form, 18);
        form.ShowDialog(this);
    }

    private void UpdateUploadUi(string? statusText = null)
    {
        var s = _storage.Session;
        var pending = s is null ? 0 : _storage.PendingUploadCount(s.Id);
        _uploadPending.Text = $"{pending:N0}건";
        if (!string.IsNullOrWhiteSpace(statusText)) _uploadStatus.Text = statusText;
        else if (_uploadInProgress) _uploadStatus.Text = "● 업로드 중";
        else if (pending > 0 && DateTime.Now < _nextUploadRetryAt) _uploadStatus.Text = "● 재연결 대기";
        else _uploadStatus.Text = "● 동작 중";

        var ok = _uploadStatus.Text.Contains("동작") || _uploadStatus.Text.Contains("업로드 중");
        _uploadStatus.ForeColor = ok
            ? (_darkMode ? Color.FromArgb(91, 226, 147) : Color.FromArgb(31, 143, 82))
            : (_darkMode ? Color.FromArgb(255, 193, 77) : Color.FromArgb(186, 120, 0));
        NotifyMainUi();
    }

    private async Task UploadSessionAsync()
    {
        await UploadSessionCoreAsync(manual: true);
    }

    private void ScheduleRealtimeUpload()
    {
        var s = _storage.Session;
        if (s is null) return;
        UpdateUploadUi("● 전송 대기");
        _autoUploadTimer.Stop();
        _autoUploadTimer.Start(); // 신규 수신을 2초간 짧게 묶어서 전송
        if (_vNextDevClient.IsSignedIn)
        {
            _vNextDevUploadTimer.Stop();
            // 자동화는 통계 업로드용 2초 묶음과 분리해 즉시 전송합니다.
            // 실행 중 추가된 행은 finally의 100ms fallback이 이어서 보냅니다.
            _ = MirrorVNextDevelopmentAsync();
        }
    }

    private async Task AutoUploadTickAsync()
    {
        if (_uploadInProgress || _storage.Session is null) return;
        await UploadSessionCoreAsync(manual: false);
    }

    private async Task RetryPendingUploadTickAsync(bool force = false)
    {
        if (_uploadInProgress) return;
        var s = _storage.Session;
        if (s is null || _storage.PendingUploadCount(s.Id) == 0) { UpdateUploadUi(); return; }
        if (!force && DateTime.Now < _nextUploadRetryAt) return;
        await UploadSessionCoreAsync(manual: false, retryOnly: true);
    }

    private async Task MirrorVNextDevelopmentAsync(bool force = false)
    {
        if (_vNextDevUploadInProgress) return;
        var session = _storage.Session;
        if (session is null)
        {
            UpdateTrayStatus();
            return;
        }

        var rows = _storage.LoadPendingVNextDevelopmentRows(session.Id);
        if (rows.Count == 0)
        {
            _vNextDevRetryStep = 0;
            _nextVNextDevRetryAt = DateTime.MinValue;
            UpdateTrayStatus();
            return;
        }
        if (!_vNextDevClient.IsSignedIn)
        {
            UpdateTrayStatus();
            return;
        }
        if (!force && DateTime.Now < _nextVNextDevRetryAt) return;

        _vNextDevUploadInProgress = true;
        try
        {
            var rules = _storage.LoadSessionRules(session.Id).ToDictionary(rule => rule.Balloons);
            var fixedRules = _storage.LoadSessionFixedRules(session.Id)
                .GroupBy(rule => rule.Balloons)
                .ToDictionary(group => group.Key, group => group.ToList());
            var mirrorStarted = Stopwatch.GetTimestamp();
            var mirroredRows = 0;
            var mirroredEvents = 0;
            var queuedExecutions = 0;
            var staleRows = 0;

            // 한 번에 과도한 요청을 만들지 않되, 실패한 원본 행은 완료 표시하지 않습니다.
            // 일부 하위 이벤트만 성공해도 Runtime idempotency key가 재시도 중복을 막습니다.
            foreach (var row in rows.Take(100))
            {
                // 과거 후원도 서버에 전달해 추첨권 같은 영구 원장은 복구합니다.
                // 뒤늦은 마이크/오버레이 재생 차단은 신뢰 경계인 event runtime이
                // occurredAt을 기준으로 판정합니다.
                if (IsStaleVNextDevelopmentRow(row, DateTimeOffset.UtcNow)) staleRows++;

                var events = BuildVNextDevelopmentEvents(
                    _vNextDevClient.WorkspaceId,
                    row,
                    rules,
                    fixedRules);
                foreach (var normalizedEvent in events)
                {
                    var sendResult = await _vNextDevClient.SendEventAsync(normalizedEvent);
                    mirroredEvents++;
                    queuedExecutions += sendResult.QueuedExecutionCount;
                    if (sendResult.QueuedExecutionCount > 0)
                        _vNextLocalAgent?.Wake();
                }
                _storage.MarkVNextDevelopmentUploaded(session.Id, new[] { row });
                mirroredRows++;
            }

            _vNextDevRetryStep = 0;
            _nextVNextDevRetryAt = DateTime.MinValue;
            var mirrorElapsedMs = (long)Stopwatch.GetElapsedTime(mirrorStarted).TotalMilliseconds;
            _storage.Log(
                $"vNext DEV 미러 성공: 원본 {mirroredRows}건 · 정규화 이벤트 {mirroredEvents}건 · 실행 큐 {queuedExecutions}건 · mirrorElapsedMs={mirrorElapsedMs} · 과거 원장 복구 {staleRows}건 · 대기 {_storage.PendingVNextDevelopmentCount(session.Id)}건");
        }
        catch (VNextDevelopmentException ex)
        {
            ScheduleVNextDevelopmentRetry();
            _storage.Log($"vNext DEV 미러 실패: status={ex.StatusCode?.ToString() ?? "none"} code={ex.Code} · 대기 {_storage.PendingVNextDevelopmentCount(session.Id)}건");
        }
        catch (Exception ex)
        {
            ScheduleVNextDevelopmentRetry();
            _storage.Log($"vNext DEV 미러 실패: type={ex.GetType().Name} · 대기 {_storage.PendingVNextDevelopmentCount(session.Id)}건");
        }
        finally
        {
            _vNextDevUploadInProgress = false;
            UpdateTrayStatus();
            NotifyMainUi();
            if (_nextVNextDevRetryAt == DateTime.MinValue && _storage.PendingVNextDevelopmentCount(session.Id) > 0)
            {
                _vNextDevUploadTimer.Stop();
                _vNextDevUploadTimer.Start();
            }
        }
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

    private async Task RunVNextDevelopmentE2ETestAsync()
    {
        if (_vNextDevE2EInProgress) return;
        if (!_vNextDevClient.IsSignedIn)
        {
            MessageBox.Show(
                "vNext DEV 계정 세션이 없습니다. 먼저 트레이 메뉴의 ‘vNext 개발 계정 다시 연결’을 실행해주세요.",
                "vNext DEV 전체 경로 테스트",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return;
        }

        var answer = MessageBox.Show(
            "개발 DB에 위플랩 형식의 테스트 후원 1건과 ‘아봉 10초’ 룰렛 1건을 전송합니다.\n\n" +
            "같은 이벤트를 한 번 더 보내 중복 이벤트·중복 실행이 생성되지 않는지도 확인합니다.\n" +
            "운영 서버에는 전송하지 않습니다. 계속할까요?",
            "vNext DEV 전체 경로 테스트",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Question,
            MessageBoxDefaultButton.Button1);
        if (answer != DialogResult.Yes) return;

        _vNextDevE2EInProgress = true;
        var now = DateTimeOffset.UtcNow;
        var correlationId = $"collector_dev_e2e_{now:yyyyMMddHHmmss}_{Guid.NewGuid():N}";
        var donationId = correlationId + "_donation";
        var rouletteId = correlationId + "_roulette_1";
        var actor = new { id = "collector_dev_e2e", name = "Collector DEV E2E" };

        var donation = new VNextDevelopmentEvent(
            SchemaVersion: "1.0",
            Id: donationId,
            WorkspaceId: _vNextDevClient.WorkspaceId,
            Source: "weflab",
            Platform: "soop",
            Type: "donation",
            Subtype: "weflab_donation_e2e",
            Actor: actor,
            Amount: 30,
            Currency: "starballoon",
            Payload: new
            {
                eventName = "DEV E2E",
                classification = "matched",
                rouletteResults = new[] { new { result = "아봉 10초", probability = "TEST" } },
                fixedRewards = Array.Empty<object>(),
                testOnly = true
            },
            OccurredAt: now,
            ReceivedAt: now,
            CorrelationId: correlationId);

        var roulette = new VNextDevelopmentEvent(
            SchemaVersion: "1.0",
            Id: rouletteId,
            WorkspaceId: _vNextDevClient.WorkspaceId,
            Source: "weflab",
            Platform: "soop",
            Type: "roulette",
            Subtype: "weflab_roulette_e2e",
            Actor: actor,
            Amount: 30,
            Currency: "starballoon",
            Payload: new
            {
                result = "아봉 10초",
                probability = "TEST",
                resultIndex = 1,
                resultCount = 1,
                eventName = "DEV E2E",
                donationEventId = donationId,
                testOnly = true
            },
            OccurredAt: now,
            ReceivedAt: now,
            CorrelationId: correlationId);

        try
        {
            var donationFirst = await _vNextDevClient.SendEventAsync(donation);
            var rouletteFirst = await _vNextDevClient.SendEventAsync(roulette);
            var donationSecond = await _vNextDevClient.SendEventAsync(donation);
            var rouletteSecond = await _vNextDevClient.SendEventAsync(roulette);

            var succeeded =
                !donationFirst.Duplicate
                && donationFirst.MatchedRuleCount == 0
                && !rouletteFirst.Duplicate
                && rouletteFirst.MatchedRuleCount >= 1
                && rouletteFirst.QueuedExecutionCount >= 1
                && rouletteFirst.CompletedSucceededCount >= 1
                && donationSecond.Duplicate
                && donationSecond.QueuedExecutionCount == 0
                && rouletteSecond.Duplicate
                && rouletteSecond.QueuedExecutionCount == 0
                && rouletteSecond.CompletedSucceededCount == 0;

            var shortId = correlationId[^12..];
            _storage.Log(
                $"vNext DEV E2E {(succeeded ? "성공" : "검증 불일치")} · test={shortId} · " +
                $"match={rouletteFirst.MatchedRuleCount} queue={rouletteFirst.QueuedExecutionCount} " +
                $"completed={rouletteFirst.CompletedSucceededCount} duplicate={rouletteSecond.Duplicate}");

            if (!succeeded)
            {
                MessageBox.Show(
                    "DEV 전송은 완료됐지만 검증 결과가 예상과 다릅니다.\n\n" +
                    $"규칙 매칭: {rouletteFirst.MatchedRuleCount}건\n" +
                    $"실행 생성: {rouletteFirst.QueuedExecutionCount}건\n" +
                    $"실행 성공: {rouletteFirst.CompletedSucceededCount}건\n" +
                    $"재전송 중복 판정: {(rouletteSecond.Duplicate ? "확인" : "실패")}\n\n" +
                    $"테스트 식별값: {shortId}",
                    "vNext DEV 전체 경로 테스트",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
                return;
            }

            MessageBox.Show(
                "DEV 전체 경로 테스트에 성공했습니다.\n\n" +
                "✓ donation·roulette 이벤트 수신\n" +
                "✓ ‘아봉 10초’ 규칙 매칭\n" +
                "✓ 실행 생성 및 succeeded 완료\n" +
                "✓ 동일 이벤트 재전송 중복 차단\n\n" +
                $"테스트 식별값: {shortId}\n" +
                "운영 서버에는 전송되지 않았습니다.",
                "vNext DEV 전체 경로 테스트",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }
        catch (VNextDevelopmentException ex)
        {
            _storage.Log($"vNext DEV E2E 실패 · status={ex.StatusCode?.ToString() ?? "none"} code={ex.Code}");
            MessageBox.Show(
                ex.Message + "\n\n트레이에서 개발 계정을 다시 연결한 뒤 재시도해주세요.",
                "vNext DEV 전체 경로 테스트",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
        catch (Exception ex)
        {
            _storage.Log($"vNext DEV E2E 실패 · type={ex.GetType().Name}");
            MessageBox.Show(
                "DEV 전체 경로 테스트 중 오류가 발생했습니다.\n\n" + ex.Message,
                "vNext DEV 전체 경로 테스트",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
        finally
        {
            _vNextDevE2EInProgress = false;
            UpdateTrayStatus();
        }
    }

    private void ScheduleVNextDevelopmentRetry()
    {
        var retryMinutes = new[] { 1, 2, 5, 10, 10 }[Math.Min(_vNextDevRetryStep, 4)];
        _vNextDevRetryStep = Math.Min(_vNextDevRetryStep + 1, 4);
        _nextVNextDevRetryAt = DateTime.Now.AddMinutes(retryMinutes);
    }

    private static List<VNextDevelopmentEvent> BuildVNextDevelopmentEvents(
        string workspaceId,
        JsonElement row,
        Dictionary<long, RouletteEventRule> rules,
        Dictionary<long, List<FixedRewardRule>> fixedRules)
    {
        var record = BuildUploadRecord(row, rules, fixedRules);
        var uid = GetString(row, "uid").Trim();
        if (uid.Length == 0) uid = BuildFallbackUid(row);
        uid = VNextSourceIdentity.RequireValid(uid);
        // Weflab의 원본 UID가 event identity다. 로컬 수집 session을 섞으면 앱
        // 재시작 뒤 같은 후원이 새 event로 보이며 추첨권이 중복 지급될 수 있다.
        var baseId = "weflab_" + StableDevelopmentHash("weflab|" + uid);

        var actorId = GetString(row, "id").Trim();
        if (actorId.Length == 0) actorId = GetString(row, "bjid").Trim();
        var actorName = GetString(row, "name").Trim();
        object? actor = actorId.Length == 0 && actorName.Length == 0
            ? null
            : new { id = actorId, name = actorName };

        var platform = GetString(row, "platform").Trim().ToLowerInvariant();
        if (platform.Length == 0 || platform.Length > 64) platform = "soop";
        var amount = GetAmount(row);
        // 원본 시각이 없거나 손상된 행을 현재 이벤트로 승격하지 않습니다.
        // 서버에는 원장 복구용으로 전달하되 Epoch를 사용해 마이크/오버레이 같은
        // 실시간 부작용이 반드시 stale 경로로 차단되도록 fail-closed 합니다.
        var occurredAt = GetVNextOccurredAtUtc(row) ?? DateTimeOffset.UnixEpoch;
        var receivedAt = DateTimeOffset.UtcNow;

        var events = new List<VNextDevelopmentEvent>();
        var donationEventId = baseId + "_donation";
        events.Add(new VNextDevelopmentEvent(
            SchemaVersion: "1.0",
            Id: donationEventId,
            WorkspaceId: workspaceId,
            Source: "weflab",
            Platform: platform,
            Type: "donation",
            Subtype: "weflab_donation",
            Actor: actor,
            Amount: amount > 0 ? amount : null,
            // 별풍선은 ISO-4217 통화 코드가 아닙니다. event-runtime은 currency에
            // 3자리 통화 코드만 허용하므로 단위는 payload로 보존합니다.
            Currency: null,
            Payload: new
            {
                sourceUid = uid,
                amountUnit = amount > 0 ? "starballoon" : null,
                eventName = record.Classification.EventName,
                classification = record.Classification.Validation,
                rouletteResults = record.RouletteResults.Select(result => new { result = result.Result, probability = result.Probability }).ToArray(),
                fixedRewards = record.FixedRewards.Select(reward => new { eventName = reward.EventName, upboType = reward.UpboType, quantity = reward.Quantity }).ToArray()
            },
            OccurredAt: occurredAt,
            ReceivedAt: receivedAt,
            CorrelationId: baseId));

        for (var index = 0; index < record.RouletteResults.Count; index++)
        {
            var roulette = record.RouletteResults[index];
            events.Add(new VNextDevelopmentEvent(
                SchemaVersion: "1.0",
                Id: baseId + "_roulette_" + (index + 1),
                WorkspaceId: workspaceId,
                Source: "weflab",
                Platform: platform,
                Type: "roulette",
                Subtype: "weflab_roulette",
                Actor: actor,
                Amount: amount > 0 ? amount : null,
                Currency: null,
                Payload: new
                {
                    sourceUid = uid,
                    amountUnit = amount > 0 ? "starballoon" : null,
                    result = roulette.Result,
                    probability = roulette.Probability,
                    resultIndex = index + 1,
                    resultCount = record.RouletteResults.Count,
                    eventName = record.Classification.EventName,
                    donationEventId
                },
                OccurredAt: occurredAt,
                ReceivedAt: receivedAt,
                CorrelationId: baseId));
        }

        return events;
    }

    private static readonly TimeSpan MaxLiveAutomationEventAge = TimeSpan.FromMinutes(2);

    private static bool IsStaleVNextDevelopmentRow(JsonElement row, DateTimeOffset nowUtc)
    {
        var occurredAt = GetVNextOccurredAtUtc(row);
        return !occurredAt.HasValue || nowUtc - occurredAt.Value > MaxLiveAutomationEventAge;
    }

    private static DateTimeOffset? GetVNextOccurredAtUtc(JsonElement row)
    {
        var text = GetString(row, "create_time").Trim();
        if (text.Length == 0) text = GetString(row, "time").Trim();
        if (text.Length == 0) return null;

        if (long.TryParse(text, out var unixValue))
        {
            try
            {
                return DateTimeOffset.FromUnixTimeSeconds(unixValue > 9999999999 ? unixValue / 1000 : unixValue);
            }
            catch { return null; }
        }

        // Weflab의 오프셋 없는 create_time은 SOOP 방송 기준시각(KST)입니다.
        // PC의 Windows 표준 시간대가 달라도 같은 UTC 시각을 만들도록 +09:00을 고정합니다.
        var hasExplicitOffset = System.Text.RegularExpressions.Regex.IsMatch(
            text,
            @"(?:Z|[+-]\d{2}:?\d{2})$",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        if (hasExplicitOffset && DateTimeOffset.TryParse(
                text,
                System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.AllowWhiteSpaces,
                out var offsetTime))
            return offsetTime.ToUniversalTime();

        if (DateTime.TryParse(
                text,
                System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.AllowWhiteSpaces,
                out var localTextTime))
        {
            var unspecified = DateTime.SpecifyKind(localTextTime, DateTimeKind.Unspecified);
            return new DateTimeOffset(unspecified, TimeSpan.FromHours(9)).ToUniversalTime();
        }

        return null;
    }

    private static string StableDevelopmentHash(string seed)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(seed));
        return Convert.ToHexString(hash)[..32].ToLowerInvariant();
    }

    private Task ShowServerLoginDialogAsync()
    {
        using var form = new Form
        {
            Text = "별록 서버 연결",
            Width = 540,
            Height = 470,
            StartPosition = FormStartPosition.CenterParent,
            FormBorderStyle = FormBorderStyle.FixedDialog,
            MaximizeBox = false,
            MinimizeBox = false,
            ShowInTaskbar = false,
            Font = Font
        };

        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(24),
            ColumnCount = 1,
            RowCount = 9
        };
        for (var i = 0; i < 8; i++) root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

        root.Controls.Add(new Label
        {
            Text = "별록 계정으로 연결",
            AutoSize = true,
            Font = new Font(Font.FontFamily, 17F, FontStyle.Bold),
            Margin = new Padding(0,0,0,6)
        });

        root.Controls.Add(new Label
        {
            Text = "관리자 사이트에서 사용하는 별록 계정으로 이 PC를 연결합니다. 비밀번호는 저장하지 않으며, 연결 후 이 PC 전용 기기 토큰만 보관합니다.",
            AutoSize = true,
            MaximumSize = new Size(470,0),
            Tag = "muted",
            Margin = new Padding(0,0,0,14)
        });

        var server = new TextBox
        {
            Text = _storage.Config.ServerUrl.Replace("/api/collector", ""),
            Dock = DockStyle.Top,
            Height = 42,
            Margin = new Padding(0,0,0,10)
        };
        root.Controls.Add(server);

        var email = new TextBox
        {
            PlaceholderText = "이메일",
            Dock = DockStyle.Top,
            Height = 42,
            Margin = new Padding(0,0,0,10)
        };
        root.Controls.Add(email);

        var password = new TextBox
        {
            PlaceholderText = "비밀번호",
            UseSystemPasswordChar = true,
            Dock = DockStyle.Top,
            Height = 42,
            Margin = new Padding(0,0,0,10)
        };
        root.Controls.Add(password);

        var state = new Label
        {
            Text = "",
            AutoSize = true,
            Tag = "muted",
            Margin = new Padding(0,4,0,8)
        };
        root.Controls.Add(state);

        // 기능은 유지하지만 기본 UI에서는 보이지 않습니다.
        var pairingCodeButton = new Button
        {
            Text = "연결 코드 사용 (매니저용)",
            AutoSize = true,
            Padding = new Padding(12,6,12,6),
            Visible = EnableManagerPairingCodeUi
        };
        pairingCodeButton.Click += async (_,_) =>
        {
            form.Hide();
            try { await ShowServerPairingCodeDialogAsync(); }
            finally { form.Close(); }
        };
        root.Controls.Add(pairingCodeButton);

        var actions = new FlowLayoutPanel
        {
            AutoSize = true,
            FlowDirection = FlowDirection.RightToLeft,
            Dock = DockStyle.Fill,
            Margin = new Padding(0,8,0,0)
        };

        var connect = new Button
        {
            Text = "별록 연결",
            AutoSize = true,
            Padding = new Padding(18,7,18,7),
            Tag = "accentButton"
        };
        var cancel = new Button
        {
            Text = "닫기",
            AutoSize = true,
            Padding = new Padding(14,7,14,7)
        };
        cancel.Click += (_,_) => form.Close();

        connect.Click += async (_,_) =>
        {
            var baseUrl = server.Text.Trim().TrimEnd('/');
            var accountEmail = email.Text.Trim();
            var accountPassword = password.Text;

            if (string.IsNullOrWhiteSpace(baseUrl)) { state.Text = "서버 주소를 입력해주세요."; return; }
            if (string.IsNullOrWhiteSpace(accountEmail)) { state.Text = "이메일을 입력해주세요."; return; }
            if (string.IsNullOrWhiteSpace(accountPassword)) { state.Text = "비밀번호를 입력해주세요."; return; }

            state.Text = "계정 확인 및 PC 연결 중...";
            connect.Enabled = false;

            try
            {
                var json = JsonSerializer.Serialize(new
                {
                    mode = "account",
                    email = accountEmail,
                    password = accountPassword,
                    device_name = Environment.MachineName,
                    collector_version = CollectorVersion
                });

                using var req = new HttpRequestMessage(HttpMethod.Post, baseUrl + "/api/collector-pair");
                req.Content = new StringContent(json, Encoding.UTF8, "application/json");
                using var res = await _http.SendAsync(req);
                var text = await res.Content.ReadAsStringAsync();

                if (!res.IsSuccessStatusCode)
                {
                    try
                    {
                        using var err = JsonDocument.Parse(text);
                        if (err.RootElement.TryGetProperty("message", out var msg))
                            throw new Exception(msg.GetString() ?? "연결 실패");
                    }
                    catch (JsonException) { }
                    throw new Exception(text);
                }

                using var doc = JsonDocument.Parse(text);
                var token = doc.RootElement.GetProperty("device_token").GetString() ?? "";
                if (string.IsNullOrWhiteSpace(token))
                    throw new Exception("서버에서 기기 토큰을 받지 못했습니다.");

                _storage.SaveConfig(baseUrl + "/api/collector", token);
                password.Clear(); // 비밀번호를 메모리에 오래 남기지 않습니다.
                state.Text = "연결 완료";
                _storage.Log("베타 Collector 계정 로그인 및 기기 등록 완료");
                UpdateUploadUi("● 동작 중");
                await Task.Delay(350);
                form.Close();
            }
            catch (Exception ex)
            {
                state.Text = "연결 실패: " + ex.Message;
            }
            finally
            {
                password.Clear();
                connect.Enabled = true;
            }
        };

        actions.Controls.Add(connect);
        actions.Controls.Add(cancel);
        root.Controls.Add(actions);

        form.Controls.Add(root);
        ApplyThemeToDialog(form);
        form.ShowDialog(this);
        return Task.CompletedTask;
    }

    // 매니저 PC용 8자리 연결 코드 방식.
    // 서버/클라이언트 구현은 유지하지만 EnableManagerPairingCodeUi=false로 기본 UI에서는 숨깁니다.
    private Task ShowServerPairingCodeDialogAsync()
    {
        using var form = new Form
        {
            Text = "별록 연결 코드",
            Width = 520,
            Height = 360,
            StartPosition = FormStartPosition.CenterParent,
            FormBorderStyle = FormBorderStyle.FixedDialog,
            MaximizeBox = false,
            MinimizeBox = false,
            ShowInTaskbar = false,
            Font = Font
        };

        var root = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(24), ColumnCount = 1, RowCount = 6 };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        root.Controls.Add(new Label
        {
            Text = "매니저용 에이전트 연결",
            AutoSize = true,
            Font = new Font(Font.FontFamily, 17F, FontStyle.Bold),
            Margin = new Padding(0,0,0,6)
        });

        root.Controls.Add(new Label
        {
            Text = "관리자 페이지에서 발급한 8자리 연결 코드를 입력합니다.",
            AutoSize = true,
            MaximumSize = new Size(450,0),
            Tag = "muted",
            Margin = new Padding(0,0,0,14)
        });

        var server = new TextBox
        {
            Text = _storage.Config.ServerUrl.Replace("/api/collector", ""),
            Dock = DockStyle.Top,
            Height = 38,
            Margin = new Padding(0,0,0,10)
        };
        root.Controls.Add(server);

        var code = new TextBox
        {
            PlaceholderText = "8자리 연결 코드",
            CharacterCasing = CharacterCasing.Upper,
            MaxLength = 8,
            Dock = DockStyle.Top,
            Height = 42,
            Font = new Font(Font.FontFamily, 14F, FontStyle.Bold),
            Margin = new Padding(0,0,0,10)
        };
        root.Controls.Add(code);

        var state = new Label { Text = "", AutoSize = true, Tag = "muted", Margin = new Padding(0,4,0,0) };
        root.Controls.Add(state);

        var actions = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.RightToLeft, Dock = DockStyle.Fill };
        var connect = new Button { Text = "연결", AutoSize = true, Padding = new Padding(18,7,18,7), Tag = "accentButton" };
        var cancel = new Button { Text = "닫기", AutoSize = true, Padding = new Padding(14,7,14,7) };
        cancel.Click += (_,_) => form.Close();

        connect.Click += async (_,_) =>
        {
            var c = new string(code.Text.Where(char.IsLetterOrDigit).ToArray()).ToUpperInvariant();
            if (c.Length != 8) { state.Text = "8자리 연결 코드를 입력해주세요."; return; }
            var baseUrl = server.Text.Trim().TrimEnd('/');
            if (string.IsNullOrWhiteSpace(baseUrl)) { state.Text = "서버 주소를 입력해주세요."; return; }

            state.Text = "서버 연결 중...";
            connect.Enabled = false;
            try
            {
                var json = JsonSerializer.Serialize(new
                {
                    code = c,
                    device_name = Environment.MachineName,
                    collector_version = CollectorVersion
                });
                using var req = new HttpRequestMessage(HttpMethod.Post, baseUrl + "/api/collector-pair");
                req.Content = new StringContent(json, Encoding.UTF8, "application/json");
                using var res = await _http.SendAsync(req);
                var text = await res.Content.ReadAsStringAsync();
                if (!res.IsSuccessStatusCode) throw new Exception(text);

                using var doc = JsonDocument.Parse(text);
                var token = doc.RootElement.GetProperty("device_token").GetString() ?? "";
                if (string.IsNullOrWhiteSpace(token)) throw new Exception("서버에서 기기 토큰을 받지 못했습니다.");

                _storage.SaveConfig(baseUrl + "/api/collector", token);
                state.Text = "연결 완료";
                _storage.Log("베타 Collector 매니저용 연결 코드 등록 완료");
                UpdateUploadUi("● 동작 중");
                await Task.Delay(350);
                form.Close();
            }
            catch (Exception ex)
            {
                state.Text = "연결 실패: " + ex.Message;
            }
            finally
            {
                connect.Enabled = true;
            }
        };

        actions.Controls.Add(connect);
        actions.Controls.Add(cancel);
        root.Controls.Add(actions);

        form.Controls.Add(root);
        ApplyThemeToDialog(form);
        form.ShowDialog(this);
        return Task.CompletedTask;
    }

    private async Task UploadSessionCoreAsync(bool manual, bool retryOnly = false)
    {
        if (_uploadInProgress) return;
        var s = _storage.Session;
        if (s is null)
        {
            if (manual) MessageBox.Show("업로드할 수집 세션이 없습니다.");
            return;
        }

        var rows = _storage.LoadPendingSessionRows(s.Id);
        if (rows.Count == 0)
        {
            if (manual) MessageBox.Show("업로드 대기 중인 후원이 없습니다.");
            return;
        }

        if (string.IsNullOrWhiteSpace(_storage.Config.ServerUrl) || string.IsNullOrWhiteSpace(_storage.Config.CollectorToken))
        {
            const string msg = "내부 서버 설정이 비어 있습니다. 배포판을 다시 받아주세요.";
            await ReportUploadFailureAsync(s, manual ? "manual" : (retryOnly ? "retry" : "auto"), null, rows.Count, "configuration", msg);
            if (manual) MessageBox.Show(msg, "서버 업로드", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        var rules = _storage.LoadSessionRules(s.Id).ToDictionary(r => r.Balloons);
        var fixedRules = _storage.LoadSessionFixedRules(s.Id).GroupBy(r => r.Balloons).ToDictionary(g => g.Key, g => g.ToList());
        var enriched = rows.Select(r => BuildUploadRecord(r, rules, fixedRules)).ToList();
        var eventCount = enriched.Count(x => x.Classification.EventName is not null);
        var generalCount = enriched.Count - eventCount;
        var warningCount = enriched.Count(x => x.Classification.Validation is "short" or "over");
        var matchedCount = enriched.Count(x => x.Classification.Validation == "matched");
        var rouletteCount = enriched.Sum(x => x.RouletteResults.Count);
        var balloonTotal = rows.Sum(GetAmount);

        if (manual && !ShowUploadSummaryDialog(s, rows.Count, balloonTotal, eventCount, generalCount, rouletteCount, matchedCount, warningCount)) return;

        _uploadInProgress = true;
        UpdateUploadUi("● 업로드 중");

        try
        {
            await FlushPendingDiagnosticsAsync();
            var total = 0;
            foreach (var chunk in enriched.Chunk(200))
            {
                var body = JsonSerializer.Serialize(new
                {
                    collector_version = CollectorVersion,
                    source_scope = "observer-a",
                    upload_mode = manual ? "manual" : (retryOnly ? "auto_retry" : "realtime_auto"),
                    session = new
                    {
                        id = s.Id,
                        start_local = s.StartLocal,
                        end_local = s.EndLocal,
                        roulette_rules = rules.Values.OrderBy(x => x.Balloons),
                        fixed_rules = fixedRules.Values.SelectMany(x => x).OrderBy(x => x.Balloons).ThenBy(x => x.EventName).ThenBy(x => x.UpboType)
                    },
                    records = chunk
                });

                using var req = new HttpRequestMessage(HttpMethod.Post, _storage.Config.ServerUrl);
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _storage.Config.CollectorToken);
                req.Content = new StringContent(body, Encoding.UTF8, "application/json");
                using var res = await _http.SendAsync(req);
                var responseText = await res.Content.ReadAsStringAsync();
                if (!res.IsSuccessStatusCode)
                {
                    await ReportUploadFailureAsync(s, manual ? "manual" : (retryOnly ? "retry" : "auto"), (int)res.StatusCode, chunk.Length, "http", responseText);
                    throw new Exception($"HTTP {(int)res.StatusCode}: {responseText}");
                }

                try
                {
                    using var doc = JsonDocument.Parse(responseText);
                    if (doc.RootElement.TryGetProperty("accepted", out var a) && a.TryGetInt32(out var n)) total += n;
                    else total += chunk.Length;
                }
                catch { total += chunk.Length; }

                // 이 청크는 서버 성공 응답을 받은 뒤에만 로컬 완료 처리합니다.
                _storage.MarkUploaded(s.Id, chunk.Select(x => x.Raw));
            }

            _uploadRetryStep = 0;
            _nextUploadRetryAt = DateTime.MinValue;
            _storage.Log($"서버 업로드 성공({(manual ? "수동" : retryOnly ? "자동재시도" : "실시간자동")}): {total}건 · 대기 {_storage.PendingUploadCount(s.Id)}건");
            _storage.MarkSuccessfulUpload(DateTimeOffset.UtcNow);
            _lastCheck.Text = DateTime.Now.ToString("HH:mm:ss");
            UpdateUploadUi("● 동작 중");
            await SendDiagnosticAsync(new
            {
                level = "info",
                event_type = "upload_success",
                occurred_at_local = DateTime.Now,
                collector_version = CollectorVersion,
                session_id = s.Id,
                upload_mode = manual ? "manual" : (retryOnly ? "auto_retry" : "realtime_auto"),
                record_count = rows.Count,
                accepted_count = total
            }, queueOnFailure: false);

            if (manual) MessageBox.Show($"업로드 완료\n\n서버가 {total:N0}건을 처리했습니다.", "별록 에이전트");
        }
        catch (Exception ex)
        {
            var retryMinutes = new[] { 1, 2, 5, 10, 10 }[Math.Min(_uploadRetryStep, 4)];
            _uploadRetryStep = Math.Min(_uploadRetryStep + 1, 4);
            _nextUploadRetryAt = DateTime.Now.AddMinutes(retryMinutes);
            _storage.Log($"서버 업로드 실패({(manual ? "수동" : retryOnly ? "자동재시도" : "실시간자동")}): {ex.Message} · 대기 {_storage.PendingUploadCount(s.Id)}건 · {retryMinutes}분 후 재시도");
            if (!ex.Message.StartsWith("HTTP ", StringComparison.Ordinal))
            {
                await ReportUploadFailureAsync(s, manual ? "manual" : (retryOnly ? "retry" : "auto"), null, rows.Count, ex.GetType().Name, ex.Message);
            }
            UpdateUploadUi("● 재연결 대기");
            if (manual) MessageBox.Show("업로드 실패\n\n" + ex.Message, "별록 에이전트", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            _uploadInProgress = false;
            UpdateUploadUi();
            var current = _storage.Session;
            if (_nextUploadRetryAt == DateTime.MinValue && current is not null && _storage.PendingUploadCount(current.Id) > 0)
                ScheduleRealtimeUpload(); // 전송 중 새로 들어온 건을 다음 짧은 배치로 이어서 처리
        }
    }

    private string DiagnosticUrl()
    {
        var url = _storage.Config.ServerUrl.Trim();
        if (url.EndsWith("/api/collector", StringComparison.OrdinalIgnoreCase))
            return url[..^"/api/collector".Length] + "/api/collector-log";
        return url.TrimEnd('/') + "/log";
    }

    private async Task ReportUploadFailureAsync(CollectorSession s, string mode, int? httpStatus, int recordCount, string errorType, string message)
    {
        var safeMessage = message.Length > 1800 ? message[..1800] : message;
        await SendDiagnosticAsync(new
        {
            level = "error",
            event_type = "upload_failure",
            occurred_at_local = DateTime.Now,
            collector_version = CollectorVersion,
            session_id = s.Id,
            upload_mode = mode == "auto" ? "realtime_auto" : mode == "retry" ? "auto_retry" : "manual",
            http_status = httpStatus,
            record_count = recordCount,
            error_type = errorType,
            message = safeMessage
        }, queueOnFailure: true);
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

    private bool ShowUploadSummaryDialog(CollectorSession s, int donationCount, long balloonTotal, int eventCount, int generalCount, int rouletteCount, int matchedCount, int warningCount)
    {
        using var form = new Form
        {
            Text = "서버 업로드 확인",
            Width = 560,
            Height = 500,
            MinimumSize = new Size(520, 460),
            StartPosition = FormStartPosition.CenterParent,
            FormBorderStyle = FormBorderStyle.FixedDialog,
            MaximizeBox = false,
            MinimizeBox = false,
            ShowInTaskbar = false,
            Font = Font
        };

        var root = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(20), ColumnCount = 1, RowCount = 5 };
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        var title = new Label { Text = "서버로 전송할 내용을 확인해주세요", AutoSize = true, Font = new Font(Font, FontStyle.Bold), Margin = new Padding(0,0,0,4) };
        var rangeText = $"수집 범위  {s.StartLocal:yyyy-MM-dd HH:mm} ~ {(s.EndLocal.HasValue ? s.EndLocal.Value.ToString("yyyy-MM-dd HH:mm") : "현재")}";
        var sub = new Label { Text = rangeText, AutoSize = true, Tag = "muted", Margin = new Padding(0,0,0,14) };
        var head = new FlowLayoutPanel { Dock = DockStyle.Top, AutoSize = true, FlowDirection = FlowDirection.TopDown, WrapContents = false };
        head.Controls.Add(title); head.Controls.Add(sub);
        root.Controls.Add(head,0,0);

        var cards = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 3, RowCount = 2, Margin = new Padding(0,0,0,14) };
        for (var i=0;i<3;i++) cards.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33.333f));
        cards.RowStyles.Add(new RowStyle(SizeType.Absolute, 78));
        cards.RowStyles.Add(new RowStyle(SizeType.Absolute, 78));
        Control Card(string label, string value, bool warn=false)
        {
            var panel = new Panel { Dock = DockStyle.Fill, Margin = new Padding(5), Padding = new Padding(10), BorderStyle = BorderStyle.FixedSingle, Tag = "card" };
            var l = new Label { Text = label, AutoSize = true, Location = new Point(10,10), Tag = "muted" };
            var v = new Label { Text = value, AutoSize = true, Location = new Point(10,34), Font = new Font(Font.FontFamily, 14F, FontStyle.Bold), Tag = warn ? "warnText" : null };
            panel.Controls.Add(l); panel.Controls.Add(v); return panel;
        }
        cards.Controls.Add(Card("전체 후원", $"{donationCount:N0}건"),0,0);
        cards.Controls.Add(Card("총 별풍선", $"{balloonTotal:N0}개"),1,0);
        cards.Controls.Add(Card("룰렛 결과", $"{rouletteCount:N0}개"),2,0);
        cards.Controls.Add(Card("이벤트 후원", $"{eventCount:N0}건"),0,1);
        cards.Controls.Add(Card("일반 후원", $"{generalCount:N0}건"),1,1);
        cards.Controls.Add(Card("룰렛 확인 필요", $"{warningCount:N0}건", warningCount>0),2,1);
        root.Controls.Add(cards,0,1);

        var detail = new Label
        {
            AutoSize = false,
            Dock = DockStyle.Fill,
            Text = $"룰렛 횟수 정상 판정: {matchedCount:N0}건\r\n\r\n• 전체 후원 원본은 통계용으로 서버에 전달됩니다.\r\n• 이벤트가 지정되지 않은 후원도 통계에는 포함됩니다.\r\n• 룰렛 횟수가 맞지 않는 {warningCount:N0}건은 관리자에서 확인할 수 있습니다.\r\n• 동일 UID는 서버의 중복 방지 규칙을 따릅니다.",
            Padding = new Padding(10),
            Tag = "muted"
        };
        root.Controls.Add(detail,0,2);

        if (warningCount > 0)
        {
            var warning = new Label { Text = "⚠ 룰렛 횟수 확인이 필요한 후원이 있습니다. 업로드 후 관리자 수신함에서 확인해주세요.", AutoSize = true, Tag = "warnText", Margin = new Padding(0,8,0,8) };
            root.Controls.Add(warning,0,3);
        }
        else root.Controls.Add(new Panel { Height = 4 },0,3);

        var buttons = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, FlowDirection = FlowDirection.RightToLeft, WrapContents = false, Margin = new Padding(0,12,0,0) };
        var upload = new Button { Text = "서버에 업로드", AutoSize = true, MinimumSize = new Size(130,40), DialogResult = DialogResult.OK, Tag = "accentButton" };
        var cancel = new Button { Text = "취소", AutoSize = true, MinimumSize = new Size(90,40), DialogResult = DialogResult.Cancel };
        buttons.Controls.Add(upload); buttons.Controls.Add(cancel);
        form.AcceptButton = upload; form.CancelButton = cancel;
        root.Controls.Add(buttons,0,4);
        form.Controls.Add(root);
        ApplyThemeToDialog(form);
        return form.ShowDialog(this) == DialogResult.OK;
    }

    private sealed record RouletteResultInfo(string Result,string Probability);
    private sealed record ClassificationInfo(string? EventName,int? ExpectedSpins,int ActualSpins,string Validation);
    private sealed record FixedRewardInfo(string EventName,string UpboType,int Quantity);
    private sealed record UploadRecord(JsonElement Raw, ClassificationInfo Classification, List<RouletteResultInfo> RouletteResults, List<FixedRewardInfo> FixedRewards);

    private static UploadRecord BuildUploadRecord(JsonElement row, Dictionary<long,RouletteEventRule> rules, Dictionary<long,List<FixedRewardRule>> fixedRules)
    {
        var amountOk = TryGetAmount(row, out var amount);
        var results = GetRouletteResults(row, out var actualSpins);
        var soopId = GetString(row, "id").Trim();
        if (soopId.Length == 0) soopId = GetString(row, "bjid").Trim();
        var fixedRewards = amountOk && fixedRules.TryGetValue(amount, out var matchedFixed)
            ? matchedFixed.Select(r => new FixedRewardInfo(r.EventName, r.UpboType, r.Quantity)).ToList()
            : new List<FixedRewardInfo>();

        // DB 통계 원본은 양수 별풍선 + 식별 가능한 SOOP ID가 필요합니다.
        // 이상 행은 staging에는 남겨 관리자에서 다른 정상 건과 분리해 확인할 수 있게 합니다.
        if (!amountOk || amount <= 0)
            return new UploadRecord(row.Clone(), new ClassificationInfo(null, null, actualSpins, "amount_error"), results, fixedRewards);
        if (soopId.Length == 0)
            return new UploadRecord(row.Clone(), new ClassificationInfo(null, null, actualSpins, "identity_error"), results, fixedRewards);

        // 룰렛 결과가 하나도 없는 후원은 룰렛 규칙 기준으로는 일반 후원입니다.
        // 고정 규칙은 별도 FixedRewards로 전달되어 서버에서 독립적으로 업보를 생성합니다.
        if (results.Count == 0)
            return new UploadRecord(row.Clone(), new ClassificationInfo(null, null, 0, "unmapped"), results, fixedRewards);

        if (!rules.TryGetValue(amount, out var rule))
            return new UploadRecord(row.Clone(), new ClassificationInfo(null, null, actualSpins, "unmapped"), results, fixedRewards);

        var validation = RouletteResultParser.ValidateSpinCount(rule.ExpectedSpins, actualSpins);
        return new UploadRecord(row.Clone(), new ClassificationInfo(rule.EventName, rule.ExpectedSpins, actualSpins, validation), results, fixedRewards);
    }

    private static List<RouletteResultInfo> GetRouletteResults(JsonElement row)
        => GetRouletteResults(row, out _);

    private static List<RouletteResultInfo> GetRouletteResults(JsonElement row, out int actualSpins)
    {
        var outList = new List<RouletteResultInfo>();
        actualSpins = 0;
        if (row.TryGetProperty("list", out var listEl))
        {
            try
            {
                JsonElement arr = listEl; JsonDocument? temp = null;
                if (listEl.ValueKind == JsonValueKind.String)
                {
                    var text = listEl.GetString();
                    if (!string.IsNullOrWhiteSpace(text)) { temp = JsonDocument.Parse(text); arr = temp.RootElement.Clone(); }
                }
                if (arr.ValueKind == JsonValueKind.Array)
                {
                    foreach (var item in arr.EnumerateArray())
                    {
                        string result = "", prob = "";
                        if (item.ValueKind == JsonValueKind.Array)
                        {
                            var a = item.EnumerateArray().ToArray();
                            result = a.Length > 0 ? a[0].ToString().Trim() : "";
                            prob = a.Length > 1 ? a[1].ToString().Trim() : "";
                        }
                        else if (item.ValueKind == JsonValueKind.Object)
                        {
                            foreach (var key in new[] { "result", "Result", "roulette", "name", "item", "title" })
                            {
                                if (item.TryGetProperty(key, out var v) && !string.IsNullOrWhiteSpace(v.ToString())) { result = v.ToString().Trim(); break; }
                            }
                            foreach (var key in new[] { "probability", "Probability", "percent", "chance", "rate" })
                            {
                                if (item.TryGetProperty(key, out var v) && !string.IsNullOrWhiteSpace(v.ToString())) { prob = v.ToString().Trim(); break; }
                            }
                        }
                        else if (item.ValueKind == JsonValueKind.String)
                        {
                            result = item.GetString()?.Trim() ?? "";
                        }
                        actualSpins += AddRouletteResultSegments(outList, result, prob);
                    }
                }
                temp?.Dispose();
            }
            catch { }
        }
        if (outList.Count == 0)
        {
            foreach (var key in new[] { "roulette", "roulette_result", "result" })
            {
                var winner = GetString(row, key).Trim();
                if (winner.Length > 0) { actualSpins += AddRouletteResultSegments(outList, winner, GetString(row, "percent")); break; }
            }
        }
        return outList;
    }

    private static int AddRouletteResultSegments(List<RouletteResultInfo> output, string? rawResult, string probability)
    {
        var parsed = RouletteResultParser.ParseSpins(new[] { rawResult });
        foreach (var result in parsed.Results)
            output.Add(new RouletteResultInfo(result, probability));
        return parsed.SpinCount;
    }

    private static string BuildFallbackUid(JsonElement row)
    {
        var who = GetString(row, "id").Trim();
        if (who.Length == 0) who = GetString(row, "bjid").Trim();
        if (who.Length == 0) who = GetString(row, "name").Trim();
        var when = GetString(row, "create_time").Trim();
        if (when.Length == 0) when = GetString(row, "time").Trim();
        if (who.Length == 0 && when.Length == 0) return "";
        var seed = string.Join("|", new[]
        {
            who, when, GetString(row,"value"),
            row.TryGetProperty("currency", out var c) ? c.GetRawText() : "",
            GetString(row,"msg"), GetString(row,"roulette"),
            row.TryGetProperty("list", out var l) ? l.GetRawText() : ""
        });
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(seed));
        return "fallback-" + Convert.ToHexString(hash)[..24].ToLowerInvariant();
    }

    private static JsonElement WithUid(JsonElement row, string uid)
    {
        using var ms = new MemoryStream();
        using (var writer = new Utf8JsonWriter(ms))
        {
            writer.WriteStartObject();
            writer.WriteString("uid", uid);
            foreach (var p in row.EnumerateObject())
            {
                if (p.NameEquals("uid")) continue;
                p.WriteTo(writer);
            }
            writer.WriteEndObject();
        }
        using var doc = JsonDocument.Parse(ms.ToArray());
        return doc.RootElement.Clone();
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
            var webVersion = _webReady ? _web.CoreWebView2.Environment.BrowserVersionString : "not-ready";
            var preflight = await CreatePreflightAsync();
            var zip = _storage.ExportDebugZip(appVersion, webVersion, _web.Source?.ToString(), preflight);
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

    private async Task RunAcceptanceEvidenceAsync()
    {
        if (_acceptanceInProgress || _preflightInProgress) return;
        if (_vNextLocalAgent is null)
        {
            MessageBox.Show(
                "이 PC 자동화가 초기화되지 않아 실기기 검증을 시작할 수 없습니다.",
                "별록 실기기 검증",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return;
        }
        if (_timedMuteTestInProgress || _obsMuteCycleInProgress || _vNextObsE2EInProgress)
        {
            MessageBox.Show(
                "다른 방송 마이크 테스트가 진행 중입니다. 원상복구가 끝난 뒤 시작해주세요.",
                "별록 실기기 검증",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return;
        }

        _acceptanceInProgress = true;
        _preflightInProgress = true;
        try
        {
            var beforeReport = await CreatePreflightAsync();
            var before = CollectorAcceptanceRunner.Snapshot(beforeReport);
            if (beforeReport.OverallState != "pass")
            {
                MessageBox.Show(
                    beforeReport.UserSummary() + "\n\n차단 항목을 해결한 뒤 최종 실기기 검증을 다시 시작해주세요.",
                    "별록 실기기 검증 시작 차단",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
                return;
            }

            MessageBox.Show(
                "사전진단을 통과했습니다. 이 창을 닫은 뒤 15분 안에 실제 ‘아봉10초’ 이벤트를 1회만 발생시키세요.\n\n" +
                "• OBS와 FreeShot 브라우저 소스는 그대로 둡니다.\n" +
                "• 별록 에이전트의 다른 테스트 메뉴는 누르지 않습니다.\n" +
                "• 이벤트 중 마이크·이미지를 직접 조작하지 않습니다.\n" +
                "• 별록은 이벤트를 강제로 만들지 않고 다음 실제 작업만 관찰합니다.\n\n" +
                "완료되면 자동으로 결과 창이 나타납니다.",
                "아봉10초 최종 실기기 검증 시작",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);

            var startedAtUtc = DateTimeOffset.UtcNow;
            var overlayBefore = CollectorAcceptanceRunner.Snapshot(_vNextLocalAgent);
            _storage.Log("아봉10초 실기기 검증 관찰 시작 · timeout=15m");
            _trayIcon.BalloonTipTitle = "별록 실기기 검증 중";
            _trayIcon.BalloonTipText = "15분 안에 실제 아봉10초 이벤트를 1회 발생시키세요.";
            _trayIcon.BalloonTipIcon = ToolTipIcon.Info;
            _trayIcon.ShowBalloonTip(5000);

            var evidence = await CollectorAcceptanceRunner.WaitForFirstObsTimedMuteAsync(
                _vNextLocalAgent,
                startedAtUtc,
                TimeSpan.FromMinutes(15));

            var visualConfirmation = CollectorAcceptanceEvaluator.NotObserved;
            if (evidence?.State == "succeeded")
            {
                var visual = MessageBox.Show(
                    "방금 이벤트에서 OBS와 FreeShot 양쪽 모두 ‘마이크 OFF’ 이미지가 나타났고 약 10초 뒤 자동으로 사라졌나요?\n\n" +
                    "예: 양쪽 모두 정상\n아니오: 한쪽 이상 문제\n취소: 화면을 보지 못함",
                    "OBS·FreeShot 화면 확인",
                    MessageBoxButtons.YesNoCancel,
                    MessageBoxIcon.Question,
                    MessageBoxDefaultButton.Button3);
                visualConfirmation = visual switch
                {
                    DialogResult.Yes => CollectorAcceptanceEvaluator.ConfirmedBoth,
                    DialogResult.No => CollectorAcceptanceEvaluator.VisualFailed,
                    _ => CollectorAcceptanceEvaluator.NotObserved
                };
            }

            var afterReport = await CreatePreflightAsync();
            var after = CollectorAcceptanceRunner.Snapshot(afterReport);
            var overlayAfter = CollectorAcceptanceRunner.Snapshot(_vNextLocalAgent);
            var report = CollectorAcceptanceEvaluator.Evaluate(
                CollectorVersion,
                startedAtUtc,
                before,
                after,
                evidence,
                overlayBefore,
                overlayAfter,
                visualConfirmation);
            var zip = _storage.ExportAcceptanceZip(report);
            _storage.Log($"아봉10초 실기기 검증 종료 · state={report.OverallState}");

            if (MessageBox.Show(
                    report.UserSummary() + "\n\n검증 ZIP을 만들었습니다.\n" + zip + "\n\n폴더를 열까요?",
                    "별록 실기기 검증",
                    MessageBoxButtons.YesNo,
                    report.OverallState == "pass" ? MessageBoxIcon.Information : MessageBoxIcon.Warning) == DialogResult.Yes)
            {
                Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{zip}\"") { UseShellExecute = true });
            }
        }
        catch (Exception ex)
        {
            _storage.Log("아봉10초 실기기 검증 실패 · type=" + ex.GetType().Name);
            MessageBox.Show(
                "실기기 검증을 완료하지 못했습니다. 현재 마이크 상태를 확인한 뒤 사전진단과 진단 ZIP을 실행해주세요.",
                "별록 실기기 검증",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
        finally
        {
            _preflightInProgress = false;
            _acceptanceInProgress = false;
            _vNextLocalAgent?.Wake();
            UpdateTrayStatus();
        }
    }

    private static DateTime? GetOccurredLocal(JsonElement row)
    {
        var s = GetString(row, "create_time");
        if (string.IsNullOrWhiteSpace(s)) s = GetString(row, "time");

        if (DateTime.TryParse(s, out var dt))
            return dt.Kind == DateTimeKind.Utc ? dt.ToLocalTime() : dt;

        if (long.TryParse(s, out var n))
        {
            try
            {
                return DateTimeOffset.FromUnixTimeSeconds(n > 9999999999 ? n / 1000 : n).LocalDateTime;
            }
            catch { }
        }
        return null;
    }

    private static long GetAmount(JsonElement row) => TryGetAmount(row, out var amount) ? amount : 0;

    private static bool TryParseLooseAmount(JsonElement value, out long amount)
    {
        amount = 0;
        if (value.ValueKind == JsonValueKind.Number)
        {
            if (value.TryGetInt64(out var n)) { amount = n; return true; }
            if (value.TryGetDouble(out var d) && double.IsFinite(d)) { amount = (long)Math.Truncate(d); return true; }
        }

        var text = value.ToString().Replace(",", "").Trim();
        if (text.Length == 0) return false;

        // 서버와 같은 수준으로 숫자 주변의 단위/문자를 허용합니다.
        // 예: "1,000", "1000.0", "별풍선 1,000개" -> 1000
        var start = -1; var end = -1; var dotSeen = false;
        for (var i = 0; i < text.Length; i++)
        {
            var ch = text[i];
            if (char.IsDigit(ch) || ((ch == '-' || ch == '+') && start < 0 && i + 1 < text.Length && char.IsDigit(text[i + 1])))
            {
                if (start < 0) start = i;
                end = i + 1;
                continue;
            }
            if (ch == '.' && start >= 0 && !dotSeen) { dotSeen = true; end = i + 1; continue; }
            if (start >= 0) break;
        }
        if (start < 0 || end <= start) return false;
        var token = text[start..end].TrimEnd('.');
        if (double.TryParse(token, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var parsed) && double.IsFinite(parsed))
        {
            amount = (long)Math.Truncate(parsed);
            return true;
        }
        return false;
    }

    private static bool TryGetAmount(JsonElement row, out long amount)
    {
        amount = 0;
        var found = false;
        if (row.TryGetProperty("value", out var value) && TryParseLooseAmount(value, out var parsedValue))
        {
            amount = parsedValue; found = true;
        }
        if (row.TryGetProperty("currency", out var currency))
        {
            try
            {
                JsonElement cur = currency;
                if (currency.ValueKind == JsonValueKind.String)
                {
                    using var d = JsonDocument.Parse(currency.GetString() ?? "{}");
                    cur = d.RootElement.Clone();
                }
                if (cur.ValueKind == JsonValueKind.Object && cur.TryGetProperty("real", out var real) && TryParseLooseAmount(real, out var parsedReal))
                {
                    amount = parsedReal; found = true;
                }
            }
            catch { }
        }
        return found && amount > 0;
    }

    private static string GetString(JsonElement row,string name){if(!row.TryGetProperty(name,out var el))return"";return el.ValueKind==JsonValueKind.String?el.GetString()??"":el.ToString();}
    private static long GetLong(JsonElement row,string name){if(!row.TryGetProperty(name,out var el))return 0;if(el.ValueKind==JsonValueKind.Number&&el.TryGetInt64(out var n))return n;return long.TryParse(el.ToString(),out var p)?p:0;}

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
        var buttonBg = _darkMode ? Color.FromArgb(22, 44, 76) : Color.FromArgb(255, 255, 255);

        BackColor = bg;
        ForeColor = text;
        if (_rootPanel is not null) _rootPanel.BackColor = bg;
        ApplyThemeToControl(this, bg, surface, surface2, text, muted, border, accent, buttonBg);

        // 라이트 모드 헤더는 완전한 흰색으로 통일합니다.
        _headerPanel.BackColor = _darkMode ? bg : Color.White;
        _themeButton.Text = _darkMode ? "☀" : "☾";
        _themeButton.ForeColor = _darkMode ? Color.FromArgb(210, 220, 235) : Color.FromArgb(103, 113, 129);

        // 통계 카드는 테마별로 은은한 개별 색상을 사용합니다.
        _todayDonations.BackColor = _darkMode ? Color.FromArgb(31, 48, 75) : Color.FromArgb(255, 249, 232);
        _todayDonations.ForeColor = _darkMode ? Color.FromArgb(255, 205, 94) : Color.FromArgb(200, 126, 0);
        _todayBalloons.BackColor = _darkMode ? Color.FromArgb(27, 55, 67) : Color.FromArgb(238, 250, 244);
        _todayBalloons.ForeColor = _darkMode ? Color.FromArgb(104, 225, 155) : Color.FromArgb(36, 148, 87);
        _todayRoulette.BackColor = _darkMode ? Color.FromArgb(44, 40, 78) : Color.FromArgb(246, 242, 255);
        _todayRoulette.ForeColor = _darkMode ? Color.FromArgb(183, 145, 255) : Color.FromArgb(103, 74, 189);
        foreach (var stat in new[] { _todayDonations, _todayBalloons, _todayRoulette })
        {
            stat.BorderStyle = BorderStyle.None;
            ApplyRoundedRegion(stat, 18);
        }

        // 핵심 버튼은 노랑 포인트, 보조 버튼은 부드러운 표면색으로 구분합니다.
        foreach (var b in new[] { _startButton, _uploadButton })
        {
            b.BackColor = accent;
            b.ForeColor = Color.FromArgb(29, 35, 48);
            b.FlatAppearance.BorderSize = 0;
            b.Font = new Font(Font.FontFamily, 10.5F, FontStyle.Bold);
        }
        foreach (var b in new[] { _exitButton, _loginButton, _listButton, _rulesButton, _debugButton, _dummyButton, _browserButton })
        {
            b.BackColor = buttonBg;
            b.ForeColor = text;
            b.FlatAppearance.BorderColor = border;
            b.FlatAppearance.BorderSize = 1;
        }
        // 실제 종료 전용 버튼은 빠른 작업 안에서만 노출합니다.
        _debugButton.ForeColor = _darkMode ? Color.FromArgb(255, 198, 116) : Color.FromArgb(175, 86, 22);

        // 상태 라벨은 의미 색상을 유지하되 대비를 높입니다.
        if (_weflabStatus.Text.Contains("연결 완료")) _weflabStatus.ForeColor = _darkMode ? Color.FromArgb(91, 226, 147) : Color.FromArgb(31, 143, 82);
        else _weflabStatus.ForeColor = _darkMode ? Color.FromArgb(255, 203, 88) : Color.FromArgb(222, 133, 0);

        if (_storage.Session?.Active == true) _sessionStatus.ForeColor = _darkMode ? Color.FromArgb(91, 226, 147) : Color.FromArgb(31, 143, 82);
        else _sessionStatus.ForeColor = text;
        if (_collecting) _collectorStatus.ForeColor = _darkMode ? Color.FromArgb(91, 226, 147) : Color.FromArgb(31, 143, 82);
        else _collectorStatus.ForeColor = text;

        // 커스텀 날짜/시간 입력은 메인 카드와 동일한 팔레트로 렌더링합니다.
        foreach (var field in new[] { _startDatePicker, _startTimePicker })
        {
            field.SurfaceColor = _darkMode ? Color.FromArgb(19, 42, 74) : Color.White;
            field.BackColor = _darkMode ? Color.FromArgb(17, 37, 67) : Color.White;
            field.BorderColor = accent;
            field.TextColor = text;
            field.IconColor = _darkMode ? Color.FromArgb(155, 183, 232) : Color.FromArgb(74, 104, 154);
            field.HoverBorderColor = accent;
            field.Invalidate();
        }

        var headerSurface = _darkMode ? bg : Color.White;
        _headerBrand.SurfaceColor = headerSurface;
        _headerBrand.AccentColor = accent;
        _headerBrand.BackColor = headerSurface;
        _headerBrand.Invalidate();

        foreach (var headerAction in new[] { _minimizeButton, _themeButton, _trayMinimizeButton })
        {
            headerAction.Visible = true;
            headerAction.SurfaceColor = headerSurface;
            headerAction.HoverColor = _darkMode ? Color.FromArgb(31, 58, 94) : Color.FromArgb(245, 247, 250);
            headerAction.BorderColor = _darkMode ? Color.FromArgb(58, 84, 120) : Color.FromArgb(210, 219, 232);
            headerAction.IconColor = _darkMode ? Color.FromArgb(236, 241, 249) : Color.FromArgb(48, 61, 82);
            headerAction.AccentColor = accent;
            headerAction.DarkMode = _darkMode;
            headerAction.Invalidate();
            headerAction.BringToFront();
        }

                UpdateCollectionActionButton();
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
            else if (label != _weflabStatus && label != _sessionStatus && label != _collectorStatus) label.ForeColor = text;
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

    private void SetWeflabConnection(bool connected)
    {
        if (_weflabConnected == connected) return;
        _weflabConnected = connected;
        _weflabStatus.Text = connected ? "● 연결 완료" : "● 연결 필요";
        _weflabStatus.ForeColor = connected
            ? (_darkMode ? Color.FromArgb(93, 211, 158) : Color.ForestGreen)
            : (_darkMode ? Color.FromArgb(255, 187, 92) : Color.DarkOrange);
        NotifyMainUi();
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
            try { _weflabRecoveryLifetime.Cancel(); } catch { }
            _weflabRecoverySignal?.TrySetCanceled();
            _automationSettingsForm?.RequestHostShutdown();
            _vNextDevClient.SessionChanged -= VNextDevClient_SessionChanged;
            _vNextDevClient.SessionRecoveryChanged -= VNextDevClient_SessionRecoveryChanged;
            _activityMonitor.NotificationReady -= ActivityMonitor_NotificationReady;
            try { _activityMonitor.StopAsync().GetAwaiter().GetResult(); } catch { }
            _activityMonitor.Dispose();
            _vNextDevUploadTimer.Stop();
            _vNextDevRetryTimer.Stop();
            _ttsHealthTimer.Stop();
            _vNextDevUploadTimer.Dispose();
            _vNextDevRetryTimer.Dispose();
            _ttsHealthTimer.Dispose();
            _ttsHealthHttp.Dispose();
            if (_vNextLocalAgent is not null)
            {
                _vNextLocalAgent.StatusChanged -= VNextLocalAgent_StatusChanged;
                _vNextLocalAgent.Dispose();
            }
            _adaptiveWindow.Dispose();
            _weflabRecoveryLifetime.Dispose();
        }
        base.Dispose(disposing);
    }
}
