using System.Drawing.Drawing2D;
using System.Text;
using System.Text.Json;

namespace HurogiCollector;

internal sealed class CollectorLoginForm : Form
{
    private readonly CollectorStorage _storage;
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(30) };
    private readonly string _rememberedIdPath;

    private readonly StyledInput _email = new(false, InputIcon.User);
    private readonly StyledInput _password = new(true, InputIcon.Lock);
    private readonly SaveIdCheckBox _saveId = new();
    private readonly GoldLoginButton _loginButton = new();
    private readonly Label _status = new();
    private bool _dragging;
    private Point _dragOffset;

    private static readonly Color Navy = Color.FromArgb(7, 28, 58);
    private static readonly Color Navy2 = Color.FromArgb(6, 22, 47);
    private static readonly Color Gold = Color.FromArgb(255, 187, 43);
    private static readonly Color Blue = Color.FromArgb(67, 145, 255);
    private static readonly Color Muted = Color.FromArgb(137, 153, 181);

    public CollectorLoginForm(CollectorStorage storage)
    {
        _storage = storage;
        _rememberedIdPath = Path.Combine(storage.RootPath, "remembered_login_id.txt");

        Text = "별록 로그인";
        AutoScaleMode = AutoScaleMode.None;
        ClientSize = new Size(620, 735);
        MinimumSize = MaximumSize = Size;
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = true;
        BackColor = Navy;
        ForeColor = Color.White;
        Font = new Font("맑은 고딕", 10F);
        DoubleBuffered = true;

        BuildUi();
        ApplyRoundedWindow();
        LoadRememberedId();

        AcceptButton = _loginButton;

        MouseDown += DragBegin;
        MouseMove += DragMove;
        MouseUp += (_, _) => _dragging = false;
    }

    private void ApplyRoundedWindow()
    {
        using var path = UiPath.RoundRect(new RectangleF(0, 0, ClientSize.Width, ClientSize.Height), 22);
        Region = new Region(path);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;

        // The window itself IS the login card. Keep one flat navy surface so
        // custom controls never reveal a slightly different background patch.
        using var bg = new SolidBrush(Navy);
        e.Graphics.FillRectangle(bg, ClientRectangle);

        using var borderPath = UiPath.RoundRect(new RectangleF(.8f, .8f, Width - 1.6f, Height - 1.6f), 22);
        using var border = new Pen(Color.FromArgb(61, 91, 134), 1.2f);
        e.Graphics.DrawPath(border, borderPath);
    }

    private void BuildUi()
    {
        // Header — every symbol has its own safe drawing area, so nothing is clipped.
        var headerStar = new SmallStarControl
        {
            Location = new Point(24, 18),
            Size = new Size(42, 38),
            TabStop = false
        };
        Controls.Add(headerStar);

        var headerTitle = new Label
        {
            Text = "별록 로그인",
            AutoSize = true,
            Location = new Point(70, 21),
            Font = new Font("맑은 고딕", 13F, FontStyle.Bold),
            ForeColor = Color.White,
            BackColor = Color.Transparent
        };
        Controls.Add(headerTitle);

        var close = new HoverXButton
        {
            Location = new Point(556, 12),
            Size = new Size(48, 48),
            TabStop = false
        };
        close.Click += (_, _) => Close();
        Controls.Add(close);

        // Make header draggable.
        foreach (var c in new Control[] { headerStar, headerTitle })
        {
            c.MouseDown += DragBegin;
            c.MouseMove += DragMove;
            c.MouseUp += (_, _) => _dragging = false;
        }

        // Main logo + wordmark.
        var logo = new BrandLogoControl
        {
            Location = new Point(168, 105),
            Size = new Size(145, 105),
            TabStop = false
        };
        Controls.Add(logo);

        var brand = new Label
        {
            Text = "별록",
            AutoSize = true,
            Location = new Point(324, 111),
            Font = new Font("맑은 고딕", 31F, FontStyle.Bold),
            ForeColor = Color.White,
            BackColor = Color.Transparent
        };
        Controls.Add(brand);

        var subtitle = new Label
        {
            Text = "BYEOLLOG AGENT",
            AutoSize = false,
            Size = new Size(360, 32),
            Location = new Point(130, 218),
            TextAlign = ContentAlignment.MiddleCenter,
            Font = new Font("Segoe UI", 12F, FontStyle.Bold),
            ForeColor = Color.FromArgb(98, 142, 226),
            BackColor = Color.Transparent
        };
        Controls.Add(subtitle);

        _email.Location = new Point(80, 302);
        _email.Size = new Size(460, 66);
        _email.Placeholder = "이메일 또는 사용자 ID";
        _email.TabStop = false;
        _email.InnerTextBox.TabIndex = 0;
        Controls.Add(_email);

        _password.Location = new Point(80, 392);
        _password.Size = new Size(460, 66);
        _password.Placeholder = "비밀번호";
        _password.TabStop = false;
        _password.InnerTextBox.TabIndex = 1;
        Controls.Add(_password);

        _saveId.Text = "ID 저장";
        _saveId.Location = new Point(80, 480);
        _saveId.Size = new Size(125, 34);
        _saveId.TabIndex = 2;
        Controls.Add(_saveId);

        _status.Location = new Point(80, 520);
        _status.Size = new Size(460, 27);
        _status.ForeColor = Color.FromArgb(255, 120, 120);
        _status.BackColor = Color.Transparent;
        _status.TextAlign = ContentAlignment.MiddleLeft;
        Controls.Add(_status);

        _loginButton.Text = "로그인";
        _loginButton.Location = new Point(80, 553);
        _loginButton.Size = new Size(460, 70);
        _loginButton.TabIndex = 3;
        _loginButton.Click += async (_, _) => await LoginAsync();
        Controls.Add(_loginButton);

        // Divider: actual star control gets enough vertical room, preventing the old clipping.
        var leftLine = new Panel
        {
            BackColor = Color.FromArgb(52, 81, 121),
            Location = new Point(80, 650),
            Size = new Size(200, 1),
            TabStop = false
        };
        var footerStar = new DividerStarControl
        {
            Location = new Point(289, 632),
            Size = new Size(42, 38),
            TabStop = false
        };
        var rightLine = new Panel
        {
            BackColor = Color.FromArgb(52, 81, 121),
            Location = new Point(340, 650),
            Size = new Size(200, 1),
            TabStop = false
        };
        Controls.Add(leftLine);
        Controls.Add(footerStar);
        Controls.Add(rightLine);

        // Future account features: UI only for now.
        var forgot = new Label
        {
            Text = "비밀번호 찾기",
            AutoSize = true,
            Location = new Point(80, 674),
            Font = new Font("맑은 고딕", 11.2F),
            ForeColor = Color.FromArgb(62, 150, 255),
            BackColor = Color.Transparent,
            Cursor = Cursors.Hand,
            TabStop = false
        };
        var signup = new Label
        {
            Text = "회원가입",
            AutoSize = true,
            Location = new Point(467, 674),
            Font = new Font("맑은 고딕", 11.2F),
            ForeColor = Gold,
            BackColor = Color.Transparent,
            Cursor = Cursors.Hand,
            TabStop = false
        };
        // Match the bottom links exactly to the login button edges.
        forgot.Left = 80;
        signup.Left = 540 - signup.PreferredWidth;

        Controls.Add(forgot);
        Controls.Add(signup);

        // Keyboard navigation: one Tab from email goes directly to password.
        _email.InnerTextBox.KeyDown += (_, e) =>
        {
            if (e.KeyCode == Keys.Tab || e.KeyCode == Keys.Enter)
            {
                e.SuppressKeyPress = true;
                _password.FocusInput();
            }
        };
        _password.InnerTextBox.KeyDown += async (_, e) =>
        {
            if (e.KeyCode == Keys.Enter)
            {
                e.SuppressKeyPress = true;
                await LoginAsync();
            }
        };
    }

    private void LoadRememberedId()
    {
        try
        {
            if (File.Exists(_rememberedIdPath))
            {
                var id = File.ReadAllText(_rememberedIdPath, Encoding.UTF8).Trim();
                if (!string.IsNullOrWhiteSpace(id))
                {
                    _email.TextValue = id;
                    _saveId.Checked = true;
                    _password.FocusInput();
                    return;
                }
            }
        }
        catch { }

        _email.FocusInput();
    }

    private void PersistRememberedId()
    {
        try
        {
            if (_saveId.Checked && !string.IsNullOrWhiteSpace(_email.TextValue))
                File.WriteAllText(_rememberedIdPath, _email.TextValue.Trim(), new UTF8Encoding(false));
            else if (File.Exists(_rememberedIdPath))
                File.Delete(_rememberedIdPath);
        }
        catch { }
    }

    private string BaseServerUrl()
    {
        var url = (_storage.Config.ServerUrl ?? "").Trim();
        if (url.EndsWith("/api/collector", StringComparison.OrdinalIgnoreCase))
            url = url[..^"/api/collector".Length];

        return string.IsNullOrWhiteSpace(url)
            ? CollectorStorage.ProductionServerUrl
            : url.TrimEnd('/');
    }

    private async Task LoginAsync()
    {
        var id = _email.TextValue.Trim();
        var password = _password.TextValue;

        if (string.IsNullOrWhiteSpace(id))
        {
            _status.Text = "이메일을 입력해주세요.";
            _email.SetError(true);
            _email.FocusInput();
            return;
        }

        if (string.IsNullOrWhiteSpace(password))
        {
            _status.Text = "비밀번호를 입력해주세요.";
            _password.SetError(true);
            _password.FocusInput();
            return;
        }

        _email.SetError(false);
        _password.SetError(false);
        _status.ForeColor = Muted;
        _status.Text = "계정 확인 중...";
        _loginButton.Enabled = false;

        try
        {
            var baseUrl = BaseServerUrl();
            var json = JsonSerializer.Serialize(new
            {
                mode = "account",
                email = id,
                password,
                device_name = Environment.MachineName,
            collector_version = BuildInfo.Version
            });

            using var req = new HttpRequestMessage(HttpMethod.Post, baseUrl + "/api/collector-pair");
            req.Content = new StringContent(json, Encoding.UTF8, "application/json");

            using var res = await _http.SendAsync(req);
            var body = await res.Content.ReadAsStringAsync();

            if (!res.IsSuccessStatusCode)
            {
                try
                {
                    using var err = JsonDocument.Parse(body);
                    if (err.RootElement.TryGetProperty("message", out var msg))
                        throw new Exception(msg.GetString() ?? "로그인에 실패했습니다.");
                }
                catch (JsonException) { }

                throw new Exception("로그인에 실패했습니다.");
            }

            using var doc = JsonDocument.Parse(body);
            var token = doc.RootElement.GetProperty("device_token").GetString() ?? "";
            if (string.IsNullOrWhiteSpace(token))
                throw new Exception("서버에서 기기 인증 정보를 받지 못했습니다.");

            _storage.SaveConfig(baseUrl + "/api/collector", token);
            _storage.MarkAccountLoginComplete();
            PersistRememberedId();

            _password.TextValue = "";
            DialogResult = DialogResult.OK;
            Close();
        }
        catch (Exception ex)
        {
            _password.TextValue = "";
            _status.ForeColor = Color.FromArgb(255, 120, 120);
            _status.Text = ex.Message;
            _password.SetError(true);
            _password.FocusInput();
        }
        finally
        {
            _loginButton.Enabled = true;
        }
    }

    private void DragBegin(object? sender, MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Left) return;
        _dragging = true;
        var screen = (sender as Control ?? this).PointToScreen(e.Location);
        _dragOffset = new Point(screen.X - Left, screen.Y - Top);
    }

    private void DragMove(object? sender, MouseEventArgs e)
    {
        if (!_dragging) return;
        var screen = (sender as Control ?? this).PointToScreen(e.Location);
        Location = new Point(screen.X - _dragOffset.X, screen.Y - _dragOffset.Y);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) _http.Dispose();
        base.Dispose(disposing);
    }
}

