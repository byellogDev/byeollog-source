using System.Net.WebSockets;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace HurogiCollector;

internal sealed record VoiceAnonymizerPresetState(
    string Preset,
    string Label,
    string FilterName,
    bool Ready,
    bool? FilterEnabled,
    string State,
    string Message);

/// <summary>
/// 별록 에이전트가 보유한 메모리 세션으로 뉴별록 자동화 규칙을 관리합니다.
/// access/refresh token은 WebView에 전달하지 않으며 모든 원격 요청은 C# 경계에서 수행합니다.
/// </summary>
internal sealed class VNextAutomationSettingsForm : Form
{
    private const int EAbortHResult = unchecked((int)0x80004004);
    private static readonly TimeSpan ShutdownDrainTimeout = TimeSpan.FromSeconds(3);
    // 서버 송출 기한(2분)에 UI 여유를 더해 최종 ACK를 기다린다.
    // retryable 중간 ACK는 최종 실패로 간주하지 않아 자동 재시도와 수동 재송출의 중복을 막는다.
    private static readonly TimeSpan RafflePresentationAckTimeout = TimeSpan.FromMinutes(3);
    private readonly string _uiRoot;
    private bool _darkMode;
    private readonly VNextDevelopmentClient _client;
    private readonly VNextLocalAgent? _localAgent;
    private readonly CollectorStorage _storage;
    private readonly CoreWebView2Environment _environment;
    private readonly WebView2 _web = new() { Dock = DockStyle.Fill };
    private readonly CancellationTokenSource _lifetime = new();
    private readonly CancellationToken _lifetimeToken;
    private readonly long _openedSessionEpoch;
    private readonly TaskCompletionSource<bool> _messageHandlersDrained =
        new(TaskCreationOptions.RunContinuationsAsynchronously);
    private IReadOnlyDictionary<string, VNextAutomationDeviceView> _loadedDeviceSnapshot =
        new Dictionary<string, VNextAutomationDeviceView>(StringComparer.OrdinalIgnoreCase);
    private IReadOnlyDictionary<string, VNextAutomationOverlayAssetView> _loadedOverlaySnapshot =
        new Dictionary<string, VNextAutomationOverlayAssetView>(StringComparer.OrdinalIgnoreCase);
    private CollectorPreflightReport? _readinessReport;
    private long _readinessReportEpoch;
    private CoreWebView2? _core;
    private Task _initializationTask = Task.CompletedTask;
    private int _activeMessageHandlers;
    private int _generation = 1;
    private long _nextOperationOwnerId;
    private long _busyOperationOwnerId;
    private string _pendingView = "";
    private bool _initializationStarted;
    private bool _closing;
    private bool _closePending;
    private bool _ready;
    private bool _canManage;

    internal event Action<string>? BackRequested;
    internal event Action? HostWindowDragRequested;
    internal event Action? HostMinimizeRequested;
    internal event Action? HostCloseRequested;
    internal event Action<string>? HostThemeChangedRequested;
    internal long OpenedSessionEpoch => _openedSessionEpoch;

    internal VNextAutomationSettingsForm(
        string uiRoot,
        bool darkMode,
        Icon? appIcon,
        VNextDevelopmentClient client,
        VNextLocalAgent? localAgent,
        CollectorStorage storage,
        CoreWebView2Environment environment)
    {
        _uiRoot = uiRoot;
        _darkMode = darkMode;
        _client = client;
        _localAgent = localAgent;
        _storage = storage;
        _environment = environment;
        _lifetimeToken = _lifetime.Token;
        _openedSessionEpoch = _client.CaptureSessionEpoch();
        _client.SessionChanged += Client_SessionChanged;
        Text = "별록 에이전트 · 별록 액션";
        StartPosition = FormStartPosition.CenterParent;
        MinimumSize = new Size(980, 700);
        Size = new Size(1180, 820);
        BackColor = Color.FromArgb(7, 18, 38);
        if (appIcon is not null) Icon = appIcon;
        Controls.Add(_web);
        Shown += VNextAutomationSettingsForm_Shown;
        FormClosing += VNextAutomationSettingsForm_FormClosing;
    }

    internal void RequestHostShutdown() => MarkClosing();

    internal async Task ApplyHostThemeAsync(string theme)
    {
        _darkMode = !string.Equals(theme, "light", StringComparison.OrdinalIgnoreCase);
        if (_ready)
            await ExecuteAsync($"window.byeollogAutomation.setTheme('{(_darkMode ? "dark" : "light")}');");
    }

    /// <summary>
    /// 트레이/알림에서 요청한 탭을 WebView 준비 전에도 잃지 않고 마지막 요청 기준으로 엽니다.
    /// MainForm과 이 폼은 같은 WinForms UI 스레드에서 이 메서드를 호출합니다.
    /// </summary>
    internal async Task SelectViewAsync(string view)
    {
        var normalized = NormalizeView(view);
        if (normalized is null || IsClosing) return;
        _pendingView = normalized;
        await PushPendingViewAsync();
    }

    /// <summary>
    /// 준비 진단 실행자가 캡처한 세대와 결과를 함께 전달해야 다른 계정의 늦은
    /// 결과가 현재 WebView 상태를 덮지 않습니다. WebView 준비 전 결과도 보관합니다.
    /// </summary>
    internal async Task SetReadinessReportAsync(
        CollectorPreflightReport report,
        long expectedSessionEpoch)
    {
        ArgumentNullException.ThrowIfNull(report);
        if (IsClosing || !_client.IsSessionEpochCurrent(expectedSessionEpoch)) return;
        _readinessReport = report;
        _readinessReportEpoch = expectedSessionEpoch;
        await PushReadinessReportAsync();
    }

    internal async Task WaitForShutdownAsync()
    {
        MarkClosing();
        var messageDrain = Volatile.Read(ref _activeMessageHandlers) > 0
            ? _messageHandlersDrained.Task
            : Task.CompletedTask;
        var drain = Task.WhenAll(_initializationTask, messageDrain);
        if (await Task.WhenAny(drain, Task.Delay(ShutdownDrainTimeout)) != drain)
        {
            // EnsureCoreWebView2Async는 취소 토큰을 받지 않습니다. 비정상적으로
            // 멈춘 controller 시작 때문에 재열기가 영구 차단되지 않게 하고,
            // 늦은 continuation은 closing/generation 경계에서 무해화합니다.
            _storage.Log("Automation UI shutdown drain timed out; disposing the stale generation");
            return;
        }
        await drain;
    }

    private bool IsClosing => _closing || IsDisposed || Disposing;

    private bool IsCurrentGeneration(int generation) =>
        !IsClosing && generation == _generation;

    private void VNextAutomationSettingsForm_Shown(object? sender, EventArgs e)
    {
        if (_client.SessionEpoch != _openedSessionEpoch)
        {
            Close();
            return;
        }
        if (_initializationStarted || IsClosing) return;
        _initializationStarted = true;
        _initializationTask = InitializeAsync();
    }

    private void VNextAutomationSettingsForm_FormClosing(object? sender, FormClosingEventArgs e) =>
        MarkClosing();

    private void Client_SessionChanged(object? sender, EventArgs e)
    {
        if (_client.SessionEpoch == _openedSessionEpoch || IsDisposed || Disposing) return;
        try
        {
            if (IsHandleCreated)
                BeginInvoke(new Action(() =>
                {
                    if (!IsDisposed && !Disposing) Close();
                }));
        }
        catch (ObjectDisposedException) { }
        catch (InvalidOperationException) { }
    }

    private void MarkClosing()
    {
        if (_closing) return;
        _closing = true;
        _ready = false;
        _pendingView = "";
        _readinessReport = null;
        _readinessReportEpoch = 0;
        Interlocked.Exchange(ref _busyOperationOwnerId, 0);
        unchecked { _generation++; }
        try { _lifetime.Cancel(); }
        catch (ObjectDisposedException) { }
        if (Volatile.Read(ref _activeMessageHandlers) == 0)
            _messageHandlersDrained.TrySetResult(true);
    }

    private void RequestCloseAfterWebMessage()
    {
        if (_closePending || IsClosing) return;
        _closePending = true;
        MarkClosing();
        try
        {
            BeginInvoke(new Action(Close));
        }
        catch (InvalidOperationException) { }
    }

    private static string? NormalizeView(string? view) => view switch
    {
        "rules" => "rules",
        "readiness" => "readiness",
        "devices" => "devices",
        "overlays" => "overlays",
        "activity" => "activity",
        _ => null
    };

    private async Task PushPendingViewAsync()
    {
        if (!_ready || IsClosing || string.IsNullOrEmpty(_pendingView)) return;
        var pending = _pendingView;
        await ExecuteAsync(
            "window.byeollogAutomation.selectView(" +
            JsonSerializer.Serialize(pending) +
            ");");
        if (string.Equals(_pendingView, pending, StringComparison.Ordinal))
            _pendingView = "";
    }

    private async Task PushReadinessReportAsync()
    {
        var report = _readinessReport;
        var epoch = _readinessReportEpoch;
        if (!_ready || IsClosing || report is null) return;
        if (!_client.IsSessionEpochCurrent(epoch))
        {
            _readinessReport = null;
            _readinessReportEpoch = 0;
            return;
        }
        var json = JsonSerializer.Serialize(new
        {
            readiness = new
            {
                checks = report.Checks,
                overallState = report.OverallState,
                loadedAtUtc = report.GeneratedAtUtc
            }
        });
        await ExecuteAsync("window.byeollogAutomation.setState(" + json + ");");
    }

