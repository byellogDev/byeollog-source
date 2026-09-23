using System.Drawing.Drawing2D;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace HurogiCollector;

/// <summary>
/// Shows an immediate native shell, then replaces it with the embedded HTML startup UI.
/// The native shell deliberately remains a complete fallback: WebView2 startup must never
/// delay or prevent the Agent itself from starting.
/// </summary>
internal sealed class StartupLoadingForm : Form
{
    private const int WmNclButtonDown = 0x00A1;
    private const int HtCaption = 0x0002;
    private const string StartupResourceName = "HurogiCollector.Ui.startup_loading.html";
    private const string OfficialLogoResourceName = "HurogiCollector.Ui.byeollog_logo_dark_safe.png";
    private const string OfficialLogoToken = "__BYEOLLOG_OFFICIAL_LOGO__";
    private static readonly Color ShellBackground = Color.FromArgb(7, 18, 38);
    private static readonly Color ShellBorder = Color.FromArgb(35, 61, 98);

    private readonly Panel _nativeFallback;
    private readonly StartupSingleLineText _stageLabel;
    private readonly StartupSingleLineText _detailLabel;
    private readonly Button _closeButton;
    private readonly StartupProgressPanel _progressPanel;
    private readonly WebView2 _webView;
    private readonly CancellationTokenSource _cancellation = new();
    private Icon? _appIcon;
    private string _currentStage = "별록을 시작하고 있어요";
    private string _currentDetail = "로그인 전에 필요한 화면과 설정을 미리 준비합니다.";
    private bool _htmlReady;
    private bool _htmlInitializationStarted;
    private bool _allowClose;