internal enum InputIcon { User, Lock }

internal static class UiPath
{
    public static GraphicsPath RoundRect(RectangleF r, float radius)
    {
        var p = new GraphicsPath();
        var d = radius * 2f;
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }
}

internal sealed class HoverXButton : Control
{
    private bool _hover;

    public HoverXButton()
    {
        Cursor = Cursors.Hand;
        BackColor = Color.FromArgb(7, 28, 58);
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                 ControlStyles.OptimizedDoubleBuffer, true);

        MouseEnter += (_, _) => { _hover = true; Invalidate(); };
        MouseLeave += (_, _) => { _hover = false; Invalidate(); };
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;

        // Deliberately never paint a hover background. Only the X changes color.
        var color = _hover ? Color.FromArgb(255, 187, 43) : Color.White;
        using var pen = new Pen(color, 2.5f)
        {
            StartCap = LineCap.Round,
            EndCap = LineCap.Round
        };
        e.Graphics.DrawLine(pen, 16, 16, Width - 16, Height - 16);
        e.Graphics.DrawLine(pen, Width - 16, 16, 16, Height - 16);
    }
}

internal sealed class SmallStarControl : Control
{
    public SmallStarControl()
    {
        BackColor = Color.FromArgb(7, 28, 58);
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                 ControlStyles.OptimizedDoubleBuffer, true);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using var pen = new Pen(Color.FromArgb(255, 187, 43), 2.6f) { LineJoin = LineJoin.Round };
        var pts = MakeStar(new PointF(21, 19), 15, 6.8f);
        e.Graphics.DrawPolygon(pen, pts);
    }

    internal static PointF[] MakeStar(PointF c, float outer, float inner)
    {
        var pts = new PointF[10];
        for (var i = 0; i < 10; i++)
        {
            var a = (-90 + i * 36) * Math.PI / 180.0;
            var r = i % 2 == 0 ? outer : inner;
            pts[i] = new PointF(c.X + (float)Math.Cos(a) * r, c.Y + (float)Math.Sin(a) * r);
        }
        return pts;
    }
}

