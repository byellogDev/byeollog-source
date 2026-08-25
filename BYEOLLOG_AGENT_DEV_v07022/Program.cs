using System.Diagnostics;
using System.Threading;

namespace HurogiCollector;

internal static class Program
{
    private const string CollectorBuildVersion = BuildInfo.InformationalVersion;
    private const string MutexName = @"Local\ByeollogCollector.BetaLoginGate.v0449";
    private const string ActivateEventName = @"Local\ByeollogCollector.BetaLoginGate.Activate.v0449";

    [STAThread]
    static void Main(string[] args)
    {
        if (args.Length == 1 && string.Equals(args[0], "--update-check", StringComparison.Ordinal))
        {
            Environment.ExitCode = AgentUpdateRunner.RunAsync(BuildInfo.Version).GetAwaiter().GetResult();
            return;
        }

        if (args.Length == 2 && string.Equals(args[0], "--update-preflight", StringComparison.Ordinal))
        {
            Environment.ExitCode = AgentUpdatePreflight.Run(BuildInfo.Version, args[1]);
            return;
        }

        if (args.Length == 2 && string.Equals(args[0], "--continue-after-update", StringComparison.Ordinal))
        {
            if (!int.TryParse(args[1], out var previousProcessId) ||
                previousProcessId <= 0 ||
                !WaitForPreviousProcessExit(previousProcessId))
            {
                return;
            }
            args = Array.Empty<string>();
        }

        if (args.Length == 1 && string.Equals(args[0], "--replay-candidate-check", StringComparison.Ordinal))
        {
            Environment.ExitCode = RunReplayCandidateCheck();
            return;
        }

        // 로그인에 걸린 시간과 무관하게 새 수집의 기본 시각은
        // 사용자가 프로그램을 실행한 바로 이 순간으로 고정합니다.
        var programStartedAtLocal = DateTime.Now;
        ApplicationConfiguration.Initialize();

        var isCurrentManagedProcess = false;
        try
        {
            // 관리형 바로가기는 특정 버전 EXE를 직접 가리킵니다. 업데이트로
            // current.json이 바뀐 경우 검증된 현재 버전으로 조용히 넘깁니다.
            if (!ManagedInstallLaunchBridge.ContinueCurrentProcessOrRelaunch(out isCurrentManagedProcess)) return;
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "별록 설치 상태를 안전하게 확인하지 못했습니다.\n\n" + ex.Message,
                BuildInfo.ProductName,
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return;
        }

        using var mutex = new Mutex(initiallyOwned: true, name: MutexName, createdNew: out bool isFirstInstance);
        using var activateEvent = new EventWaitHandle(false, EventResetMode.AutoReset, ActivateEventName);

        if (!isFirstInstance)
        {
            try { activateEvent.Set(); } catch { }
            MessageBox.Show(
                "별록 에이전트가 이미 실행 중입니다.\n작업 표시줄 또는 트레이의 별록 창을 확인해주세요.",
                BuildInfo.ProductName,
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
            return;
        }

        string? startupLog = null;
        CollectorStorage? storage = null;
        VNextDevelopmentClient? vNextDevClient = null;
        MainForm? mainForm = null;
        var startupCompleted = false;
        var startupStarted = false;
        using var stopWatcher = new CancellationTokenSource();
        Task activationWatcher = Task.CompletedTask;

        using (var splash = new StartupLoadingForm())
        {
            using var applicationContext = new ApplicationContext(splash);
            splash.Shown += async (_, _) =>
            {
                if (startupStarted) return;
                startupStarted = true;
                try
                {
                    await Task.Yield();
                    if (isCurrentManagedProcess)
                    {
                        splash.SetStage("새 버전을 확인하는 중", "업데이트가 있으면 지금 적용한 뒤 최신 별록으로 바로 시작합니다.");
                        var updateInstalled = await RunUpdateCheckBeforeStartupAsync(splash.CancellationToken);
                        if (updateInstalled && ManagedInstallLaunchBridge.StartCurrentAfterProcessExit(Environment.ProcessId))
                        {
                            splash.CompleteAndClose();
                            return;
                        }
                    }
                    splash.CancellationToken.ThrowIfCancellationRequested();
                    splash.SetStage("내 설정을 안전하게 확인하는 중", "기존 로그인과 방송 설정은 그대로 유지됩니다.");

                    var dataRootPreparation = AgentDataPaths.PrepareDataRoot();
                    startupLog = Path.Combine(dataRootPreparation.RootPath, "startup_trace.txt");
                    TryAppendStartupLog(
                        startupLog,
                        $"startup begin data_root={AgentDataPaths.CurrentDirectoryName} " +
                        $"migrated={dataRootPreparation.MigratedFromLegacy} " +
                        $"legacy_retained={dataRootPreparation.LegacyBackupRetained}");

                    var statePreparation = CollectorStateLifecycle.Prepare(
                        dataRootPreparation.RootPath,
                        CollectorBuildVersion);
                    TryAppendStartupLog(
                        startupLog,
                        $"state schema={statePreparation.SchemaVersion} " +
                        $"snapshot_created={statePreparation.SnapshotCreated} " +
                        $"restored={statePreparation.RestoredFiles.Count}");

                    if (statePreparation.RestoredFiles.Count > 0)
                    {
                        MessageBox.Show(
                            splash,
                            "중단된 저장으로 손상된 설정을 안전한 직전 사본에서 복구했습니다.\n\n" +
                            string.Join("\n", statePreparation.RestoredFiles.Select(name => "- " + name)) +
                            "\n\n손상 원본은 삭제하지 않고 .corrupt 파일로 보존했습니다.",
                            "별록 에이전트 · 설정 자동 복구",
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Warning);
                    }

                    splash.CancellationToken.ThrowIfCancellationRequested();
                    storage = new CollectorStorage();
                    storage.LoadState();
                    TryAppendStartupLog(startupLog, "storage loaded");
                    ManagedInstallLaunchBridge.RepairCurrentShortcuts(storage.Log);

                    // 저장된 device_token은 서버 업로드 인증용으로만 유지합니다.
                    // 별록 액션은 비밀번호 없이 DPAPI refresh token으로 먼저 복구를
                    // 시도합니다. 이 작업은 기존 Collector 로그인 준비를 막지 않습니다.
                    vNextDevClient = new VNextDevelopmentClient(storage.RootPath);
                    try
                    {
                        _ = vNextDevClient.BeginRememberedSessionRestore();
                    }
                    catch (Exception ex)
                    {
                        storage.Log("방송 자동화 자동연결 복구 시작 보류: " + ex.GetType().Name);
                    }

                    // WebView2가 같은 파일을 동시에 추출하지 않도록 로컬 UI 자산을
                    // 먼저 한 번 준비한 뒤 로그인과 메인 컨트롤을 병렬로 예열합니다.
                    UiAssetStore.Prepare();
                    splash.SetStage("별록 화면을 미리 준비하는 중", "로그인 후 기다리지 않도록 화면과 리소스를 지금 불러옵니다.");

                    mainForm = new MainForm(storage, programStartedAtLocal, vNextDevClient);
                    using var login = new CollectorLoginWebForm(storage, vNextDevClient);
                    login.PrepareMainWindowBeforeCloseAsync = mainForm.RefreshPreparedMainStateAsync;

                    var mainPreparation = mainForm.PrepareForDisplayAsync();
                    var loginPreparation = login.PrepareForDisplayAsync();
                    await Task.WhenAll(mainPreparation, loginPreparation);
                    splash.SetStage("방송 연결을 미리 준비하는 중", "로그인 후 바로 사용할 위플랩 수집 화면을 준비합니다.");
                    await mainForm.PrepareCollectorWebViewBeforeLoginAsync();
                    splash.CancellationToken.ThrowIfCancellationRequested();
                    TryAppendStartupLog(startupLog, "login, main UI, and collector WebView preloaded");

                    splash.SetStage("준비 완료", "로그인 화면을 열고 있습니다.");
                    await Task.Delay(80, splash.CancellationToken);
                    splash.Hide();

                    if (login.ShowDialog() != DialogResult.OK)
                    {
                        try { mainForm.Dispose(); } catch { }
                        mainForm = null;
                        splash.CompleteAndClose();
                        return;
                    }

                    mainForm.StartPosition = FormStartPosition.Manual;
                    mainForm.Location = login.Location;
                    mainForm.PreserveCurrentLocationOnFirstShow();
                    mainForm.Show();
                    if (mainForm.IsDisposed)
                        throw new ObjectDisposedException(nameof(MainForm), "준비된 별록 창이 표시 전에 종료되었습니다.");

                    // 하나의 WinForms 메시지 루프 안에서 주 창을 로딩 화면에서
                    // 준비된 메인 창으로 교체합니다. 첫 Application.Run을 끝낸 뒤
                    // 같은 폼으로 두 번째 루프를 시작하면 Windows가 메인 창을
                    // 이미 Dispose한 상태일 수 있습니다.
                    applicationContext.MainForm = mainForm;
                    activationWatcher = StartActivationWatcher(
                        mainForm,
                        activateEvent,
                        stopWatcher.Token);
                    TryAppendStartupLog(startupLog, "preloaded main form shown");
                    startupCompleted = true;
                    splash.CompleteAndClose();
                }
                catch (OperationCanceledException)
                {
                    try { mainForm?.Dispose(); } catch { }
                    mainForm = null;
                    splash.CompleteAndClose();
                }
                catch (Exception ex)
                {
                    try { mainForm?.Dispose(); } catch { }
                    mainForm = null;
                    var root = storage?.RootPath ?? AgentDataPaths.PrepareDataRoot().RootPath;
                    var errorPath = Path.Combine(root, "startup_prepare_error.txt");
                    try { File.WriteAllText(errorPath, ex.ToString()); } catch { }
                    TryAppendStartupLog(startupLog, "STARTUP PREPARE ERROR: " + ex.GetType().Name);
                    MessageBox.Show(
                        splash,
                        "별록 시작 화면을 준비하지 못했습니다.\n\n" + ex.Message +
                        "\n\n오류 기록: " + errorPath,
                        BuildInfo.ProductName,
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error);
                    splash.CompleteAndClose();
                }
            };
            Application.Run(applicationContext);
        }

        stopWatcher.Cancel();
        try { activateEvent.Set(); } catch { }
        try { activationWatcher.Wait(1000); } catch { }
        try { mainForm?.Dispose(); } catch { }
        if (startupCompleted && vNextDevClient is not null)
        {
            try { vNextDevClient.ShutdownAsync().Wait(TimeSpan.FromSeconds(3)); } catch { }
        }
        try { vNextDevClient?.Dispose(); } catch { }
        try { mutex.ReleaseMutex(); } catch { }
    }

    private static Task StartActivationWatcher(
        MainForm mainForm,
        EventWaitHandle activateEvent,
        CancellationToken cancellationToken)
    {
        return Task.Run(() =>
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                try
                {
                    if (!activateEvent.WaitOne(500)) continue;
                    if (mainForm.IsDisposed) break;

                    try
                    {
                        mainForm.BeginInvoke(new Action(mainForm.RestoreFromExternalLaunch));
                    }
                    catch (InvalidOperationException)
                    {
                        // 폼 생성/종료 경계에서는 무시
                    }
                }
                catch (ObjectDisposedException)
                {
                    break;
                }
            }
        }, cancellationToken);
    }

    private static void TryAppendStartupLog(string? path, string message)
    {
        if (string.IsNullOrWhiteSpace(path)) return;
        try
        {
            File.AppendAllText(
                path,
                $"[{DateTimeOffset.Now:O}] {message}{Environment.NewLine}");
        }
        catch
        {
            // 진단 로그 I/O는 화면 전환과 앱 실행을 막지 않습니다.
        }
    }

    private static async Task<bool> RunUpdateCheckBeforeStartupAsync(CancellationToken cancellationToken)
    {
        try
        {
            var executable = Environment.ProcessPath ?? Application.ExecutablePath;
            var start = new ProcessStartInfo
            {
                FileName = executable,
                WorkingDirectory = AppContext.BaseDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            start.ArgumentList.Add("--update-check");
            using var process = Process.Start(start);
            if (process is null) return false;
            await process.WaitForExitAsync(cancellationToken);
            return process.ExitCode == AgentUpdateRunner.UpdateInstalledExitCode;
        }
        catch
        {
            // 업데이트 확인 실패는 검증된 현재 별록 화면을 막지 않습니다.
            return false;
        }
    }

    private static bool WaitForPreviousProcessExit(int processId)
    {
        try
        {
            using var process = Process.GetProcessById(processId);
            return process.WaitForExit(30_000);
        }
        catch (ArgumentException)
        {
            // The previous process already exited before this process opened it.
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static int RunReplayCandidateCheck()
    {
        try
        {
            var report = CollectorReplayAcceptance.EvaluateBuiltInCandidate();
            var dataRoot = AgentDataPaths.PrepareDataRoot().RootPath;
            var resultRoot = Path.Combine(
                dataRoot,
                "tester-results",
                "v070_RC2");
            Directory.CreateDirectory(resultRoot);
            var resultPath = Path.Combine(
                resultRoot,
                $"REPLAY_CANDIDATE_v070_RC2-{DateTimeOffset.UtcNow:yyyyMMdd-HHmmss-fff}.json");
            var temporary = resultPath + ".tmp-" + Guid.NewGuid().ToString("N");
            var value = new
            {
                schemaVersion = 1,
                collectorVersion = BuildInfo.Version,
                generatedAtUtc = DateTimeOffset.UtcNow,
                report.Overall,
                report.LiveEventUsed,
                report.RecordedSuccess,
                report.RecordedSuccessExecutions,
                report.DuplicateDeliveryBlocked,
                report.RestoreFailure,
                report.UnknownFieldRejected
            };
            try
            {
                File.WriteAllText(temporary, System.Text.Json.JsonSerializer.Serialize(value, new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
                File.Move(temporary, resultPath, overwrite: false);
            }
            finally
            {
                try { if (File.Exists(temporary)) File.Delete(temporary); } catch { }
            }
            return report.Overall == "pass" ? 0 : 2;
        }
        catch
        {
            return 1;
        }
    }
}