    internal StartupLoadingForm()
    {
        SetStyle(
            ControlStyles.UserPaint |
            ControlStyles.AllPaintingInWmPaint |
            ControlStyles.OptimizedDoubleBuffer |
            ControlStyles.ResizeRedraw,
            true);
        DoubleBuffered = true;
        Text = "별록 시작";
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.CenterScreen;
        // Keep the borderless first frame pixel-stable; its dedicated text controls
        // measure and paint through the same single-line DPI-aware GDI pipeline.
        AutoScaleMode = AutoScaleMode.None;
        ClientSize = new Size(1040, 640);
        BackColor = ShellBackground;
        ForeColor = Color.FromArgb(248, 250, 252);
        ShowInTaskbar = true;
        TopMost = false;
        Opacity = 1.0;

        _appIcon = LoadAppIcon();
        Icon = _appIcon;

        _nativeFallback = new Panel
        {
            Dock = DockStyle.Fill,
            BackColor = ShellBackground
        };

        var officialLogo = new PictureBox
        {
            Location = new Point(52, 28),
            Size = new Size(245, 116),
            SizeMode = PictureBoxSizeMode.Zoom,
            BackColor = ShellBackground,
            Image = LoadOfficialLogo()
        };

        _closeButton = new Button
        {
            Location = new Point(964, 28),
            Size = new Size(48, 48),
            FlatStyle = FlatStyle.Flat,
            BackColor = Color.FromArgb(12, 31, 61),
            ForeColor = Color.White,
            Font = new Font("맑은 고딕", 16F),
            Text = "×",
            TabStop = false,
            Cursor = Cursors.Hand
        };
        _closeButton.FlatAppearance.BorderColor = Color.FromArgb(39, 65, 103);
        _closeButton.FlatAppearance.MouseOverBackColor = Color.FromArgb(24, 49, 84);
        _closeButton.Click += (_, _) => RequestCancel();

        var preparingBadge = new Label
        {
            AutoSize = false,
            Location = new Point(64, 169),
            Size = new Size(220, 28),
            TextAlign = ContentAlignment.MiddleLeft,
            Font = new Font("맑은 고딕", 10F, FontStyle.Bold),
            ForeColor = Color.FromArgb(247, 185, 54),
            BackColor = ShellBackground,
            Text = "●  별록 시작 준비"
        };
        _stageLabel = new StartupSingleLineText(24F, 14F, FontStyle.Bold)
        {
            Location = new Point(64, 211),
            Size = new Size(724, 72),
            ForeColor = Color.White,
            BackColor = ShellBackground,
            Text = _currentStage
        };
        _detailLabel = new StartupSingleLineText(12F, 9F, FontStyle.Regular)
        {
            Location = new Point(64, 283),
            Size = new Size(724, 62),
            ForeColor = Color.FromArgb(151, 173, 209),
            BackColor = ShellBackground,
            Text = _currentDetail
        };
        var activityIndicator = new StartupActivityIndicator
        {
            Location = new Point(836, 179),
            Size = new Size(140, 140),
            BackColor = ShellBackground
        };
        _progressPanel = new StartupProgressPanel
        {
            Location = new Point(64, 376),
            Size = new Size(912, 132),
            BackColor = ShellBackground,
            Progress = GetProgress(_currentStage)
        };
        var safeCopy = new Label
        {
            AutoSize = false,
            Location = new Point(64, 588),
            Size = new Size(560, 26),
            TextAlign = ContentAlignment.MiddleLeft,
            Font = new Font("맑은 고딕", 10F),
            ForeColor = Color.FromArgb(102, 130, 173),
            BackColor = ShellBackground,
            Text = "♢  로그인과 방송 설정은 그대로 유지됩니다."
        };
        var version = new Label
        {
            AutoSize = false,
            Location = new Point(766, 588),
            Size = new Size(210, 26),
            TextAlign = ContentAlignment.MiddleRight,
            Font = new Font("맑은 고딕", 10F),
            ForeColor = Color.FromArgb(102, 130, 173),
            BackColor = ShellBackground,
            Text = $"v{BuildInfo.DisplayVersion}"
        };

        _nativeFallback.Controls.AddRange(new Control[]
        {
            officialLogo, _closeButton, preparingBadge,
            _stageLabel, _detailLabel, activityIndicator, _progressPanel, safeCopy, version
        });

        _webView = new WebView2
        {
            Dock = DockStyle.Fill,
            DefaultBackgroundColor = ShellBackground,
            Visible = false
        };

        Controls.Add(_nativeFallback);
        Controls.Add(_webView);

        MouseDown += BeginDrag;
        _nativeFallback.MouseDown += BeginDrag;
        foreach (var control in new Control[] { officialLogo, preparingBadge, _stageLabel, _detailLabel, safeCopy })
            control.MouseDown += BeginDrag;

        Resize += (_, _) => ApplyRoundedRegion();
        FormClosing += OnFormClosing;
        FormClosed += (_, _) =>
        {
            try { _webView.Dispose(); } catch { }
            officialLogo.Image?.Dispose();
            activityIndicator.Dispose();
            _progressPanel.Dispose();
            _appIcon?.Dispose();
            _appIcon = null;
        };
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        ApplyRoundedRegion();
    }

    protected override void OnShown(EventArgs e)
    {
        ApplyRoundedRegion();
        Invalidate(true);
        Update();

        // Start the embedded HTML surface before raising Shown to Program. This call
        // returns at its first await, so the native shell still paints immediately,
        // while HTML and the rest of the Agent warm in parallel.
        _ = InitializeHtmlSurfaceAsync();
        base.OnShown(e);
    }

    protected override void OnPaintBackground(PaintEventArgs e)
    {
        e.Graphics.Clear(ShellBackground);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using var border = CreateRoundedPath(
            new RectangleF(0.5F, 0.5F, ClientSize.Width - 1F, ClientSize.Height - 1F),
            26F);
        using var pen = new Pen(ShellBorder, 1F);
        e.Graphics.DrawPath(pen, border);
    }

    internal CancellationToken CancellationToken => _cancellation.Token;

    internal void SetStage(string stage, string detail)
    {
        if (IsDisposed) return;
        _currentStage = stage;
        _currentDetail = detail;
        _stageLabel.SetFittedText(stage);
        _detailLabel.SetFittedText(detail);
        _progressPanel.Progress = GetProgress(stage);
        _stageLabel.Refresh();
        _detailLabel.Refresh();
        if (_htmlReady) PostHtmlState();
    }