internal sealed class BrandLogoControl : Control
{
    public BrandLogoControl()
    {
        BackColor = Color.FromArgb(7, 28, 58);
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                 ControlStyles.OptimizedDoubleBuffer, true);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using var pen = new Pen(Color.FromArgb(255, 187, 43), 4.4f)
        {
            LineJoin = LineJoin.Round,
            StartCap = LineCap.Round,
            EndCap = LineCap.Round
        };
        e.Graphics.DrawPolygon(pen, SmallStarControl.MakeStar(new PointF(48, 48), 36, 16));
        e.Graphics.DrawLine(pen, 75, 70, 98, 70);

        using var b = new SolidBrush(Color.FromArgb(255, 187, 43));
        e.Graphics.FillEllipse(b, 101, 66, 8, 8);
        e.Graphics.FillEllipse(b, 115, 66, 8, 8);
        e.Graphics.FillEllipse(b, 129, 66, 8, 8);
    }
}

internal sealed class DividerStarControl : Control
{
    public DividerStarControl()
    {
        BackColor = Color.FromArgb(7, 28, 58);
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                 ControlStyles.OptimizedDoubleBuffer, true);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using var pen = new Pen(Color.FromArgb(73, 130, 232), 2.2f) { LineJoin = LineJoin.Round };
        e.Graphics.DrawPolygon(pen, SmallStarControl.MakeStar(new PointF(21, 19), 13, 5.7f));
    }
}