    private async Task InitializeAsync()
    {
        var generation = _generation;
        var stage = "controller";
        try
        {
            await EnsureControllerAsync(generation);
            if (!IsCurrentGeneration(generation)) return;

            stage = "security-policy";
            var core = _web.CoreWebView2;
            _core = core;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.Settings.AreHostObjectsAllowed = false;
            core.Settings.IsWebMessageEnabled = true;
            core.SetVirtualHostNameToFolderMapping(
                WebViewTrustPolicy.AutomationHost,
                _uiRoot,
                CoreWebView2HostResourceAccessKind.DenyCors);
            core.NavigationStarting += Core_NavigationStarting;
            core.FrameNavigationStarting += Core_FrameNavigationStarting;
            core.NewWindowRequested += Core_NewWindowRequested;
            core.PermissionRequested += Core_PermissionRequested;
            core.DownloadStarting += Core_DownloadStarting;
            core.WebMessageReceived += Core_WebMessageReceived;
            if (!IsCurrentGeneration(generation)) return;

            stage = "navigation";
            _web.Source = new Uri(
                $"https://{WebViewTrustPolicy.AutomationHost}{WebViewTrustPolicy.AutomationPath}?theme={(_darkMode ? "dark" : "light")}");
        }
        catch (OperationCanceledException) when (IsClosing || _lifetimeToken.IsCancellationRequested)
        {
            // 사용자가 초기화 중 창을 닫은 정상 경로
        }
        catch (Exception ex) when (IsClosing &&
            (ex.HResult == EAbortHResult || ex is InvalidOperationException or ObjectDisposedException))
        {
            _storage.Log($"Automation UI initialization stopped during close: stage={stage} type={ex.GetType().Name} hresult=0x{ex.HResult:X8}");
        }
        catch (Exception ex)
        {
            _storage.Log($"Automation UI initialization failed: stage={stage} type={ex.GetType().Name} hresult=0x{ex.HResult:X8}");
            if (IsClosing) return;
            MessageBox.Show(
                "별록 액션 화면을 열지 못했습니다.\n\n" + ex.Message,
                "별록 에이전트",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            RequestCloseAfterWebMessage();
        }
    }

    private async Task EnsureControllerAsync(int generation)
    {
        try
        {
            await _web.EnsureCoreWebView2Async(_environment);
        }
        catch (Exception ex) when (ex.HResult == EAbortHResult && IsCurrentGeneration(generation))
        {
            // 활성 창의 일시적인 생성 취소는 한 번만 재시도합니다. 닫는 세대의
            // E_ABORT는 InitializeAsync의 종료 필터에서 정상 종료로 처리됩니다.
            _storage.Log("Automation UI controller creation returned E_ABORT; retrying once");
            await Task.Delay(120, _lifetimeToken);
            if (!IsCurrentGeneration(generation)) return;
            await _web.EnsureCoreWebView2Async(_environment);
        }
    }

    private void Core_NavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (WebViewTrustPolicy.IsAllowedAutomationNavigation(e.Uri, out _)) return;
        e.Cancel = true;
        _storage.Log("Automation UI navigation blocked: " + WebViewTrustPolicy.SafeOriginForLog(e.Uri));
    }