    internal void CompleteAndClose()
    {
        if (IsDisposed) return;
        _allowClose = true;
        Close();
    }

    private async Task InitializeHtmlSurfaceAsync()
    {
        if (_htmlInitializationStarted || IsDisposed) return;
        _htmlInitializationStarted = true;

        try
        {
            var cacheRoot = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "ByeollogStartupUi");
            Directory.CreateDirectory(cacheRoot);

            var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: cacheRoot);
            if (IsDisposed) return;
            await _webView.EnsureCoreWebView2Async(environment);
            if (IsDisposed || _webView.CoreWebView2 is null) return;

            var core = _webView.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsBuiltInErrorPageEnabled = false;
            core.NavigationStarting += (_, args) =>
            {
                if (!string.Equals(args.Uri, "about:blank", StringComparison.OrdinalIgnoreCase))
                    args.Cancel = true;
            };
            core.NewWindowRequested += (_, args) => args.Handled = true;
            core.WebMessageReceived += CoreWebView2_WebMessageReceived;

            var navigationReady = new TaskCompletionSource<bool>(
                TaskCreationOptions.RunContinuationsAsynchronously);
            _webView.NavigationCompleted += (_, args) => navigationReady.TrySetResult(args.IsSuccess);
            _webView.NavigateToString(ReadStartupHtml());

            var loaded = await navigationReady.Task.WaitAsync(TimeSpan.FromSeconds(8));
            if (!loaded || IsDisposed) return;

