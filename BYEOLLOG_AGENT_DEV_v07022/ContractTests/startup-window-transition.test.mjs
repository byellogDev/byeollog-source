import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (name) => readFile(new URL(name, root), "utf8");

const ordered = (text, fragments, message) => {
  let cursor = -1;
  for (const fragment of fragments) {
    const next = text.indexOf(fragment, cursor + 1);
    assert.ok(next > cursor, `${message}: missing or out of order: ${fragment}`);
    cursor = next;
  }
};

const section = (text, startMarker, endMarker) => {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing section: ${startMarker}`);
  assert.ok(end > start, `missing section end: ${endMarker}`);
  return text.slice(start, end);
};

test("hybrid startup shell preloads login, main, and collector WebViews before login becomes visible", async () => {
  const [program, loading, startupHtml, project, login, main] = await Promise.all([
    source("Program.cs"),
    source("StartupLoadingForm.cs"),
    source("Ui/startup_loading.html"),
    source("HurogiCollector.csproj"),
    source("CollectorLoginWebForm.cs"),
    source("MainForm.cs")
  ]);

  assert.match(loading, /internal sealed class StartupLoadingForm : Form/);
  assert.doesNotMatch(loading, /powershell|\.cmd/i);
  assert.match(loading, /private readonly WebView2 _webView/);
  assert.match(loading, /DefaultBackgroundColor = ShellBackground/);
  assert.match(loading, /Visible = false/);
  assert.match(loading, /_ = InitializeHtmlSurfaceAsync\(\);\s*base\.OnShown\(e\)/);
  assert.match(loading, /CoreWebView2Environment\.CreateAsync\(userDataFolder: cacheRoot\)/);
  assert.match(loading, /"ByeollogStartupUi"/);
  assert.doesNotMatch(loading, /AgentDataPaths\.CurrentRoot/);
  assert.match(loading, /NavigateToString\(ReadStartupHtml\(\)\)/);
  assert.match(loading, /PostWebMessageAsJson/);
  assert.match(loading, /case "drag":[\s\S]{0,100}NativeWindowDrag\.Begin\(this\)/);
  assert.match(loading, /case "close":[\s\S]{0,100}RequestCancel\(\)/);
  assert.match(loading, /catch[\s\S]{0,500}_nativeFallback\.Visible = true/);
  assert.match(loading, /internal sealed class StartupProgressPanel : Control/);
  assert.match(loading, /internal sealed class StartupActivityIndicator : Control/);
  assert.match(loading, /ClientSize = new Size\(1040, 640\)/);
  assert.match(loading, /AutoScaleMode = AutoScaleMode\.None/);
  assert.match(loading, /Size = new Size\(724, 72\)/);
  assert.match(loading, /internal sealed class StartupSingleLineText : Control/);
  assert.match(loading, /TextFormatFlags\.SingleLine/);
  assert.match(loading, /TextRenderer\.MeasureText\([\s\S]*?RenderFlags/);
  assert.match(loading, /TextRenderer\.DrawText\([\s\S]*?RenderFlags/);
  assert.match(loading, /_stageLabel\.SetFittedText\(stage\)/);
  assert.match(loading, /_detailLabel\.SetFittedText\(detail\)/);
  assert.doesNotMatch(loading, /UseCompatibleTextRendering = true/);
  assert.doesNotMatch(loading, /Anchor = AnchorStyles/);
  assert.doesNotMatch(loading, /new ProgressBar|ProgressBarStyle/);
  assert.match(loading, /Text = "●  별록 시작 준비"/);
  assert.match(loading, /ControlStyles\.OptimizedDoubleBuffer/);
  assert.match(loading, /protected override void OnHandleCreated\(EventArgs e\)[\s\S]+ApplyRoundedRegion\(\)/);
  assert.match(loading, /protected override void OnPaintBackground\(PaintEventArgs e\)[\s\S]+e\.Graphics\.Clear\(ShellBackground\)/);
  assert.match(loading, /BackColor = ShellBackground/);
  assert.doesNotMatch(loading, /BackColor = Color\.Transparent/);
  assert.match(project, /Ui\\startup_loading\.html" LogicalName="HurogiCollector\.Ui\.startup_loading\.html"/);
  assert.match(startupHtml, /class="close" id="closeButton"/);
  assert.match(startupHtml, /class="official-logo" src="__BYEOLLOG_OFFICIAL_LOGO__"/);
  assert.match(loading, /OfficialLogoResourceName = "HurogiCollector\.Ui\.byeollog_logo_dark_safe\.png"/);
  assert.doesNotMatch(startupHtml, /byeollog_symbol|brand-mark|class="symbol"/);
  assert.match(startupHtml, /class="progress-card"/);
  assert.match(startupHtml, /data-at="55">화면 준비/);
  assert.doesNotMatch(startupHtml, /h1\{[^}]*text-overflow:ellipsis/);
  assert.doesNotMatch(startupHtml, /\.detail\{[^}]*text-overflow:ellipsis/);
  assert.match(startupHtml, /h1\{[^}]*white-space:nowrap[^}]*overflow:visible[^}]*text-overflow:clip/);
  assert.match(startupHtml, /\.detail\{[^}]*white-space:nowrap[^}]*overflow:visible[^}]*text-overflow:clip/);
  assert.match(startupHtml, /const fitSingleLine=\(element,preferred,minimum\)=>\{[\s\S]*?while\(element\.scrollWidth>available&&size>minimum\)/);
  assert.match(startupHtml, /const fitCopy=\(\)=>\{fitSingleLine\(stage,36,24\);fitSingleLine\(detail,16,12\)\}/);
  assert.match(startupHtml, /stage\.textContent=[^;]+;detail\.textContent=[^;]+;fitCopy\(\)/);
  assert.match(startupHtml, /new ResizeObserver\(fitCopy\)\.observe\(document\.querySelector\('\.hero-copy'\)\);requestAnimationFrame\(fitCopy\)/);
  assert.match(startupHtml, /window\.chrome\?\.webview\?\.postMessage/);
  assert.doesNotMatch(startupHtml, /https?:\/\//i);
  assert.match(program, /using \(var splash = new StartupLoadingForm\(\)\)/);
  assert.match(program, /using var applicationContext = new ApplicationContext\(splash\)/);
  assert.match(program, /Application\.Run\(applicationContext\)/);
  assert.doesNotMatch(program, /Application\.Run\((?:splash|mainForm)\)/);
  assert.equal((program.match(/Application\.Run\(/g) ?? []).length, 1);

  ordered(program, [
    "UiAssetStore.Prepare()",
    "mainForm = new MainForm(storage, programStartedAtLocal, vNextDevClient)",
    "new CollectorLoginWebForm(storage, vNextDevClient)",
    "mainForm.PrepareForDisplayAsync()",
    "login.PrepareForDisplayAsync()",
    "await Task.WhenAll(mainPreparation, loginPreparation)",
    "mainForm.PrepareCollectorWebViewBeforeLoginAsync()",
    "splash.Hide()",
    "login.ShowDialog()"
  ], "all post-login browser resources must be ready while the startup shell remains visible");

  for (const contents of [login, main]) {
    assert.match(contents, /internal Task PrepareForDisplayAsync\(\)/);
    assert.match(contents, /EnsureCoreWebView2Async/);
    assert.match(contents, /TaskCompletionSource<string\?>/);
    assert.match(contents, /WaitAsync\(TimeSpan\.FromSeconds\(15\)\)/);
  }
  assert.match(main, /await PushMainStateAsync\(\)/);
  assert.match(main, /internal async Task PrepareCollectorWebViewBeforeLoginAsync\(\)/);
  assert.match(program, /login\.PrepareMainWindowBeforeCloseAsync = mainForm\.RefreshPreparedMainStateAsync/);
});

test("every startup stage keeps its complete Korean title and description", async () => {
  const [program, loading] = await Promise.all([
    source("Program.cs"),
    source("StartupLoadingForm.cs")
  ]);

  const expectedMessages = [
    ["내 설정을 안전하게 확인하는 중", "기존 로그인과 방송 설정은 그대로 유지됩니다."],
    ["별록 화면을 미리 준비하는 중", "로그인 후 기다리지 않도록 화면과 리소스를 지금 불러옵니다."],
    ["방송 연결을 미리 준비하는 중", "로그인 후 바로 사용할 위플랩 수집 화면을 준비합니다."],
    ["준비 완료", "로그인 화면을 열고 있습니다."]
  ];
  for (const [stage, detail] of expectedMessages) {
    assert.ok(program.includes(`splash.SetStage("${stage}", "${detail}")`), `missing complete stage: ${stage}`);
  }
  assert.match(loading, /SetStage\("별록 시작을 취소하는 중", "현재 준비 작업을 안전하게 마무리하고 있습니다\."\)/);
});

test("the WebView login window clips its native corners like the main window", async () => {
  const login = await source("CollectorLoginWebForm.cs");

  assert.match(login, /ApplyRoundedRegion\(24\);/);
  assert.match(login, /Resize \+= \(_, _\) => ApplyRoundedRegion\(24\);/);
  assert.match(login, /private void ApplyRoundedRegion\(int radius\)/);
  assert.match(login, /path\.AddArc\(bounds\.Left, bounds\.Top/);
  assert.match(login, /path\.AddArc\(bounds\.Right - diameter, bounds\.Bottom - diameter/);
  assert.match(login, /var previous = Region;\s*Region = new Region\(path\);\s*previous\?\.Dispose\(\);/);
});

test("collector WebView retries E_ABORT without misreporting a missing runtime", async () => {
  const main = await source("MainForm.cs");

  assert.match(main, /Task\? _collectorWebInitializationTask/);
  assert.match(main, /_collectorWebInitializationTask \?\?= InitializeCollectorWebViewWithRetryAsync\(\)/);
  assert.match(main, /unchecked\(\(int\)0x80004004\)/);
  assert.match(main, /ResetCollectorWebViewAfterFailedInitialization\(\)/);
  assert.match(main, /ex is WebView2RuntimeNotFoundException/);

  const init = section(main, "private async Task InitWebAsync()", "private Task RestoreWeflabSessionAsync()");
  assert.doesNotMatch(init, /msg\.Contains\("WebView2"/);
  assert.match(init, /위플랩 연결 화면을 준비하는 중 Windows가 작업을 중단했습니다/);
});

test("successful authentication refreshes the prepared shell before closing login", async () => {
  const [program, login] = await Promise.all([
    source("Program.cs"),
    source("CollectorLoginWebForm.cs")
  ]);

  assert.match(login, /internal Func<Task>\? PrepareMainWindowBeforeCloseAsync/);
  assert.match(login, /if \(_loginInProgress\) return;[\s\S]{0,120}_loginInProgress = true/);
  const loginFlow = section(login, "private async Task LoginAsync(", "private async Task CompleteMainWindowHandoffAsync(");
  const handoff = section(login, "private async Task CompleteMainWindowHandoffAsync(", "private void BeginAutomationSessionAdoption(");
  ordered(loginFlow, [
    "_storage.MarkAccountLoginComplete()",
    "BeginAutomationSessionAdoption(",
    "_accountLoginCommitted = true",
    "await CompleteMainWindowHandoffAsync()"
  ], "authentication must commit once before the UI handoff");
  ordered(handoff, [
    'phase = "preparing"',
    "await PrepareMainWindowBeforeCloseAsync()",
    "DialogResult = DialogResult.OK",
    "Close()"
  ], "prepared state refresh must complete before login closes");
  assert.match(handoff, /phase = "prepareError"/);
  assert.doesNotMatch(handoff, /focus = "password"/);

  ordered(program, [
    "if (login.ShowDialog() != DialogResult.OK)",
    "mainForm.StartPosition = FormStartPosition.Manual",
    "mainForm.Show()",
    "applicationContext.MainForm = mainForm",
    "startupCompleted = true",
    "splash.CompleteAndClose()"
  ], "the prepared main window must replace the splash inside one long-lived message loop");
});

test("startup does not steal focus after deferred background initialization", async () => {
  const [main, ui] = await Promise.all([
    source("MainForm.cs"),
    source("Ui/byeollog_ui.html")
  ]);

  assert.doesNotMatch(main, /BeginInvoke\(new Action\(EnsureMainWindowVisible\)\)/);
  assert.match(main, /_ui\.DefaultBackgroundColor = shellBackground/);
  assert.match(ui, /state\.phase==='preparing'\?'별록 준비 중\.\.\.'/);
});