    private void Core_FrameNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        e.Cancel = true;
        _storage.Log("Automation UI frame navigation blocked: " + WebViewTrustPolicy.SafeOriginForLog(e.Uri));
    }

    private static void Core_NewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e) =>
        e.Handled = true;

    private void Core_PermissionRequested(object? sender, CoreWebView2PermissionRequestedEventArgs e)
    {
        e.State = CoreWebView2PermissionState.Deny;
        e.SavesInProfile = false;
        e.Handled = true;
        _storage.Log(
            "Automation UI permission denied: kind=" + e.PermissionKind +
            " origin=" + WebViewTrustPolicy.SafeOriginForLog(e.Uri));
    }

    private void Core_DownloadStarting(object? sender, CoreWebView2DownloadStartingEventArgs e)
    {
        e.Cancel = true;
        _storage.Log(
            "Automation UI download blocked: " +
            WebViewTrustPolicy.SafeOriginForLog(e.DownloadOperation.Uri));
    }

    private async void Core_WebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (IsClosing) return;
        Interlocked.Increment(ref _activeMessageHandlers);
        if (IsClosing)
        {
            CompleteMessageHandler();
            return;
        }

        try { await HandleMessageAsync(e); }
        catch (Exception ex)
        {
            // async-void WebView2 이벤트 경계의 최종 방화벽입니다. 오류 처리 중
            // renderer가 종료되어 toast/busy script까지 실패해도 앱 전체로
            // 미처리 예외가 전파되지 않게 합니다.
            try
            {
                _storage.Log($"Automation WebView callback failed: type={ex.GetType().Name} hresult=0x{ex.HResult:X8}");
            }
            catch
            {
                // 진단 파일 I/O 실패까지 async-void 경계 밖으로 전파하지 않습니다.
            }
        }
        finally { CompleteMessageHandler(); }
    }

    private void CompleteMessageHandler()
    {
        if (Interlocked.Decrement(ref _activeMessageHandlers) == 0 && IsClosing)
            _messageHandlersDrained.TrySetResult(true);
    }

    private async Task HandleMessageAsync(CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (IsClosing) return;
        if (!_client.IsSessionEpochCurrent(_openedSessionEpoch))
        {
            RequestCloseAfterWebMessage();
            return;
        }
        if (!WebViewTrustPolicy.IsTrustedAutomationMessageSource(e.Source))
        {
            _storage.Log("Automation UI message blocked (source): " + WebViewTrustPolicy.SafeOriginForLog(e.Source));
            return;
        }
        string raw;
        try { raw = e.WebMessageAsJson; }
        catch { return; }
        if (!WebViewTrustPolicy.TryParseAutomationMessage(raw, out var root, out var action, out var reason))
        {
            _storage.Log("Automation UI message blocked (" + reason + ")");
            return;
        }
        if (IsBusy && action is not ("closeAutomation" or "cancelAutomationEdit" or "automationWindowDrag" or "automationMinimize" or "automationClose" or "theme")) return;

        var operationEpoch = _client.CaptureSessionEpoch();
        try
        {
            var payload = root.TryGetProperty("payload", out var value) ? value : default;
            switch (action)
            {
                case "automationWindowDrag":
                    HostWindowDragRequested?.Invoke();
                    return;
                case "automationMinimize":
                    HostMinimizeRequested?.Invoke();
                    return;
                case "automationClose":
                    HostCloseRequested?.Invoke();
                    return;
                case "theme":
                    if (payload.ValueKind == JsonValueKind.Object
                        && payload.TryGetProperty("theme", out var themeElement))
                    {
                        var theme = string.Equals(themeElement.GetString(), "light", StringComparison.OrdinalIgnoreCase)
                            ? "light"
                            : "dark";
                        _darkMode = theme == "dark";
                        HostThemeChangedRequested?.Invoke(theme);
                    }
                    return;
                case "automationReady":
                    _ready = true;
                    await PushPendingViewAsync();
                    await PushReadinessReportAsync();
                    await RunOperationAsync(
                        "자동화 설정을 불러오는 중이에요.",
                        ownerId => LoadAndPushStateAsync(showToast: false, ownerId));
                    break;
                case "refreshAutomation":
                    await RunOperationAsync(
                        "별록 액션과 등록 PC를 불러오는 중이에요.",
                        ownerId => LoadAndPushStateAsync(showToast: true, ownerId));
                    break;
                case "refreshReadiness":
                    await RunOperationAsync(
                        "방송 준비 상태를 확인하는 중이에요.",
                        ownerId => LoadReadinessAndPushAsync(showToast: true, ownerId));
                    break;
                case "refreshActivity":
                    await RunOperationAsync(
                        "최근 자동화 활동을 불러오는 중이에요.",
                        ownerId => LoadActivityAndPushAsync(showToast: true, ownerId));
                    break;
                case "refreshRaffle":
                    await RunOperationAsync(
                        "추첨권과 최근 당첨 결과를 불러오는 중이에요.",
                        ownerId => LoadRaffleAndPushAsync(showToast: true, ownerId));
                    break;
                case "refreshLocalConnections":
                    await RunOperationAsync(
                        "이 PC의 마이크 장치를 다시 찾는 중이에요.",
                        ownerId => PushLocalConnectionsAsync(ownerId, showToast: true));
                    break;
                case "saveAutomationRule":
                    await SaveRuleAsync(payload);
                    break;
                case "toggleAutomationRule":
                    await ToggleRuleAsync(payload);
                    break;
                case "deleteAutomationRule":
                    await DeleteRuleAsync(payload);
                    break;
                case "testAutomationRule":
                    await TestRuleAsync(payload);
                    break;
                case "previewRaffleTts":
                    await PreviewRaffleTtsAsync(payload);
                    break;
                case "previewFlashbang":
                    await PreviewFlashbangAsync(payload);
                    break;
                case "startRaffleDraw":
                    await StartRaffleDrawAsync(payload);
                    break;
                case "drawNextRaffleWinner":
                    await DrawNextRaffleWinnerAsync(payload);
                    break;
                case "reannounceRaffleWinner":
                    await ReannounceRaffleWinnerAsync(payload);
                    break;
                case "renameAgentDevice":
                    await RenameDeviceAsync(payload);
                    break;
                case "revokeAgentDevice":
                    await RevokeDeviceAsync(payload);
                    break;
                case "syncOverlayAssets":
                    await SyncOverlayAssetsAsync();
                    break;
                case "previewOverlayAsset":
                    await PreviewOverlayAssetAsync(payload);
                    break;
                case "copyOverlayUrl":
                    await CopyOverlayUrlAsync();
                    break;
                case "saveObsSettings":
                    await SaveObsSettingsAsync(payload);
                    break;
                case "testObsSettings":
                    await TestObsSettingsAsync(payload);
                    break;
                case "testVoiceAnonymizerFilter":
                    await TestVoiceAnonymizerFilterAsync(payload);
                    break;
                case "previewVoiceAnonymizer":
                    await PreviewVoiceAnonymizerAsync(payload);
                    break;
                case "saveWindowsMicSettings":
                    await SaveWindowsMicSettingsAsync(payload);
                    break;
                case "testWindowsMicSettings":
                    await TestWindowsMicSettingsAsync(payload);
                    break;
                case "editAutomationRule":
                case "cancelAutomationEdit":
                    break;
                case "closeAutomation":
                    var destination = payload.ValueKind == JsonValueKind.Object &&
                        payload.TryGetProperty("screen", out var screenElement)
                        ? screenElement.GetString() ?? "rules"
                        : "rules";
                    BackRequested?.Invoke(destination is "collection" or "main" ? destination : "rules");
                    return;
            }
        }
        catch (OperationCanceledException) when (IsClosing || _lifetimeToken.IsCancellationRequested)
        {
            // 창 종료 중 요청 취소
        }
        catch (Exception ex) when (IsClosing &&
            (ex.HResult == EAbortHResult || ex is InvalidOperationException or ObjectDisposedException))
        {
            // 닫힌 세대의 WebView/요청 continuation은 사용자 오류가 아닙니다.
        }
        catch (VNextDevelopmentException ex)
        {
            if (IsClosing) return;
            if (ex.StatusCode == 401 && !_client.IsSignedIn)
            {
                var expiredEpoch = _client.CaptureSessionEpoch();
                _storage.Log($"Automation session expired: code={ex.Code} status=401");
                await SetSessionExpiredAsync(expiredEpoch);
                return;
            }
            if (!_client.IsSessionEpochCurrent(operationEpoch)) return;
            _storage.Log($"Automation request failed: code={ex.Code} status={ex.StatusCode?.ToString() ?? "none"}");
            await ShowToastAsync(ex.Message, "error");
        }
        catch (Exception ex)
        {
            if (IsClosing || !_client.IsSessionEpochCurrent(operationEpoch)) return;
            _storage.Log("Automation request failed: " + ex.GetType().Name);
            await ShowToastAsync("요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.", "error");
        }
    }

    private IReadOnlyList<VNextAutomationOverlayAssetView> CreatePackagedOverlayViews()
    {
        if (_localAgent is null) return Array.Empty<VNextAutomationOverlayAssetView>();
        var durations = Enumerable.Range(1, 240).ToArray();
        return _localAgent.PackagedOverlayImages()
            .Select(asset => new VNextAutomationOverlayAssetView(
                asset.AssetId,
                asset.AssetKey,
                asset.VersionNumber,
                asset.DisplayName,
                asset.MimeType,
                asset.ContentSha256,
                asset.ByteSize,
                asset.WidthPx,
                asset.HeightPx,
                "agent_packaged",
                durations))
            .ToArray();
    }

    private object[] CreateOverlayUi(IReadOnlyList<VNextAutomationOverlayAssetView> overlays) =>
        overlays.Select(asset => (object)new
        {
            assetId = asset.AssetId,
            assetKey = asset.AssetKey,
            versionNumber = asset.VersionNumber,
            displayName = asset.DisplayName,
            mimeType = asset.MimeType,
            contentSha256 = asset.ContentSha256,
            byteSize = asset.ByteSize,
            widthPx = asset.WidthPx,
            heightPx = asset.HeightPx,
            deliveryMode = asset.DeliveryMode,
            durationSeconds = asset.DurationSeconds,
            previewDataUrl = _localAgent?.TryCreateOverlayPreviewDataUrl(asset.AssetId, asset.ContentSha256)
        }).ToArray();

    private async Task LoadAndPushStateAsync(bool showToast, long ownerId)
    {
        var sessionEpoch = _client.CaptureSessionEpoch();
        var packagedOverlays = CreatePackagedOverlayViews();
        var packagedOverlayUi = CreateOverlayUi(packagedOverlays);
        if (!_client.IsSignedIn)
        {
            var localAgentOnly = await CreateLocalAgentStateAsync();
            var localConnectionsOnly = await CreateLocalConnectionsStateAsync();
            if (!CanCommit(ownerId, sessionEpoch)) return;
            var offlineJson = JsonSerializer.Serialize(new
            {
                connected = false,
                canManage = false,
                streamerName = _storage.StreamerName,
                releaseLabel = BuildInfo.DisplayVersion,
                theme = _darkMode ? "dark" : "light",
                rules = Array.Empty<object>(),
                agentDevices = Array.Empty<object>(),
                overlayAssets = packagedOverlayUi,
                assetReadiness = Array.Empty<object>(),
                localAgent = localAgentOnly,
                localConnections = localConnectionsOnly,
                activity = new { items = Array.Empty<object>(), saturated = false },
                readiness = new { requirements = Array.Empty<object>(), checks = Array.Empty<object>(), overallState = "unavailable", canEvaluate = false },
                raffle = new { round = (object?)null, activeDraw = (object?)null, history = Array.Empty<object>() },
                lastUpdatedAt = DateTimeOffset.UtcNow,
                sessionExpired = true
            });
            await ExecuteAsync("window.byeollogAutomation.setState(" + offlineJson + ");");
            return;
        }
        var accessTask = _client.GetWorkspaceAccessAsync(_lifetimeToken);
        var activityTask = _client.LoadActivityAsync(100, _lifetimeToken);
        await Task.WhenAll(accessTask, activityTask);
        var access = await accessTask;
        var activity = await activityTask;
        _lifetimeToken.ThrowIfCancellationRequested();
        if (!CanCommit(ownerId, sessionEpoch)) return;

        _canManage = access.CanManage;
        if (!_canManage)
        {
            _loadedDeviceSnapshot =
                new Dictionary<string, VNextAutomationDeviceView>(StringComparer.OrdinalIgnoreCase);
            _loadedOverlaySnapshot =
                new Dictionary<string, VNextAutomationOverlayAssetView>(StringComparer.OrdinalIgnoreCase);
        }
        await PushAccessAndActivityAsync(access, activity, ownerId, sessionEpoch);
        if (!CanCommit(ownerId, sessionEpoch)) return;

        VNextAutomationState? management = null;
        IReadOnlyList<VNextReadinessRequirement> requirements =
            Array.Empty<VNextReadinessRequirement>();
        if (_canManage)
        {
            await UpdateOperationAsync(ownerId, "별록 액션과 방송 준비 상태를 불러오는 중이에요.");
            var managementTask = _client.LoadAutomationStateAsync(_lifetimeToken);
            var requirementsTask = _client.LoadBroadcastReadinessRequirementsAsync(_lifetimeToken);
            var readinessTask = CollectorPreflightRunner.RunAsync(
                BuildInfo.InformationalVersion,
                _storage,
                _client,
                _localAgent,
                _lifetimeToken);
            await Task.WhenAll(managementTask, requirementsTask, readinessTask);
            management = await managementTask;
            requirements = await requirementsTask;
            _readinessReport = await readinessTask;
            _readinessReportEpoch = sessionEpoch;
        }

        var localAgent = await CreateLocalAgentStateAsync();
        var localConnections = await CreateLocalConnectionsStateAsync();
        _lifetimeToken.ThrowIfCancellationRequested();
        if (!CanCommit(ownerId, sessionEpoch)) return;

        var emptyRules = JsonSerializer.SerializeToElement(Array.Empty<object>());
        var rules = management?.Rules ?? emptyRules;
        IReadOnlyList<VNextAutomationDeviceView> devices =
            management?.AgentDevices ?? Array.Empty<VNextAutomationDeviceView>();
        IReadOnlyList<VNextAutomationOverlayAssetView> overlays = packagedOverlays;
        IReadOnlyList<VNextAutomationAssetReadinessView> assetReadiness =
            Array.Empty<VNextAutomationAssetReadinessView>();
        _loadedDeviceSnapshot = devices.ToDictionary(
            device => device.DeviceId,
            StringComparer.OrdinalIgnoreCase);
        _loadedOverlaySnapshot = overlays.ToDictionary(
            asset => asset.AssetId,
            StringComparer.OrdinalIgnoreCase);
        var overlayUi = CreateOverlayUi(overlays);
        var readinessReport = _readinessReportEpoch == sessionEpoch
            ? _readinessReport
            : null;
        var json = JsonSerializer.Serialize(new
        {
            connected = true,
            canManage = _canManage,
            role = access.Role,
            streamerName = _storage.StreamerName,
            releaseLabel = BuildInfo.DisplayVersion,
            theme = _darkMode ? "dark" : "light",
            rules,
            agentDevices = devices,
            overlayAssets = overlayUi,
            assetReadiness,
            currentDeviceId = _localAgent?.DeviceId,
            localAgent,
            localConnections,
            activity = CreateActivityUiState(activity),
            readiness = new
            {
                requirements,
                checks = readinessReport?.Checks ?? Array.Empty<CollectorPreflightCheck>(),
                overallState = readinessReport?.OverallState ?? (_canManage ? "pending" : "unavailable"),
                canEvaluate = _canManage,
                loadedAtUtc = readinessReport?.GeneratedAtUtc ?? DateTimeOffset.UtcNow
            },
            raffle = management?.Raffle ?? JsonSerializer.SerializeToElement(new { round = (object?)null, activeDraw = (object?)null, history = Array.Empty<object>() }),
            lastUpdatedAt = DateTimeOffset.UtcNow,
            sessionExpired = false
        });
        if (!CanCommit(ownerId, sessionEpoch)) return;
        await ExecuteAsync("window.byeollogAutomation.setState(" + json + ");");
        if (showToast && CanCommit(ownerId, sessionEpoch))
            await ShowToastAsync("최신 자동화 설정을 불러왔어요.", "success");
    }

    private async Task LoadActivityAndPushAsync(bool showToast, long ownerId)
    {
        var sessionEpoch = _client.CaptureSessionEpoch();
        var activity = await _client.LoadActivityAsync(100, _lifetimeToken);
        _lifetimeToken.ThrowIfCancellationRequested();
        if (!CanCommit(ownerId, sessionEpoch)) return;
        var json = JsonSerializer.Serialize(new
        {
            activity = CreateActivityUiState(activity),
            lastUpdatedAt = DateTimeOffset.UtcNow
        });
        await ExecuteAsync("window.byeollogAutomation.setState(" + json + ");");
        if (showToast && CanCommit(ownerId, sessionEpoch))
            await ShowToastAsync("최근 자동화 활동을 불러왔어요.", "success");
    }

    private async Task PushAccessAndActivityAsync(
        VNextWorkspaceAccess access,
        VNextActivityPage activity,
        long ownerId,
        long sessionEpoch)
    {
        if (!CanCommit(ownerId, sessionEpoch)) return;
        object state = access.CanManage
            ? new
            {
                connected = true,
                canManage = true,
                role = access.Role,
                activity = CreateActivityUiState(activity),
                sessionExpired = false
            }
            : new
            {
                connected = true,
                canManage = false,
                role = access.Role,
                activity = CreateActivityUiState(activity),
                rules = Array.Empty<object>(),
                agentDevices = Array.Empty<object>(),
                overlayAssets = Array.Empty<object>(),
                assetReadiness = Array.Empty<object>(),
                readiness = new
                {
                    requirements = Array.Empty<object>(),
                    checks = Array.Empty<object>(),
                    overallState = "unavailable",
                    canEvaluate = false
                },
                sessionExpired = false
            };
        await ExecuteAsync(
            "window.byeollogAutomation.setState(" +
            JsonSerializer.Serialize(state) +
            ");");
    }

    private async Task LoadReadinessAndPushAsync(bool showToast, long ownerId)
    {
        var sessionEpoch = _client.CaptureSessionEpoch();
        var access = await _client.GetWorkspaceAccessAsync(_lifetimeToken);
        _lifetimeToken.ThrowIfCancellationRequested();
        if (!CanCommit(ownerId, sessionEpoch)) return;
        _canManage = access.CanManage;
        IReadOnlyList<VNextReadinessRequirement> requirements =
            Array.Empty<VNextReadinessRequirement>();
        if (_canManage)
        {
            var requirementsTask = _client.LoadBroadcastReadinessRequirementsAsync(_lifetimeToken);
            var readinessTask = CollectorPreflightRunner.RunAsync(
                BuildInfo.InformationalVersion,
                _storage,
                _client,
                _localAgent,
                _lifetimeToken);
            await Task.WhenAll(requirementsTask, readinessTask);
            requirements = await requirementsTask;
            _readinessReport = await readinessTask;
            _readinessReportEpoch = sessionEpoch;
        }
        _lifetimeToken.ThrowIfCancellationRequested();
        if (!CanCommit(ownerId, sessionEpoch)) return;
        var readinessReport = _readinessReportEpoch == sessionEpoch
            ? _readinessReport
            : null;
        var json = JsonSerializer.Serialize(new
        {
            canManage = _canManage,
            role = access.Role,
            readiness = new
            {
                requirements,
                checks = readinessReport?.Checks ?? Array.Empty<CollectorPreflightCheck>(),
                overallState = readinessReport?.OverallState ?? (_canManage ? "pending" : "unavailable"),
                canEvaluate = _canManage,
                loadedAtUtc = readinessReport?.GeneratedAtUtc ?? DateTimeOffset.UtcNow
            },
            lastUpdatedAt = DateTimeOffset.UtcNow
        });
        await ExecuteAsync("window.byeollogAutomation.setState(" + json + ");");
        if (showToast && CanCommit(ownerId, sessionEpoch))
        {
            await ShowToastAsync(
                _canManage
                    ? "방송 준비 요구 사항을 새로 확인했어요."
                    : "현재 별록 계정의 워크스페이스 연결을 다시 확인해주세요.",
                _canManage ? "success" : "warning");
        }
    }

    private static object CreateActivityUiState(VNextActivityPage page) => new
    {
        items = page.Items.Select(item => new
        {
            status = item.Status,
            attemptCount = item.AttemptCount,
            maxAttempts = item.MaxAttempts,
            nextAttemptAt = item.NextAttemptAt,
            leaseExpiresAt = item.LeaseExpiresAt,
            createdAt = item.CreatedAt,
            updatedAt = item.UpdatedAt,
            actionType = item.ActionType,
            executionTarget = item.ExecutionTarget,
            errorDisposition = item.ErrorDisposition,
            errorCode = item.ErrorCode,
            eventSource = item.EventSource,
            eventType = item.EventType,
            eventSubtype = item.EventSubtype,
            eventOccurredAt = item.EventOccurredAt,
            actorName = item.ActorName,
            ruleName = item.RuleName
        }),
        saturated = page.Saturated,
        loadedAtUtc = page.LoadedAtUtc
    };

    private async Task SaveRuleAsync(JsonElement payload)
    {
        RequireCanManage();
        await RunOperationAsync("규칙을 안전하게 저장하는 중이에요.", async ownerId =>
        {
            var sessionEpoch = _client.CaptureSessionEpoch();
            var receipt = await _client.SaveAutomationRuleAsync(payload, _lifetimeToken);
            _lifetimeToken.ThrowIfCancellationRequested();
            if (!CanCommit(ownerId, sessionEpoch)) return;
            await LoadAndPushStateAsync(showToast: false, ownerId);
            if (CanCommit(ownerId, sessionEpoch))
                await ShowToastAsync($"규칙 v{receipt.RuleVersion}을 저장했어요.", "success");
        });
    }

    private async Task ToggleRuleAsync(JsonElement payload)
    {
        var ruleId = payload.TryGetProperty("ruleId", out var id) ? id.GetString() ?? "" : "";
        var version = payload.TryGetProperty("expectedVersion", out var versionValue) && versionValue.TryGetInt32(out var parsed)
            ? parsed
            : 0;
        if (!payload.TryGetProperty("enabled", out var enabledValue)
            || enabledValue.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            throw new VNextDevelopmentException("규칙 사용 상태를 확인해주세요.", code: "invalid_rule_payload");
        var enabled = enabledValue.GetBoolean();
        RequireCanManage();
        await RunOperationAsync(enabled ? "규칙을 켜는 중이에요." : "규칙을 끄는 중이에요.", async ownerId =>
        {
            var sessionEpoch = _client.CaptureSessionEpoch();
            var receipt = await _client.SetAutomationRuleEnabledAsync(ruleId, version, enabled, _lifetimeToken);
            _lifetimeToken.ThrowIfCancellationRequested();
            if (!CanCommit(ownerId, sessionEpoch)) return;
            await LoadAndPushStateAsync(showToast: false, ownerId);
            if (CanCommit(ownerId, sessionEpoch))
                await ShowToastAsync(receipt.Enabled ? "규칙을 켰어요." : "규칙을 껐어요.", "success");
        });
    }

    private async Task DeleteRuleAsync(JsonElement payload)
    {
        var ruleId = PayloadGuid(payload, "ruleId", "별록 액션");
        var version = PayloadLong(payload, "expectedVersion", 1, int.MaxValue, "규칙 버전");
        RequireCanManage();
        await RunOperationAsync("별록 액션을 삭제하는 중이에요.", async ownerId =>
        {
            var sessionEpoch = _client.CaptureSessionEpoch();
            var receipt = await _client.DeleteAutomationRuleAsync(
                ruleId,
                checked((int)version),
                _lifetimeToken);
            _lifetimeToken.ThrowIfCancellationRequested();
            if (!CanCommit(ownerId, sessionEpoch)) return;
            await LoadAndPushStateAsync(showToast: false, ownerId);
            if (CanCommit(ownerId, sessionEpoch))
                await ShowToastAsync($"규칙 v{receipt.DeletedVersion}을 삭제했어요. 실행 기록은 유지됩니다.", "success");
        });
    }

    private async Task TestRuleAsync(JsonElement payload)
    {
        var ruleId = PayloadGuid(payload, "ruleId", "별록 액션");
        var version = PayloadLong(payload, "expectedVersion", 1, int.MaxValue, "액션 버전");
        RequireCanManage();
        await RunOperationAsync("실제 테스트 송출을 준비하는 중이에요.", async ownerId =>
        {
            var sessionEpoch = _client.CaptureSessionEpoch();
            var receipt = await _client.DispatchAutomationRuleTestAsync(
                ruleId,
                checked((int)version),
                _lifetimeToken);
            _lifetimeToken.ThrowIfCancellationRequested();
            if (!CanCommit(ownerId, sessionEpoch)) return;
            _localAgent?.Wake();
            var runsOnThisPc = _localAgent is not null
                && string.Equals(
                    receipt.AgentDeviceId,
                    _localAgent.DeviceId,
                    StringComparison.OrdinalIgnoreCase);
            VNextAgentAck? ack = null;
            if (runsOnThisPc)
            {
                ack = await _localAgent!.WaitForAckOutcomeAsync(
                    receipt.ExecutionId,
                    RafflePresentationAckTimeout,
                    _lifetimeToken);
                if (ack is null)
                    throw new VNextDevelopmentException(
                        "테스트 송출의 자동 재시도가 3분 안에 끝나지 않았습니다. 실행 기록에서 최종 상태를 확인해주세요.",
                        code: "automation_test_ack_timeout");
                if (!ack.Succeeded)
                    throw new VNextDevelopmentException(
                        "선택한 PC가 테스트 송출을 완료하지 못했습니다. 실행 기록에서 원인을 확인해주세요.",
                        code: "automation_test_failed");
            }
            await LoadActivityAndPushAsync(showToast: false, ownerId);
            if (CanCommit(ownerId, sessionEpoch))
            {
                if (runsOnThisPc
                    && ack is not null
                    && string.Equals(
                        receipt.ActionType,
                        RaffleOverlayActionAdapter.ActionType,
                        StringComparison.Ordinal))
                {
                    var (deliveryCopy, deliveryTone) = DescribeRaffleDeliveryAck(ack);
                    await ShowToastAsync(
                        $"추첨 테스트 완료 · {deliveryCopy} ({receipt.ExecutionId[..8]})",
                        deliveryTone);
                }
                else
                {
                    await ShowToastAsync(
                        runsOnThisPc
                            ? $"테스트 송출과 완료 확인을 마쳤어요. ({receipt.ExecutionId[..8]})"
                            : $"다른 PC에 테스트 송출을 요청했어요. 실행 기록에서 완료를 확인해주세요. ({receipt.ExecutionId[..8]})",
                        runsOnThisPc ? "success" : "warning");
                }
            }
        });
    }

    private async Task PreviewRaffleTtsAsync(JsonElement payload)
    {
        var kind = PayloadText(payload, "kind", "TTS 종류", 1, 32);
        if (kind is not ("ticket" or "draw"))
            throw new VNextDevelopmentException("TTS 테스트 종류가 올바르지 않습니다.", code: "invalid_tts_preview");
        var volumePercent = PayloadInt(payload, "volumePercent", 0, 100, "TTS 음량");
        if (volumePercent == 0)
        {
            await ShowToastAsync("음량이 0%라 TTS가 재생되지 않아요.", "warning");
            return;
        }
        if (kind == "draw")
            await ByeollogRaffleAudio.PlayWinnerPreviewAsync(volumePercent, _lifetimeToken);
        else
            await ByeollogRaffleAudio.PlayTicketAsync(volumePercent, _lifetimeToken);
        await ShowToastAsync(
            kind == "draw"
                ? $"이 PC에서 당첨 음성을 {volumePercent}%로 재생했어요."
                : $"이 PC에서 추첨권 음성을 {volumePercent}%로 재생했어요.",
            "success");
    }

    private async Task PreviewFlashbangAsync(JsonElement payload)
    {
        var intensity = PayloadText(payload, "intensity", "섬광 강도", 1, 16);
        if (intensity is not ("soft" or "standard" or "strong"))
            throw new VNextDevelopmentException(
                "섬광 강도가 올바르지 않습니다.",
                code: "invalid_flashbang_preview");
        var volumePercent = PayloadInt(payload, "volumePercent", 0, 100, "섬광탄 소리 음량");
        if (volumePercent == 0)
        {
            await ShowToastAsync("음량이 0%라 섬광탄 소리가 재생되지 않아요.", "warning");
            return;
        }
        await FlashbangOverlayActionAdapter.PlayPreviewBeepAsync(
            volumePercent,
            _lifetimeToken);
        await ShowToastAsync(
            $"이 PC에서 섬광탄 삐- 소리를 {volumePercent}%로 재생했어요.",
            "success");
    }

    private async Task LoadRaffleAndPushAsync(bool showToast, long ownerId)
    {
        RequireCanManage();
        var sessionEpoch = _client.CaptureSessionEpoch();
        var raffle = await _client.LoadRaffleStateAsync(_lifetimeToken);
        if (!CanCommit(ownerId, sessionEpoch)) return;
        await ExecuteAsync("window.byeollogAutomation.setState(" +
            JsonSerializer.Serialize(new { raffle, lastUpdatedAt = DateTimeOffset.UtcNow }) + ");");
        if (showToast && CanCommit(ownerId, sessionEpoch))
            await ShowToastAsync("추첨 현황을 새로고침했어요.", "success");
    }

    private async Task StartRaffleDrawAsync(JsonElement payload)
    {
        var roundId = PayloadGuid(payload, "roundId", "추첨 회차");
        var winnerCount = PayloadInt(payload, "winnerCount", 1, 100, "당첨 개수");
        var allowDuplicates = PayloadBoolean(payload, "allowDuplicateWinners", "중복 당첨 설정");
        RequireCanManage();
        await RunOperationAsync("추첨함을 봉인하고 추첨 순서를 준비하는 중이에요.", async ownerId =>
        {
            var sessionEpoch = _client.CaptureSessionEpoch();
            var receipt = await _client.StartRaffleDrawAsync(
                roundId,
                winnerCount,
                allowDuplicates,
                _lifetimeToken);
            if (!CanCommit(ownerId, sessionEpoch)) return;
            VNextRaffleSpeechPrewarmResult? prewarm = null;
            string? prewarmFailure = null;
            if (_localAgent is not null)
            {
                try
                {
                    await UpdateOperationAsync(
                        ownerId,
                        "추첨함 봉인 완료 · 당첨 후보 음성을 안전하게 준비하는 중이에요.");
                    prewarm = await _localAgent.PrewarmRaffleWinnerSpeechAsync(
                        receipt.DrawId,
                        (completed, total) => UpdateOperationAsync(
                            ownerId,
                            $"당첨 후보 음성을 확인하는 중이에요. {completed}/{total}"),
                        _lifetimeToken);
                }
                catch (OperationCanceledException) when (_lifetimeToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    prewarmFailure = ex.GetType().Name;
                    _storage.Log("추첨 후보 음성 사전 준비 보류 · type=" + prewarmFailure);
                }
            }
            await LoadRaffleAndPushAsync(showToast: false, ownerId);
            if (!CanCommit(ownerId, sessionEpoch)) return;
            if (prewarmFailure is not null)
            {
                await ShowToastAsync(
                    $"추첨함은 봉인됐지만 후보 음성을 미리 준비하지 못했습니다. 당첨 화면은 정상 진행되며, 음성은 대상 검증에 성공한 경우에만 재생됩니다. ({prewarmFailure})",
                    "warning");
                return;
            }
            if (prewarm is not null && (prewarm.Failed > 0 || prewarm.Truncated))
            {
                await ShowToastAsync(
                    $"추첨함을 봉인했어요. 후보 {prewarm.TotalCandidates}명 중 새 음성 {prewarm.Prepared}개·기존 음성 {prewarm.Reused}개를 확인했고 {prewarm.Failed}개는 보류했습니다. 미준비 후보가 당첨되면 대상 검증 후 생성하며, 검증 실패 시 화면만 송출됩니다.",
                    "warning");
                return;
            }
            var preparedCopy = prewarm is null
                ? ""
                : $" 후보 음성 {prewarm.Prepared + prewarm.Reused}개도 확인했습니다.";
            await ShowToastAsync(
                $"추첨함을 봉인했어요.{preparedCopy} 이제 {receipt.WinnerTarget}장을 한 장씩 뽑을 수 있습니다.",
                "success");
        });
    }

    private async Task DrawNextRaffleWinnerAsync(JsonElement payload)
    {
        var drawId = PayloadGuid(payload, "drawId", "진행 중인 추첨");
        var expectedDrawIndex = PayloadInt(payload, "expectedDrawIndex", 1, 100, "다음 추첨 순서");
        var agentDeviceId = PayloadGuid(payload, "agentDeviceId", "추첨 화면 송출 PC");
        RequireCanManage();
        await RunOperationAsync("다음 당첨 티켓 한 장을 뽑는 중이에요.", async ownerId =>
        {
            var sessionEpoch = _client.CaptureSessionEpoch();
            var receipt = await _client.DrawNextRaffleWinnerAsync(
                drawId,
                expectedDrawIndex,
                agentDeviceId,
                _lifetimeToken);
            if (!CanCommit(ownerId, sessionEpoch)) return;
            _localAgent?.Wake();
            var winnerName = receipt.Winner.TryGetProperty("actorName", out var actorName)
                && actorName.ValueKind == JsonValueKind.String
                ? actorName.GetString() ?? "당첨자"
                : "당첨자";
            var runsOnThisPc = _localAgent is not null
                && string.Equals(
                    receipt.AgentDeviceId,
                    _localAgent.DeviceId,
                    StringComparison.OrdinalIgnoreCase);
            VNextAgentAck? ack = null;
            if (runsOnThisPc)
            {
                ack = await _localAgent!.WaitForAckOutcomeAsync(
                    receipt.ExecutionId,
                    RafflePresentationAckTimeout,
                    _lifetimeToken);
            }
            await LoadRaffleAndPushAsync(showToast: false, ownerId);
            if (!CanCommit(ownerId, sessionEpoch)) return;
            if (!runsOnThisPc)
            {
                await ShowToastAsync(
                    $"{receipt.DrawnCount}번째 당첨자는 {winnerName}님으로 확정됐어요. 다른 PC에 송출을 요청했으며 완료 여부는 실행 기록에서 확인해주세요.",
                    "warning");
                return;
            }
            if (ack is null)
            {
                await ShowToastAsync(
                    $"{winnerName}님 당첨은 확정됐지만 송출이 자동 재시도 중이거나 3분 안에 끝나지 않았습니다. 실행 기록에서 최종 상태를 확인하기 전에는 재송출하지 마세요.",
                    "error");
                return;
            }
            if (!ack.Succeeded)
            {
                await ShowToastAsync(
                    $"{winnerName}님 당첨은 확정됐지만 화면·음성 송출에 실패했습니다. 실행 기록을 확인한 뒤 ‘동일 당첨 재송출’을 사용해주세요.",
                    "error");
                return;
            }
            var (deliveryCopy, deliveryTone) = DescribeRaffleDeliveryAck(ack);
            await ShowToastAsync(
                receipt.Completed
                    ? $"{receipt.DrawnCount}번째 당첨자는 {winnerName}님입니다. 추첨 완료 · {deliveryCopy}"
                    : $"{receipt.DrawnCount}번째 당첨자는 {winnerName}님입니다. {receipt.RemainingCount}장 남음 · {deliveryCopy}",
                deliveryTone);
        });
    }

    private async Task ReannounceRaffleWinnerAsync(JsonElement payload)
    {
        var drawId = PayloadGuid(payload, "drawId", "추첨 기록");
        var drawIndex = PayloadInt(payload, "drawIndex", 1, 100, "당첨 순서");
        var expectedReannounceNumber = PayloadInt(
            payload,
            "expectedReannounceNumber",
            1,
            10,
            "재송출 횟수");
        RequireCanManage();
        await RunOperationAsync("동일 당첨 화면과 음성을 다시 송출하는 중이에요.", async ownerId =>
        {
            var sessionEpoch = _client.CaptureSessionEpoch();
            var receipt = await _client.ReannounceRaffleWinnerAsync(
                drawId,
                drawIndex,
                expectedReannounceNumber,
                _lifetimeToken);
            _lifetimeToken.ThrowIfCancellationRequested();
            if (!CanCommit(ownerId, sessionEpoch)) return;

            _localAgent?.Wake();
            var runsOnThisPc = _localAgent is not null
                && string.Equals(
                    receipt.AgentDeviceId,
                    _localAgent.DeviceId,
                    StringComparison.OrdinalIgnoreCase);
            VNextAgentAck? ack = null;
            if (runsOnThisPc)
            {
                ack = await _localAgent!.WaitForAckOutcomeAsync(
                    receipt.ExecutionId,
                    RafflePresentationAckTimeout,
                    _lifetimeToken);
            }

            await LoadRaffleAndPushAsync(showToast: false, ownerId);
            if (!CanCommit(ownerId, sessionEpoch)) return;
            var winnerName = receipt.Winner.TryGetProperty("actorName", out var actorName)
                && actorName.ValueKind == JsonValueKind.String
                ? actorName.GetString() ?? "당첨자"
                : "당첨자";
            if (!runsOnThisPc)
            {
                await ShowToastAsync(
                    $"{winnerName}님의 동일 당첨을 다른 PC에 재송출 요청했어요. 실행 기록에서 완료 여부를 확인해주세요.",
                    "warning");
                return;
            }
            if (ack is null)
            {
                await ShowToastAsync(
                    $"{winnerName}님 재송출 요청은 기록됐지만 자동 재시도 중이거나 3분 안에 끝나지 않았습니다. 실행 기록에서 최종 상태를 확인하기 전에는 다음 재송출을 누르지 마세요.",
                    "error");
                return;
            }
            if (!ack.Succeeded)
            {
                await ShowToastAsync(
                    $"{winnerName}님 재송출 요청은 기록됐지만 화면·음성 송출에 실패했습니다. 실행 기록을 확인한 뒤 같은 당첨의 다음 재송출을 사용해주세요.",
                    "error");
                return;
            }

            var (deliveryCopy, tone) = DescribeRaffleDeliveryAck(ack);
            var replayCopy = receipt.Created ? "새 재송출" : "기존 재송출 요청";
            await ShowToastAsync(
                $"{winnerName}님 {replayCopy} 확인 완료 · {deliveryCopy}",
                tone);
        });
    }

    private static (string Copy, string Tone) DescribeRaffleDeliveryAck(VNextAgentAck ack)
    {
        if (ack.Result is not JsonElement result || result.ValueKind != JsonValueKind.Object)
            return ("오버레이 송출 완료 · TTS 결과는 실행 기록에서 확인해주세요.", "warning");
        var speechAttempted = result.TryGetProperty("speechAttempted", out var attemptedValue)
            && attemptedValue.ValueKind is JsonValueKind.True or JsonValueKind.False
            && attemptedValue.GetBoolean();
        var hasTtsResult = result.TryGetProperty("ttsPlayed", out var ttsValue)
            && ttsValue.ValueKind is JsonValueKind.True or JsonValueKind.False;
        if (hasTtsResult && ttsValue.GetBoolean())
        {
            var usedEmbeddedFallback = result.TryGetProperty("overlayEvidence", out var evidence)
                && evidence.ValueKind == JsonValueKind.Array
                && evidence.EnumerateArray().Any(item =>
                    item.ValueKind == JsonValueKind.Object
                    && item.TryGetProperty("TtsSource", out var source)
                    && source.ValueKind == JsonValueKind.String
                    && source.GetString() == "embedded_fallback");
            if (usedEmbeddedFallback)
                return ("오버레이와 예비 음성 송출 완료 · 맞춤 음성 연결을 확인해주세요.", "warning");
            return ("오버레이와 TTS 송출 완료", "success");
        }
        if (!speechAttempted && hasTtsResult)
            return ("오버레이 송출 완료 · TTS 음량 0%로 생략", "success");
        return ("오버레이 출력은 확인됐지만 TTS 재생에 실패했습니다.", "warning");
    }

    private async Task RenameDeviceAsync(JsonElement payload)
    {
        var deviceId = PayloadGuid(payload, "deviceId", "등록 PC");
        var expectedRevision = PayloadLong(payload, "expectedRevision", 1, long.MaxValue, "장치 변경 버전");
        var displayName = PayloadText(payload, "displayName", "장치 이름", 1, 60);
        RequireCanManage();
        RequireMutableDeviceSnapshot(deviceId, expectedRevision);
        await RunOperationAsync("등록 PC 이름을 저장하는 중이에요.", async ownerId =>
        {
            var sessionEpoch = _client.CaptureSessionEpoch();
            var receipt = await _client.RenameAgentDeviceAsync(
                deviceId,
                expectedRevision,
                displayName,
                _lifetimeToken);
            _lifetimeToken.ThrowIfCancellationRequested();
            if (!CanCommit(ownerId, sessionEpoch)) return;
            await LoadAndPushStateAsync(showToast: false, ownerId);
            if (CanCommit(ownerId, sessionEpoch))
                await ShowToastAsync($"‘{receipt.DisplayName}’ 이름을 저장했어요.", "success");
        });
    }

    private async Task RevokeDeviceAsync(JsonElement payload)
    {
        RequireCanManage();
        if (_localAgent is null)
            throw new VNextDevelopmentException(
                "현재 PC를 확인할 수 없어 등록 해제를 진행하지 않았습니다.",
                code: "current_device_unavailable");
        var deviceId = PayloadGuid(payload, "deviceId", "등록 PC");
        if (string.Equals(deviceId, _localAgent.DeviceId, StringComparison.OrdinalIgnoreCase))
            throw new VNextDevelopmentException(
                "현재 사용 중인 이 PC는 여기서 등록 해제할 수 없습니다.",
                code: "cannot_revoke_current_device");
        var expectedRevision = PayloadLong(payload, "expectedRevision", 1, long.MaxValue, "장치 변경 버전");
        RequireMutableDeviceSnapshot(deviceId, expectedRevision);
        await RunOperationAsync("등록 PC와 연결 규칙을 안전하게 정리하는 중이에요.", async ownerId =>
        {
            var sessionEpoch = _client.CaptureSessionEpoch();
            var receipt = await _client.RevokeAgentDeviceAsync(deviceId, expectedRevision, _lifetimeToken);
            _lifetimeToken.ThrowIfCancellationRequested();
            if (!CanCommit(ownerId, sessionEpoch)) return;
            await LoadAndPushStateAsync(showToast: false, ownerId);
            if (CanCommit(ownerId, sessionEpoch))
            {
                await ShowToastAsync(
                    receipt.DisabledRuleCount > 0
                        ? $"PC 등록을 해제하고 연결된 활성 규칙 {receipt.DisabledRuleCount}개를 껐어요."
                        : "PC 등록을 해제했어요.",
                    "success");
            }
        });
    }

    private async Task SyncOverlayAssetsAsync()
    {
        RequireCanManage();
        if (_localAgent is null)
            throw new VNextDevelopmentException("이 PC 자동화 실행기를 시작할 수 없습니다.", code: "local_agent_unavailable");
        await RunOperationAsync("오버레이 이미지를 확인하는 중이에요.", async ownerId =>
        {
            var sessionEpoch = _client.CaptureSessionEpoch();
            var result = await _localAgent.SyncOverlayAssetsNowAsync(_lifetimeToken);
            _lifetimeToken.ThrowIfCancellationRequested();
            if (!CanCommit(ownerId, sessionEpoch)) return;
            await LoadAndPushStateAsync(showToast: false, ownerId);
            if (CanCommit(ownerId, sessionEpoch))
            {
                await ShowToastAsync(
                    $"오버레이 이미지 {result.Available}개 준비 완료 · 새로 받음 {result.Downloaded}개 · 캐시 재사용 {result.Reused}개",
                    result.RequiredUnavailable == 0 ? "success" : "warning");
            }
        });
    }

    private async Task PreviewOverlayAssetAsync(JsonElement payload)
    {
        RequireCanManage();
        if (_localAgent is null)
            throw new VNextDevelopmentException("이 PC 자동화 실행기를 시작할 수 없습니다.", code: "local_agent_unavailable");
        var assetId = PayloadGuid(payload, "assetId", "오버레이 이미지");
        if (!_loadedOverlaySnapshot.TryGetValue(assetId, out var asset))
            throw new VNextDevelopmentException(
                "현재 별록에 포함되지 않은 오버레이 이미지입니다. 화면을 새로고침해주세요.",
                code: "overlay_asset_not_loaded");
        await RunOperationAsync("선택한 오버레이 이미지를 3초 동안 미리 보여드릴게요.", async ownerId =>
        {
            var sessionEpoch = _client.CaptureSessionEpoch();
            var completed = await _localAgent.PreviewOverlayAssetAsync(
                assetId,
                asset.ContentSha256,
                3_000,
                _lifetimeToken);
            _lifetimeToken.ThrowIfCancellationRequested();
            if (CanCommit(ownerId, sessionEpoch))
            {
                await ShowToastAsync(
                    completed
                        ? "OBS 화면 미리보기를 마쳤어요."
                        : "실제 자동화가 실행 중이라 미리보기를 양보했어요.",
                    completed ? "success" : "warning");
            }
        });
    }

    private async Task CopyOverlayUrlAsync()
    {
        RequireCanManage();
        if (_localAgent is null)
            throw new VNextDevelopmentException("이 PC 자동화 실행기를 시작할 수 없습니다.", code: "local_agent_unavailable");
        if (!_localAgent.OverlayAvailable)
            throw new VNextDevelopmentException(
                "OBS 브라우저 소스용 로컬 서버가 실행되지 않았습니다. 미리보기를 먼저 시도해주세요.",
                code: "overlay_server_unavailable");
        Clipboard.SetText(_localAgent.OverlayUrl);
        await ShowToastAsync("OBS 브라우저 소스 주소를 복사했어요.", "success");
    }

    private async Task<object> CreateLocalConnectionsStateAsync()
    {
        var obs = _storage.LoadObsSettings();
        var windows = _storage.LoadWindowsCaptureSettings();
        var downVoice = await CreateVoiceAnonymizerPresetStateAsync(
            obs,
            ObsVoiceAnonymizerContract.DownPreset,
            "다운톤",
            obs.VoiceAnonymizerFilterName);
        var upVoice = await CreateVoiceAnonymizerPresetStateAsync(
            obs,
            ObsVoiceAnonymizerContract.UpPreset,
            "업톤",
            obs.VoiceAnonymizerUpFilterName);
        var voiceAnonymizer = new
        {
            filterName = downVoice.FilterName,
            ready = downVoice.Ready,
            filterEnabled = downVoice.FilterEnabled,
            state = downVoice.State,
            message = downVoice.Message,
            presets = new
            {
                anonymous_low = downVoice,
                anonymous_high = upVoice
            }
        };
        IReadOnlyList<WindowsCaptureEndpoint> endpoints;
        try
        {
            endpoints = await Task.Run(CoreAudioCaptureAdapter.ListActiveEndpoints, _lifetimeToken);
        }
        catch (OperationCanceledException) when (_lifetimeToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _storage.Log("Automation microphone enumeration failed: " + ex.GetType().Name);
            endpoints = Array.Empty<WindowsCaptureEndpoint>();
        }

        return new
        {
            obs = new
            {
                enabled = obs.Enabled,
                port = obs.Port,
                inputName = obs.MicrophoneInputName,
                hasPassword = !string.IsNullOrEmpty(obs.Password),
                voiceAnonymizer
            },
            windows = new
            {
                enabled = windows.Enabled,
                endpointId = windows.EndpointId,
                endpointName = windows.EndpointName,
                endpoints = endpoints.Select(endpoint => new
                {
                    id = endpoint.Id,
                    name = endpoint.FriendlyName,
                    isDefault = endpoint.IsDefault
                })
            }
        };
    }

    private async Task<VoiceAnonymizerPresetState> CreateVoiceAnonymizerPresetStateAsync(
        ObsConnectionSettings obs,
        string preset,
        string label,
        string filterName)
    {
        if (!obs.Enabled)
            return new(preset, label, filterName, false, null, "obs_disabled", "OBS 연결을 먼저 사용으로 설정해주세요.");
        if (string.IsNullOrWhiteSpace(obs.MicrophoneInputName) || string.IsNullOrWhiteSpace(filterName))
            return new(preset, label, filterName, false, null, "not_ready", $"{label} 필터 이름과 OBS 마이크를 설정해주세요.");
        if (_localAgent is null)
            return new(preset, label, filterName, false, null, "not_ready", "이 PC 자동화 실행기를 확인할 수 없습니다.");

        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(_lifetimeToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(4));
            var status = await _localAgent.ProbeVoiceAnonymizerAsync(preset, timeout.Token);
            return new(
                preset,
                label,
                status.FilterName,
                status.Ready,
                status.FilterEnabled,
                status.FilterEnabled ? "ready_enabled" : "ready",
                status.FilterEnabled
                    ? $"{label} VST 2.x 필터가 현재 켜져 있습니다. 평소에는 꺼두는 것을 권장합니다."
                    : $"{label} VST 2.x 필터가 준비되어 있습니다.");
        }
        catch (OperationCanceledException) when (_lifetimeToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _storage.Log($"Voice anonymizer readiness probe failed: preset={preset} type={ex.GetType().Name}");
            return new(preset, label, filterName, false, null, "not_ready", VoiceAnonymizerSetupMessage(ex));
        }
    }

    private async Task PushLocalConnectionsAsync(long ownerId, bool showToast)
    {
        var sessionEpoch = _client.CaptureSessionEpoch();
        var localConnections = await CreateLocalConnectionsStateAsync();
        if (!CanCommit(ownerId, sessionEpoch)) return;
        await ExecuteAsync(
            "window.byeollogAutomation.setState(" +
            JsonSerializer.Serialize(new { localConnections, lastUpdatedAt = DateTimeOffset.UtcNow }) +
            ");");
        if (showToast && CanCommit(ownerId, sessionEpoch))
            await ShowToastAsync("이 PC의 마이크 장치 목록을 새로고침했어요.", "success");
    }

    private async Task SaveObsSettingsAsync(JsonElement payload)
    {
        var settings = ParseObsSettings(payload, keepStoredPasswordWhenBlank: true);
        await RunOperationAsync("OBS 연결 설정을 저장하는 중이에요.", async ownerId =>
        {
            _storage.SaveObsSettings(settings);
            _localAgent?.Wake();
            await PushLocalConnectionsAsync(ownerId, showToast: false);
            if (IsOperationCurrent(ownerId))
                await ShowToastAsync("OBS 연결 설정을 저장했어요. 이제 연결 확인을 눌러 점검할 수 있어요.", "success");
        });
    }

    private async Task TestObsSettingsAsync(JsonElement payload)
    {
        var settings = ParseObsSettings(payload, keepStoredPasswordWhenBlank: true) with { Enabled = true };
        await RunOperationAsync("OBS와 마이크 입력을 확인하는 중이에요.", async ownerId =>
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(_lifetimeToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(7));
            await using var obs = await ObsWebSocketClient.ConnectAsync(settings, timeout.Token);
            var info = await obs.GetVersionAsync(timeout.Token);
            if (!info.AvailableRequests.Contains("GetInputMute") || !info.AvailableRequests.Contains("SetInputMute"))
                throw new InvalidOperationException("연결된 OBS가 필요한 마이크 제어 기능을 지원하지 않습니다.");
            var muted = await obs.GetInputMuteAsync(settings.MicrophoneInputName, timeout.Token);
            if (IsOperationCurrent(ownerId))
                await ShowToastAsync($"OBS 연결 완료 · 현재 마이크 {(muted ? "음소거" : "사용 중")}", "success");
        });
    }

    private async Task TestVoiceAnonymizerFilterAsync(JsonElement payload)
    {
        var savedSettings = ParseObsSettings(payload, keepStoredPasswordWhenBlank: true);
        var preset = PayloadVoicePreset(payload);
        var presetLabel = preset == ObsVoiceAnonymizerContract.UpPreset ? "업톤" : "다운톤";
        var selectedFilterName = preset == ObsVoiceAnonymizerContract.UpPreset
            ? savedSettings.VoiceAnonymizerUpFilterName
            : savedSettings.VoiceAnonymizerFilterName;
        if (string.IsNullOrWhiteSpace(savedSettings.MicrophoneInputName))
            throw new VNextDevelopmentException(
                "OBS 오디오 믹서에 표시되는 마이크 입력 이름을 입력해주세요.",
                code: "invalid_obs_input");
        var settings = savedSettings with { Enabled = true };
        await RunOperationAsync("OBS 신원보호 필터를 확인하는 중이에요.", async ownerId =>
        {
            try
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(_lifetimeToken);
                timeout.CancelAfter(TimeSpan.FromSeconds(7));
                await using var obs = await ObsWebSocketClient.ConnectAsync(settings, timeout.Token);
                var info = await obs.GetVersionAsync(timeout.Token);
                if (!info.AvailableRequests.Contains("GetSourceFilterList")
                    || !info.AvailableRequests.Contains("GetSourceFilter")
                    || !info.AvailableRequests.Contains("SetSourceFilterEnabled"))
                    throw new InvalidOperationException("연결된 OBS가 필요한 필터 제어 기능을 지원하지 않습니다.");
                var filters = await obs.GetSourceFilterListAsync(settings.MicrophoneInputName, timeout.Token);
                var filter = filters.FirstOrDefault(item =>
                    string.Equals(
                        item.FilterName,
                        selectedFilterName,
                        StringComparison.Ordinal));
                if (filter is null)
                    throw new InvalidOperationException(
                        $"OBS 마이크에 '{selectedFilterName}' 필터가 없습니다.");
                if (!string.Equals(
                        filter.FilterKind,
                        TimedMuteActionAdapter.VoiceAnonymizerFilterKind,
                        StringComparison.Ordinal))
                    throw new InvalidOperationException(
                        $"'{selectedFilterName}' 필터가 VST 2.x 플러그인 필터가 아닙니다.");
                // A successful filter check pins the exact tested local settings so
                // the five-second preview and production action cannot target a stale filter.
                _storage.SaveObsSettings(settings);
                _localAgent?.Wake();
                if (IsOperationCurrent(ownerId))
                {
                    await PushLocalConnectionsAsync(ownerId, showToast: false);
                    await ShowToastAsync(
                        filter.FilterEnabled
                            ? $"{presetLabel} 필터 확인·저장 완료 · 현재 켜짐 (평소에는 꺼두세요)"
                            : $"{presetLabel} 필터 확인·저장 완료 · 현재 꺼짐",
                        filter.FilterEnabled ? "warning" : "success");
                }
            }
            catch (OperationCanceledException) when (_lifetimeToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                throw new VNextDevelopmentException(
                    VoiceAnonymizerSetupMessage(ex),
                    code: "voice_anonymizer_not_ready");
            }
        });
    }

    private async Task PreviewVoiceAnonymizerAsync(JsonElement payload)
    {
        RequireCanManage();
        var preset = PayloadVoicePreset(payload);
        var presetLabel = preset == ObsVoiceAnonymizerContract.UpPreset ? "업톤" : "다운톤";
        if (_localAgent is null)
            throw new VNextDevelopmentException(
                "이 PC 자동화 실행기를 시작할 수 없습니다.",
                code: "local_agent_unavailable");
        await RunOperationAsync($"{presetLabel} 신원보호 목소리를 5초 동안 미리 듣는 중이에요.", async ownerId =>
        {
            try
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(_lifetimeToken);
                timeout.CancelAfter(TimeSpan.FromSeconds(20));
                var result = await _localAgent.PreviewVoiceAnonymizerAsync(preset, timeout.Token);
                if (IsOperationCurrent(ownerId))
                {
                    await PushLocalConnectionsAsync(ownerId, showToast: false);
                    if (IsOperationCurrent(ownerId))
                    {
                        await ShowToastAsync(
                            result.InitialMuted
                                ? $"{presetLabel} 5초 미리보기를 마쳤어요. 필터가 이미 켜져 있어 상태를 그대로 유지했어요."
                                : $"{presetLabel} 5초 신원보호 목소리 미리보기를 마쳤어요. 필터를 원래대로 껐어요.",
                            result.InitialMuted ? "warning" : "success");
                    }
                }
            }
            catch (OperationCanceledException) when (_lifetimeToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                throw new VNextDevelopmentException(
                    VoiceAnonymizerSetupMessage(ex),
                    code: "voice_anonymizer_preview_failed");
            }
        });
    }

    private async Task SaveWindowsMicSettingsAsync(JsonElement payload)
    {
        var enabled = PayloadBoolean(payload, "enabled", "Windows 마이크 사용 여부");
        var endpointId = PayloadOptionalText(payload, "endpointId", 512);
        var endpoints = await Task.Run(CoreAudioCaptureAdapter.ListActiveEndpoints, _lifetimeToken);
        var endpoint = endpoints.FirstOrDefault(item => string.Equals(item.Id, endpointId, StringComparison.Ordinal));
        if (enabled && endpoint is null)
            throw new VNextDevelopmentException("사용할 Windows 마이크 장치를 선택해주세요.", code: "invalid_microphone_device");
        await RunOperationAsync("Windows 마이크 장치를 저장하는 중이에요.", async ownerId =>
        {
            _storage.SaveWindowsCaptureSettings(new WindowsCaptureSettings(enabled, endpoint?.Id ?? "", endpoint?.FriendlyName ?? ""));
            _localAgent?.Wake();
            await PushLocalConnectionsAsync(ownerId, showToast: false);
            if (IsOperationCurrent(ownerId))
                await ShowToastAsync("Windows 마이크 장치 설정을 저장했어요.", "success");
        });
    }

    private async Task TestWindowsMicSettingsAsync(JsonElement payload)
    {
        var endpointId = PayloadOptionalText(payload, "endpointId", 512);
        if (string.IsNullOrWhiteSpace(endpointId))
            throw new VNextDevelopmentException("상태를 확인할 Windows 마이크 장치를 선택해주세요.", code: "invalid_microphone_device");
        await RunOperationAsync("선택한 마이크 상태를 읽는 중이에요.", async ownerId =>
        {
            var muted = await Task.Run(() => CoreAudioCaptureAdapter.GetMute(endpointId, _lifetimeToken), _lifetimeToken);
            if (IsOperationCurrent(ownerId))
                await ShowToastAsync($"장치 확인 완료 · 현재 Windows 음소거 {(muted ? "켜짐" : "꺼짐")}", "success");
        });
    }

    private ObsConnectionSettings ParseObsSettings(JsonElement payload, bool keepStoredPasswordWhenBlank)
    {
        var enabled = PayloadBoolean(payload, "enabled", "OBS 연결 사용 여부");
        var port = PayloadInt(payload, "port", 1, 65535, "OBS 포트");
        var inputName = PayloadOptionalText(payload, "inputName", 128);
        var filterName = PayloadOptionalText(payload, "voiceAnonymizerFilterName", 128);
        var upFilterName = PayloadOptionalText(payload, "voiceAnonymizerUpFilterName", 128);
        var password = PayloadOptionalText(payload, "password", 256, trim: false);
        if (enabled && string.IsNullOrWhiteSpace(inputName))
            throw new VNextDevelopmentException("OBS 오디오 믹서에 표시되는 마이크 입력 이름을 입력해주세요.", code: "invalid_obs_input");
        if (keepStoredPasswordWhenBlank && password.Length == 0)
            password = _storage.LoadObsSettings().Password;
        if (filterName.Length == 0)
            filterName = _storage.LoadObsSettings().VoiceAnonymizerFilterName;
        if (filterName.Length == 0)
            filterName = ObsConnectionSettings.DefaultVoiceAnonymizerFilterName;
        if (upFilterName.Length == 0)
            upFilterName = _storage.LoadObsSettings().VoiceAnonymizerUpFilterName;
        if (upFilterName.Length == 0)
            upFilterName = ObsConnectionSettings.DefaultVoiceAnonymizerUpFilterName;
        return new ObsConnectionSettings(enabled, port, inputName.Trim(), password, filterName, upFilterName);
    }

    private static string PayloadVoicePreset(JsonElement payload)
    {
        var preset = PayloadOptionalText(payload, "preset", 32);
        if (!ObsVoiceAnonymizerContract.IsSupportedPreset(preset))
            throw new VNextDevelopmentException("다운톤 또는 업톤을 선택해주세요.", code: "invalid_voice_preset");
        return preset;
    }

    private static string VoiceAnonymizerSetupMessage(Exception ex) => ex switch
    {
        ObsAuthenticationException => "OBS WebSocket 인증에 실패했습니다. 비밀번호를 확인해주세요.",
        ObsProtocolException => "OBS WebSocket 5.x 연결을 확인해주세요.",
        ObsRequestException => "설정한 OBS 마이크 입력 또는 신원보호 필터를 찾지 못했습니다.",
        WebSocketException or IOException or HttpRequestException or TimeoutException =>
            "OBS에 연결할 수 없습니다. OBS 실행 및 WebSocket 설정을 확인해주세요.",
        OperationCanceledException => "OBS 신원보호 필터 확인 시간이 초과되었습니다.",
        InvalidOperationException invalid => invalid.Message,
        TimedMuteRestoreFailedException =>
            "필터 원상복구를 확인하지 못했습니다. OBS에서 신원보호 필터를 직접 꺼주세요.",
        _ => "OBS 신원보호 필터를 확인하지 못했습니다. 마이크와 필터 설정을 확인해주세요."
    };

    private async Task<object> CreateLocalAgentStateAsync()
    {
        if (_localAgent is null)
            return new { available = false, currentDeviceId = (string?)null, error = "이 PC 자동화 실행기를 시작할 수 없습니다." };
        try
        {
            var overlay = await _localAgent.CreateOverlayDiagnosticsAsync(_lifetimeToken);
            var status = _localAgent.Status;
            return new
            {
                available = true,
                currentDeviceId = _localAgent.DeviceId,
                overlayUrl = _localAgent.OverlayUrl,
                overlayRunning = overlay.OverlayRunning,
                requiredAssetsReady = overlay.Cache.RequiredReady,
                exactAssetsReady = overlay.ReadyRevisions.Count,
                builtInAssetExact = overlay.BuiltInAssetExact,
                managedAssets = overlay.Cache.ManagedCount,
                managedBytes = overlay.Cache.ManagedBytes,
                manifestGeneratedAt = overlay.Cache.ManifestGeneratedAt,
                readyAssets = overlay.ReadyRevisions.Select(item => new
                {
                    assetId = item.AssetId,
                    contentSha256 = item.ContentSha256
                }),
                connected = status.Connected,
                state = status.State
            };
        }
        catch (OperationCanceledException) when (IsClosing || _lifetimeToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _storage.Log("Automation local Agent snapshot failed: " + ex.GetType().Name);
            return new
            {
                available = true,
                currentDeviceId = _localAgent.DeviceId,
                overlayUrl = _localAgent.OverlayUrl,
                overlayRunning = _localAgent.OverlayAvailable,
                error = "이 PC의 상세 준비 상태를 확인하지 못했습니다."
            };
        }
    }

    private static string PayloadGuid(JsonElement payload, string property, string label)
    {
        if (payload.ValueKind != JsonValueKind.Object
            || !payload.TryGetProperty(property, out var value)
            || value.ValueKind != JsonValueKind.String
            || !Guid.TryParseExact(value.GetString()?.Trim(), "D", out var parsed))
            throw new VNextDevelopmentException($"{label}을 확인해주세요.", code: "invalid_device_payload");
        return parsed.ToString("D");
    }

    private static long PayloadLong(
        JsonElement payload,
        string property,
        long minimum,
        long maximum,
        string label)
    {
        if (payload.ValueKind != JsonValueKind.Object
            || !payload.TryGetProperty(property, out var value)
            || !value.TryGetInt64(out var number)
            || number < minimum
            || number > maximum)
            throw new VNextDevelopmentException($"{label}을 확인해주세요.", code: "invalid_device_payload");
        return number;
    }

    private static int PayloadInt(
        JsonElement payload,
        string property,
        int minimum,
        int maximum,
        string label)
    {
        if (payload.ValueKind != JsonValueKind.Object
            || !payload.TryGetProperty(property, out var value)
            || !value.TryGetInt32(out var number)
            || number < minimum
            || number > maximum)
            throw new VNextDevelopmentException($"{label}을 확인해주세요.", code: "invalid_local_settings");
        return number;
    }

    private static bool PayloadBoolean(JsonElement payload, string property, string label)
    {
        if (payload.ValueKind != JsonValueKind.Object
            || !payload.TryGetProperty(property, out var value)
            || value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            throw new VNextDevelopmentException($"{label}을 확인해주세요.", code: "invalid_local_settings");
        return value.GetBoolean();
    }

    private static string PayloadOptionalText(
        JsonElement payload,
        string property,
        int maximum,
        bool trim = true)
    {
        if (payload.ValueKind != JsonValueKind.Object
            || !payload.TryGetProperty(property, out var value)
            || value.ValueKind != JsonValueKind.String)
            throw new VNextDevelopmentException("입력한 설정값을 확인해주세요.", code: "invalid_local_settings");
        var text = value.GetString() ?? "";
        if (trim) text = text.Trim();
        if (text.Length > maximum || text.Any(char.IsControl))
            throw new VNextDevelopmentException("입력한 설정값이 너무 길거나 올바르지 않습니다.", code: "invalid_local_settings");
        return text;
    }

    private static string PayloadText(
        JsonElement payload,
        string property,
        string label,
        int minimum,
        int maximum)
    {
        if (payload.ValueKind != JsonValueKind.Object
            || !payload.TryGetProperty(property, out var value)
            || value.ValueKind != JsonValueKind.String)
            throw new VNextDevelopmentException($"{label}을 확인해주세요.", code: "invalid_device_payload");
        var text = value.GetString()?.Trim() ?? "";
        if (text.Length < minimum || text.Length > maximum || text.Any(char.IsControl))
            throw new VNextDevelopmentException($"{label}은 {minimum}~{maximum}자로 입력해주세요.", code: "invalid_device_payload");
        return text;
    }

    private VNextAutomationDeviceView RequireMutableDeviceSnapshot(
        string deviceId,
        long expectedRevision)
    {
        if (!_loadedDeviceSnapshot.TryGetValue(deviceId, out var device))
            throw new VNextDevelopmentException(
                "마지막으로 불러온 등록 PC 목록에 없는 장치입니다. 목록을 새로고침해주세요.",
                code: "device_not_loaded");
        if (device.RevokedAt.HasValue
            || string.Equals(device.ConnectionState, "revoked", StringComparison.Ordinal))
            throw new VNextDevelopmentException(
                "이미 등록 해제된 PC는 변경할 수 없습니다.",
                code: "device_already_revoked");
        if (device.ManagementRevision != expectedRevision)
            throw new VNextDevelopmentException(
                "PC 정보가 이미 변경되었습니다. 목록을 새로고침한 뒤 다시 시도해주세요.",
                code: "stale_device_snapshot");
        return device;
    }

    // 기존 내부 호출/계약 표면을 유지하는 편의 overload입니다. 새 비동기 경로는
    // 캡처한 세대를 명시적으로 전달해 늦은 401이 새 세션을 덮지 않게 합니다.
    private async Task SetSessionExpiredAsync() =>
        await SetSessionExpiredAsync(_client.CaptureSessionEpoch());

    private void RequireCanManage()
    {
        if (_canManage && _client.IsSessionEpochCurrent(_openedSessionEpoch)) return;
        throw new VNextDevelopmentException(
            "현재 별록 계정의 워크스페이스 연결을 다시 확인해주세요.",
            403,
            "workspace_management_required");
    }

    private bool IsBusy => Volatile.Read(ref _busyOperationOwnerId) != 0;

    private bool IsOperationCurrent(long ownerId) =>
        ownerId != 0 && Volatile.Read(ref _busyOperationOwnerId) == ownerId;

    private bool CanCommit(long ownerId, long sessionEpoch) =>
        !IsClosing &&
        IsOperationCurrent(ownerId) &&
        _client.IsSessionEpochCurrent(sessionEpoch);

    private async Task RunOperationAsync(string message, Func<long, Task> operation)
    {
        var ownerId = Interlocked.Increment(ref _nextOperationOwnerId);
        Interlocked.Exchange(ref _busyOperationOwnerId, ownerId);
        try
        {
            await PushBusyAsync(ownerId, true, message);
            await operation(ownerId);
        }
        finally
        {
            await CompleteOperationAsync(ownerId);
        }
    }

    private Task UpdateOperationAsync(long ownerId, string message) =>
        IsOperationCurrent(ownerId)
            ? PushBusyAsync(ownerId, true, message)
            : Task.CompletedTask;

    private async Task CompleteOperationAsync(long ownerId)
    {
        if (!IsOperationCurrent(ownerId)) return;
        try
        {
            if (!IsClosing) await PushBusyAsync(ownerId, false, "");
        }
        finally
        {
            Interlocked.CompareExchange(ref _busyOperationOwnerId, 0, ownerId);
        }
    }

    private Task PushBusyAsync(long ownerId, bool busy, string message)
    {
        if (IsClosing) return Task.CompletedTask;
        var state = JsonSerializer.Serialize(new { busy, message, ownerId });
        return ExecuteAsync("window.byeollogAutomation.setBusy(" + state + ");");
    }

    private async Task SetSessionExpiredAsync(long expectedEpoch)
    {
        if (_client.IsSignedIn || _client.SessionEpoch != expectedEpoch) return;
        _canManage = false;
        _readinessReport = null;
        _readinessReportEpoch = 0;
        _loadedDeviceSnapshot =
            new Dictionary<string, VNextAutomationDeviceView>(StringComparer.OrdinalIgnoreCase);
        _loadedOverlaySnapshot =
            new Dictionary<string, VNextAutomationOverlayAssetView>(StringComparer.OrdinalIgnoreCase);
        if (_client.IsSignedIn || _client.SessionEpoch != expectedEpoch) return;
        await ExecuteAsync("window.byeollogAutomation.setState({connected:false,canManage:false,sessionExpired:true,rules:[],agentDevices:[],overlayAssets:[],assetReadiness:[],activity:{items:[],saturated:false},readiness:{requirements:[],checks:[],overallState:'unavailable',canEvaluate:false},localAgent:{available:false}});");
        if (!_client.IsSignedIn && _client.SessionEpoch == expectedEpoch)
            await ShowToastAsync("뉴별록 연결이 만료됐어요. 트레이 메뉴에서 다시 연결해주세요.", "error");
    }

    private Task ShowToastAsync(string message, string tone) =>
        ExecuteAsync("window.byeollogAutomation.showToast(" + JsonSerializer.Serialize(message) + "," + JsonSerializer.Serialize(tone) + ");");

    private async Task ExecuteAsync(string script)
    {
        if (!_ready || IsClosing || _web.IsDisposed || _web.CoreWebView2 is null) return;
        try { await _web.ExecuteScriptAsync(script); }
        catch (Exception ex) when (IsClosing &&
            (ex.HResult == EAbortHResult || ex is InvalidOperationException or ObjectDisposedException)) { }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            MarkClosing();
            if (_core is not null)
            {
                _core.NavigationStarting -= Core_NavigationStarting;
                _core.FrameNavigationStarting -= Core_FrameNavigationStarting;
                _core.NewWindowRequested -= Core_NewWindowRequested;
                _core.PermissionRequested -= Core_PermissionRequested;
                _core.DownloadStarting -= Core_DownloadStarting;
                _core.WebMessageReceived -= Core_WebMessageReceived;
                _core = null;
            }
            Shown -= VNextAutomationSettingsForm_Shown;
            FormClosing -= VNextAutomationSettingsForm_FormClosing;
            _client.SessionChanged -= Client_SessionChanged;
            _lifetime.Dispose();
        }
        base.Dispose(disposing);
    }
}