            _htmlReady = true;
            PostHtmlState();
            _webView.Visible = true;
            _webView.BringToFront();
            _nativeFallback.Visible = false;
        }
        catch
        {
            // The native shell is intentionally sufficient on its own. A missing or
            // damaged WebView2 runtime must not prevent login or broadcast startup.
            _htmlReady = false;
            if (!IsDisposed)
            {
                _nativeFallback.Visible = true;
                _nativeFallback.BringToFront();
            }
        }
    }

    private void PostHtmlState()
    {
        if (!_htmlReady || IsDisposed || _webView.CoreWebView2 is null) return;
        var message = JsonSerializer.Serialize(new
        {
            kind = "state",
            stage = _currentStage,
            detail = _currentDetail,
            progress = GetProgress(_currentStage),
            cancelling = _cancellation.IsCancellationRequested,
            version = BuildInfo.DisplayVersion
        });
        try { _webView.CoreWebView2.PostWebMessageAsJson(message); } catch { }
    }

    private void CoreWebView2_WebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!_htmlReady || IsDisposed) return;
        try
        {
            using var document = JsonDocument.Parse(e.WebMessageAsJson);
            var kind = document.RootElement.TryGetProperty("kind", out var kindElement)
                ? kindElement.GetString() ?? ""
                : "";
            switch (kind)
            {
                case "drag":
                    NativeWindowDrag.Begin(this);
                    break;
                case "close":
                    RequestCancel();
                    break;
            }
        }
        catch
        {
            // Ignore malformed messages from the isolated embedded startup page.
        }
    }

    private void RequestCancel()
    {
        if (_cancellation.IsCancellationRequested) return;
        _cancellation.Cancel();
        _closeButton.Enabled = false;
        SetStage("별록 시작을 취소하는 중", "현재 준비 작업을 안전하게 마무리하고 있습니다.");
    }

    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        if (_allowClose) return;
        e.Cancel = true;
        RequestCancel();
    }

    private void BeginDrag(object? sender, MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Left) return;
        ReleaseCapture();
        SendMessage(Handle, WmNclButtonDown, HtCaption, 0);
    }

    private void ApplyRoundedRegion()
    {
        if (ClientSize.Width <= 0 || ClientSize.Height <= 0) return;
        using var path = CreateRoundedPath(
            new RectangleF(0, 0, ClientSize.Width, ClientSize.Height),
            26F);
        var previous = Region;
        Region = new Region(path);
        previous?.Dispose();
    }

    private static GraphicsPath CreateRoundedPath(RectangleF bounds, float radius)
    {
        var path = new GraphicsPath();
        var diameter = radius * 2F;
        path.AddArc(bounds.Left, bounds.Top, diameter, diameter, 180, 90);
        path.AddArc(bounds.Right - diameter, bounds.Top, diameter, diameter, 270, 90);
        path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(bounds.Left, bounds.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return path;
    }

    private static int GetProgress(string stage)
    {
        if (stage.Contains("취소", StringComparison.Ordinal)) return 100;
        if (stage.Contains("준비 완료", StringComparison.Ordinal)) return 100;
        if (stage.Contains("방송 연결", StringComparison.Ordinal)) return 82;
        if (stage.Contains("화면", StringComparison.Ordinal)) return 55;
        if (stage.Contains("설정", StringComparison.Ordinal)) return 28;
        return 12;
    }

    private static string ReadStartupHtml()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(StartupResourceName)
            ?? throw new InvalidOperationException("별록 시작 화면 리소스가 없습니다.");
        using var reader = new StreamReader(stream);
        var html = reader.ReadToEnd();

        using var logoStream = Assembly.GetExecutingAssembly().GetManifestResourceStream(OfficialLogoResourceName)
            ?? throw new InvalidOperationException("별록 공식 로고 리소스가 없습니다.");
        using var logoBytes = new MemoryStream();
        logoStream.CopyTo(logoBytes);
        var logoDataUri = "data:image/png;base64," + Convert.ToBase64String(logoBytes.ToArray());
        return html.Replace(OfficialLogoToken, logoDataUri, StringComparison.Ordinal);
    }

    private static Icon LoadAppIcon()
    {
        try
        {
            using var stream = Assembly.GetExecutingAssembly()
                .GetManifestResourceStream("HurogiCollector.Assets.byeollog_app.ico");
            if (stream is not null)
            {
                using var icon = new Icon(stream);
                return (Icon)icon.Clone();
            }
        }
        catch { }
        return (Icon)SystemIcons.Application.Clone();
    }

    private static Image? LoadOfficialLogo()
    {
        try
        {
            using var stream = Assembly.GetExecutingAssembly()
                .GetManifestResourceStream(OfficialLogoResourceName);
            if (stream is null) return null;
            using var image = Image.FromStream(stream);
            return new Bitmap(image);
        }
        catch
        {
            return null;
        }
    }

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    private static extern nint SendMessage(nint hWnd, int msg, int wParam, int lParam);
}

/// <summary>
/// Native startup copy rendered through one GDI pipeline for both measurement
/// and painting. A stock Label can word-wrap the final Korean word at high DPI
/// even when a separate SingleLine measurement reports that the text fits.
/// </summary>
internal sealed class StartupSingleLineText : Control
{
    private const TextFormatFlags RenderFlags =
        TextFormatFlags.Left |
        TextFormatFlags.VerticalCenter |
        TextFormatFlags.SingleLine |
        TextFormatFlags.NoPadding |
        TextFormatFlags.NoPrefix;

    private readonly float _preferredSize;
    private readonly float _minimumSize;
    private readonly FontStyle _style;
    private Font _renderFont;

    internal StartupSingleLineText(float preferredSize, float minimumSize, FontStyle style)
    {
        _preferredSize = preferredSize;
        _minimumSize = minimumSize;
        _style = style;
        _renderFont = new Font("맑은 고딕", preferredSize, style);
        SetStyle(
            ControlStyles.UserPaint |
            ControlStyles.AllPaintingInWmPaint |
            ControlStyles.OptimizedDoubleBuffer,
            true);
    }

    internal void SetFittedText(string text)
    {
        Text = text ?? string.Empty;
        RefitForCurrentDpi();
        Invalidate();
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        RefitForCurrentDpi();
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        RefitForCurrentDpi();
    }

    protected override void OnTextChanged(EventArgs e)
    {
        base.OnTextChanged(e);
        RefitForCurrentDpi();
        Invalidate();
    }