internal sealed class SaveIdCheckBox : Control
{
    public bool Checked { get; set; }

    public SaveIdCheckBox()
    {
        TabStop = true;
        Cursor = Cursors.Hand;
        ForeColor = Color.White;
        Font = new Font("맑은 고딕", 10.5F);

        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                 ControlStyles.OptimizedDoubleBuffer, true);
        BackColor = Color.FromArgb(7, 28, 58);

        Click += (_, _) => { Checked = !Checked; Invalidate(); };
        KeyDown += (_, e) =>
        {
            if (e.KeyCode != Keys.Space) return;
            Checked = !Checked;
            Invalidate();
            e.SuppressKeyPress = true;
        };
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;

        var box = new RectangleF(1, 4, 27, 27);
        using var path = UiPath.RoundRect(box, 6);
        using var pen = new Pen(Checked ? Color.FromArgb(255, 187, 43) : Color.FromArgb(102, 128, 169), 2);
        e.Graphics.DrawPath(pen, path);

        if (Checked)
        {
            using var checkPen = new Pen(Color.FromArgb(255, 187, 43), 2.4f)
            {
                StartCap = LineCap.Round,
                EndCap = LineCap.Round
            };
            e.Graphics.DrawLines(checkPen, new[] { new Point(7, 17), new Point(13, 23), new Point(23, 11) });
        }

        TextRenderer.DrawText(
            e.Graphics,
            Text,
            Font,
            new Rectangle(40, 0, Width - 40, Height),
            ForeColor,
            TextFormatFlags.Left | TextFormatFlags.VerticalCenter);
    }
}

internal sealed class GoldLoginButton : Button
{
    private bool _hover;

    public GoldLoginButton()
    {
        FlatStyle = FlatStyle.Flat;
        FlatAppearance.BorderSize = 0;
        BackColor = Color.FromArgb(255, 187, 43);
        ForeColor = Color.FromArgb(5, 23, 47);
        Cursor = Cursors.Hand;
        Font = new Font("맑은 고딕", 13F, FontStyle.Bold);
        TabStop = true;

        MouseEnter += (_, _) => { _hover = true; Invalidate(); };
        MouseLeave += (_, _) => { _hover = false; Invalidate(); };
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;

        var rect = new RectangleF(0, 0, Width - 1, Height - 1);
        using var path = UiPath.RoundRect(rect, 15);
        var left = _hover ? Color.FromArgb(255, 196, 55) : Color.FromArgb(255, 183, 38);
        var right = _hover ? Color.FromArgb(255, 213, 105) : Color.FromArgb(255, 206, 84);

        using var fill = new LinearGradientBrush(ClientRectangle, left, right, 0f);
        e.Graphics.FillPath(fill, path);

        TextRenderer.DrawText(
            e.Graphics,
            Text,
            Font,
            ClientRectangle,
            ForeColor,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);

        // Approved sparkle on the right side of the login button.
        var cx = Width - 48;
        var cy = Height / 2;
        using var sparklePen = new Pen(Color.White, 2f)
        {
            StartCap = LineCap.Round,
            EndCap = LineCap.Round
        };
        e.Graphics.DrawLine(sparklePen, cx, cy - 11, cx, cy + 11);
        e.Graphics.DrawLine(sparklePen, cx - 11, cy, cx + 11, cy);
        e.Graphics.DrawLine(sparklePen, cx - 6, cy - 6, cx + 6, cy + 6);
        e.Graphics.DrawLine(sparklePen, cx + 6, cy - 6, cx - 6, cy + 6);

        Region = new Region(path);
    }
}

internal sealed class StyledInput : Control
{
    private readonly bool _passwordMode;
    private readonly InputIcon _icon;
    private readonly TextBox _text = new();
    private readonly EyeButton _eye = new();
    private bool _focused;
    private bool _error;
    private bool _showPassword;

    public string Placeholder { get; set; } = "";
    public TextBox InnerTextBox => _text;
    public string TextValue { get => _text.Text; set { _text.Text = value; Invalidate(); } }

    public StyledInput(bool passwordMode, InputIcon icon)
    {
        _passwordMode = passwordMode;
        _icon = icon;

        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                 ControlStyles.OptimizedDoubleBuffer, true);
        BackColor = Color.FromArgb(7, 28, 58);

        _text.BorderStyle = BorderStyle.None;
        _text.BackColor = Color.FromArgb(4, 19, 42);
        _text.ForeColor = Color.White;
        _text.Font = new Font("맑은 고딕", 11.5F);
        _text.Location = new Point(78, 22);
        _text.UseSystemPasswordChar = _passwordMode;
        _text.GotFocus += (_, _) => { _focused = true; Invalidate(); };
        _text.LostFocus += (_, _) => { _focused = false; Invalidate(); };
        _text.TextChanged += (_, _) => Invalidate();
        Controls.Add(_text);