    protected override void OnPaintBackground(PaintEventArgs e) => e.Graphics.Clear(BackColor);

    protected override void OnPaint(PaintEventArgs e)
    {
        TextRenderer.DrawText(
            e.Graphics,
            Text,
            _renderFont,
            ClientRectangle,
            ForeColor,
            BackColor,
            RenderFlags);
    }

    private void RefitForCurrentDpi()
    {
        if (!IsHandleCreated || ClientSize.Width <= 0) return;
        var availableWidth = Math.Max(1, ClientSize.Width - LogicalToDeviceUnits(12));
        var chosenSize = _minimumSize;
        using var graphics = CreateGraphics();
        for (var size = _preferredSize; size >= _minimumSize; size -= 0.5F)
        {
            using var candidate = new Font("맑은 고딕", size, _style);
            var measured = TextRenderer.MeasureText(
                graphics,
                Text,
                candidate,
                new Size(int.MaxValue, int.MaxValue),
                RenderFlags);
            chosenSize = size;
            if (measured.Width <= availableWidth) break;
        }

        if (Math.Abs(_renderFont.Size - chosenSize) < 0.1F) return;
        var previous = _renderFont;
        _renderFont = new Font("맑은 고딕", chosenSize, _style);
        previous.Dispose();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) _renderFont.Dispose();
        base.Dispose(disposing);
    }
}

/// <summary>
/// Lightweight native equivalent of the HTML startup activity graphic. It is
/// intentionally independent of WebView2 so the very first painted frame uses
/// the same current visual language as the HTML surface.
/// </summary>
internal sealed class StartupActivityIndicator : Control
{
    private readonly System.Windows.Forms.Timer _animationTimer;
    private float _angle;

    internal StartupActivityIndicator()
    {
        SetStyle(
            ControlStyles.UserPaint |
            ControlStyles.AllPaintingInWmPaint |
            ControlStyles.OptimizedDoubleBuffer |
            ControlStyles.SupportsTransparentBackColor,
            true);
        _animationTimer = new System.Windows.Forms.Timer { Interval = 45 };
        _animationTimer.Tick += (_, _) =>
        {
            _angle = (_angle + 4.5F) % 360F;
            Invalidate();
        };
        _animationTimer.Start();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.Clear(BackColor);
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        var outer = new RectangleF(8, 8, Width - 16, Height - 16);
        var inner = RectangleF.Inflate(outer, -19, -19);
        using var quietPen = new Pen(Color.FromArgb(42, 111, 151, 207), 1F);
        using var accentPen = new Pen(Color.FromArgb(247, 185, 54), 2.2F);
        e.Graphics.DrawEllipse(quietPen, outer);
        e.Graphics.DrawEllipse(quietPen, inner);
        e.Graphics.DrawArc(accentPen, outer, _angle, 72F);

        var core = new RectangleF((Width - 40) / 2F, (Height - 40) / 2F, 40, 40);
        using var coreBrush = new LinearGradientBrush(
            core,
            Color.FromArgb(251, 202, 82),
            Color.FromArgb(221, 146, 30),
            LinearGradientMode.ForwardDiagonal);
        e.Graphics.FillEllipse(coreBrush, core);
        using var haloBrush = new SolidBrush(Color.FromArgb(52, 255, 244, 207));
        using var dotBrush = new SolidBrush(Color.FromArgb(255, 244, 207));
        e.Graphics.FillEllipse(haloBrush, RectangleF.Inflate(core, -7, -7));
        e.Graphics.FillEllipse(dotBrush, RectangleF.Inflate(core, -14, -14));
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _animationTimer.Stop();
            _animationTimer.Dispose();
        }
        base.Dispose(disposing);
    }
}

/// <summary>
/// Custom-painted progress card used before WebView2 is ready. A stock Windows
/// ProgressBar would expose the old white/green system chrome for the most
/// visible first frame, so the native fallback paints the exact Byeollog card.
/// </summary>
internal sealed class StartupProgressPanel : Control
{
    private readonly Font _captionFont = new("맑은 고딕", 10F, FontStyle.Bold);
    private readonly Font _stepFont = new("맑은 고딕", 9F, FontStyle.Bold);
    private int _progress = 12;

    internal StartupProgressPanel()
    {
        SetStyle(
            ControlStyles.UserPaint |
            ControlStyles.AllPaintingInWmPaint |
            ControlStyles.OptimizedDoubleBuffer,
            true);
    }

    internal int Progress
    {
        get => _progress;
        set
        {
            var next = Math.Clamp(value, 0, 100);
            if (_progress == next) return;
            _progress = next;
            Invalidate();
        }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        e.Graphics.Clear(BackColor);

        var card = new RectangleF(0.5F, 0.5F, Width - 1F, Height - 1F);
        using var cardPath = RoundedRectangle(card, 18F);
        using var cardBrush = new SolidBrush(Color.FromArgb(13, 31, 58));
        using var cardPen = new Pen(Color.FromArgb(36, 62, 98), 1F);
        e.Graphics.FillPath(cardBrush, cardPath);
        e.Graphics.DrawPath(cardPen, cardPath);

        TextRenderer.DrawText(
            e.Graphics,
            "시작 준비 상태",
            _captionFont,
            new Point(26, 18),
            Color.FromArgb(194, 210, 233),
            TextFormatFlags.NoPadding);
        TextRenderer.DrawText(
            e.Graphics,
            $"{_progress}%",
            _captionFont,
            new Rectangle(Width - 92, 18, 66, 22),
            Color.FromArgb(247, 185, 54),
            TextFormatFlags.Right | TextFormatFlags.NoPadding);

        var track = new RectangleF(26, 57, Width - 52, 8);
        using var trackPath = RoundedRectangle(track, 3.5F);
        using var trackBrush = new SolidBrush(Color.FromArgb(18, 39, 68));
        e.Graphics.FillPath(trackBrush, trackPath);
        var fillWidth = Math.Max(7F, track.Width * _progress / 100F);
        var fill = new RectangleF(track.Left, track.Top, fillWidth, track.Height);
        using var fillPath = RoundedRectangle(fill, 3.5F);
        using var fillBrush = new LinearGradientBrush(
            fill,
            Color.FromArgb(230, 163, 42),
            Color.FromArgb(255, 225, 154),
            LinearGradientMode.Horizontal);
        e.Graphics.FillPath(fillBrush, fillPath);

        var lastStepX = Math.Max(26, Width - 142);
        var steps = new[]
        {
            (Label: "설정 확인", At: 12, X: 26),
            (Label: "화면 준비", At: 55, X: Math.Max(180, Width / 3 - 34)),
            (Label: "방송 연결", At: 82, X: Math.Max(360, Width * 2 / 3 - 52)),
            (Label: "준비 완료", At: 100, X: lastStepX)
        };
        foreach (var step in steps)
        {
            var active = _progress >= step.At;
            using var dotBrush = new SolidBrush(active
                ? Color.FromArgb(36, 197, 139)
                : Color.FromArgb(41, 72, 110));
            e.Graphics.FillEllipse(dotBrush, step.X, 94, 8, 8);
            TextRenderer.DrawText(
                e.Graphics,
                step.Label,
                _stepFont,
                new Point(step.X + 15, 89),
                active ? Color.FromArgb(220, 232, 248) : Color.FromArgb(111, 141, 183),
                TextFormatFlags.NoPadding);
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _captionFont.Dispose();
            _stepFont.Dispose();
        }
        base.Dispose(disposing);
    }

    private static GraphicsPath RoundedRectangle(RectangleF bounds, float radius)
    {
        var path = new GraphicsPath();
        var diameter = Math.Min(radius * 2F, Math.Min(bounds.Width, bounds.Height));
        path.AddArc(bounds.Left, bounds.Top, diameter, diameter, 180, 90);
        path.AddArc(bounds.Right - diameter, bounds.Top, diameter, diameter, 270, 90);
        path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(bounds.Left, bounds.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return path;
    }
}