        _eye.Visible = _passwordMode;
        _eye.TabStop = false;
        _eye.Click += (_, _) =>
        {
            _showPassword = !_showPassword;
            _text.UseSystemPasswordChar = _passwordMode && !_showPassword;
            _eye.IsOpen = _showPassword;
            _eye.Invalidate();
            _text.Focus();
        };
        Controls.Add(_eye);

        MouseDown += (_, _) => _text.Focus();
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);

        _text.Width = Width - (_passwordMode ? 145 : 100);
        _eye.Location = new Point(Width - 58, 10);
        _eye.Size = new Size(46, 46);

        using var path = UiPath.RoundRect(new RectangleF(0, 0, Width, Height), 13);
        Region = new Region(path);
    }

    public void FocusInput() => _text.Focus();

    public void SetError(bool value)
    {
        _error = value;
        Invalidate();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;

        using var path = UiPath.RoundRect(new RectangleF(1, 1, Width - 2, Height - 2), 13);
        using var fill = new SolidBrush(Color.FromArgb(4, 19, 42));
        e.Graphics.FillPath(fill, path);

        using var iconBg = new SolidBrush(Color.FromArgb(19, 42, 74));
        e.Graphics.FillRectangle(iconBg, 1, 1, 64, Height - 2);

        var borderColor = _error
            ? Color.FromArgb(255, 95, 95)
            : _focused
                ? Color.FromArgb(60, 139, 255)
                : Color.FromArgb(78, 101, 136);

        using var border = new Pen(borderColor, _focused ? 2f : 1.25f);
        e.Graphics.DrawPath(border, path);

        using var divider = new Pen(Color.FromArgb(52, 78, 113), 1);
        e.Graphics.DrawLine(divider, 65, 8, 65, Height - 8);

        DrawIcon(e.Graphics);

        if (string.IsNullOrEmpty(_text.Text) && !_focused)
        {
            TextRenderer.DrawText(
                e.Graphics,
                Placeholder,
                _text.Font,
                new Rectangle(79, 0, Width - 155, Height),
                Color.FromArgb(131, 145, 170),
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
        }
    }

    private void DrawIcon(Graphics g)
    {
        using var pen = new Pen(Color.FromArgb(190, 202, 226), 2f)
        {
            StartCap = LineCap.Round,
            EndCap = LineCap.Round
        };

        if (_icon == InputIcon.User)
        {
            g.DrawEllipse(pen, 24, 17, 16, 16);
            g.DrawArc(pen, 17, 34, 30, 23, 195, 150);
            return;
        }

        g.DrawArc(pen, 22, 15, 20, 22, 190, 160);
        using var lockPath = UiPath.RoundRect(new RectangleF(18, 31, 28, 23), 5);
        g.DrawPath(pen, lockPath);
        g.DrawLine(pen, 32, 39, 32, 46);
    }
}

internal sealed class EyeButton : Control
{
    public bool IsOpen { get; set; }

    public EyeButton()
    {
        Cursor = Cursors.Hand;
        BackColor = Color.FromArgb(7, 28, 58);
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                 ControlStyles.OptimizedDoubleBuffer, true);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using var pen = new Pen(Color.FromArgb(224, 232, 248), 2f);

        var eye = new GraphicsPath();
        eye.AddBezier(5, Height / 2, 14, 10, Width - 14, 10, Width - 5, Height / 2);
        eye.AddBezier(Width - 5, Height / 2, Width - 14, Height - 10, 14, Height - 10, 5, Height / 2);
        e.Graphics.DrawPath(pen, eye);

        if (IsOpen)
            e.Graphics.FillEllipse(Brushes.White, Width / 2 - 4, Height / 2 - 4, 8, 8);
        else
            e.Graphics.DrawEllipse(pen, Width / 2 - 4, Height / 2 - 4, 8, 8);
    }
}
