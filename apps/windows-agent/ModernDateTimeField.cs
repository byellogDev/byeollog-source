using System.Drawing.Drawing2D;

namespace HurogiCollector;

internal sealed class ModernDateTimeField : Control
{
    internal enum FieldKind { Date, Time }

    private DateTime _value = DateTime.Now;
    private bool _hover;
    private readonly FieldKind _kind;

    public Color SurfaceColor { get; set; } = Color.FromArgb(24, 48, 82);
    public Color BorderColor { get; set; } = Color.FromArgb(251, 190, 55);
    public Color HoverBorderColor { get; set; } = Color.FromArgb(255, 203, 82);
    public Color TextColor { get; set; } = Color.White;
    public Color IconColor { get; set; } = Color.FromArgb(155, 183, 232);

    public DateTime Value
    {
        get => _value;
        set
        {
            _value = value;
            Invalidate();
        }
    }

    public ModernDateTimeField(FieldKind kind)
    {
        _kind = kind;
        Cursor = Cursors.Hand;
        BackColor = Color.FromArgb(17, 37, 67);
        Font = new Font("맑은 고딕", 10.4F, FontStyle.Regular);
        SetStyle(ControlStyles.UserPaint |
                 ControlStyles.AllPaintingInWmPaint |
                 ControlStyles.OptimizedDoubleBuffer, true);

        MouseEnter += (_, _) => { _hover = true; Invalidate(); };
        MouseLeave += (_, _) => { _hover = false; Invalidate(); };
        Click += (_, _) => OpenPicker();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        // 시스템 기본 흰색 컨트롤 표면이 비치지 않도록 전체 사각 영역을
        // 카드 배경색으로 먼저 채운 뒤 내부 rounded field만 그립니다.
        using (var outer = new SolidBrush(Parent?.BackColor ?? SurfaceColor))
            e.Graphics.FillRectangle(outer, ClientRectangle);

        var rect = new RectangleF(2, 2, Width - 4, Height - 4);
        using var path = RoundRect(rect, 10);
        using var fill = new SolidBrush(Enabled ? SurfaceColor : ControlPaint.Dark(SurfaceColor, .05f));
        using var border = new Pen(_hover && Enabled ? HoverBorderColor : BorderColor, _hover && Enabled ? 1.7f : 1.2f);

        e.Graphics.FillPath(fill, path);
        e.Graphics.DrawPath(border, path);

        DrawIcon(e.Graphics);

        var formatted = _kind == FieldKind.Date ? _value.ToString("yyyy-MM-dd") : _value.ToString("HH:mm");
        var textRect = new Rectangle(47, 0, Math.Max(30, Width - 73), Height);
        TextRenderer.DrawText(
            e.Graphics,
            formatted,
            Font,
            textRect,
            Enabled ? TextColor : Color.FromArgb(130, TextColor),
            TextFormatFlags.Left | TextFormatFlags.VerticalCenter);

        using var chevron = new Pen(IconColor, 1.7f) { StartCap = LineCap.Round, EndCap = LineCap.Round };
        var cx = Width - 18;
        var cy = Height / 2 - 1;
        e.Graphics.DrawLine(chevron, cx - 4, cy - 2, cx, cy + 2);
        e.Graphics.DrawLine(chevron, cx, cy + 2, cx + 4, cy - 2);
    }

    private void DrawIcon(Graphics g)
    {
        using var pen = new Pen(IconColor, 1.8f) { StartCap = LineCap.Round, EndCap = LineCap.Round };

        if (_kind == FieldKind.Date)
        {
            var r = new Rectangle(15, 12, 20, 18);
            g.DrawRoundedRectangle(pen, r, 3);
            g.DrawLine(pen, 15, 18, 35, 18);
            g.DrawLine(pen, 20, 9, 20, 14);
            g.DrawLine(pen, 30, 9, 30, 14);
            return;
        }

        g.DrawEllipse(pen, 15, 11, 22, 22);
        g.DrawLine(pen, 26, 16, 26, 23);
        g.DrawLine(pen, 26, 23, 31, 26);
    }

    private void OpenPicker()
    {
        if (!Enabled) return;

        if (_kind == FieldKind.Date)
        {
            using var popup = new Form
            {
                Text = "날짜 선택",
                FormBorderStyle = FormBorderStyle.FixedDialog,
                StartPosition = FormStartPosition.CenterParent,
                MaximizeBox = false,
                MinimizeBox = false,
                ShowInTaskbar = false,
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink,
                Padding = new Padding(10)
            };
            var cal = new MonthCalendar
            {
                MaxSelectionCount = 1,
                SelectionStart = _value.Date,
                SelectionEnd = _value.Date
            };
            cal.DateSelected += (_, e) =>
            {
                _value = new DateTime(e.Start.Year, e.Start.Month, e.Start.Day, _value.Hour, _value.Minute, 0);
                Invalidate();
                popup.Close();
            };
            popup.Controls.Add(cal);
            popup.ShowDialog(FindForm());
            return;
        }

        using var timePopup = new Form
        {
            Text = "시간 선택",
            FormBorderStyle = FormBorderStyle.FixedDialog,
            StartPosition = FormStartPosition.CenterParent,
            MaximizeBox = false,
            MinimizeBox = false,
            ShowInTaskbar = false,
            ClientSize = new Size(250, 125),
            Font = new Font("맑은 고딕", 10F)
        };

        var hour = new NumericUpDown
        {
            Minimum = 0, Maximum = 23, Value = _value.Hour,
            Width = 74, Height = 34, Location = new Point(28, 25),
            Font = new Font("맑은 고딕", 11F)
        };
        var colon = new Label
        {
            Text = ":",
            AutoSize = true,
            Location = new Point(112, 31),
            Font = new Font("맑은 고딕", 12F, FontStyle.Bold)
        };
        var minute = new NumericUpDown
        {
            Minimum = 0, Maximum = 59, Value = _value.Minute,
            Width = 74, Height = 34, Location = new Point(134, 25),
            Font = new Font("맑은 고딕", 11F)
        };
        var ok = new Button
        {
            Text = "확인",
            Width = 90, Height = 34,
            Location = new Point(80, 76),
            DialogResult = DialogResult.OK
        };

        timePopup.Controls.Add(hour);
        timePopup.Controls.Add(colon);
        timePopup.Controls.Add(minute);
        timePopup.Controls.Add(ok);
        timePopup.AcceptButton = ok;

        if (timePopup.ShowDialog(FindForm()) == DialogResult.OK)
        {
            _value = new DateTime(_value.Year, _value.Month, _value.Day, (int)hour.Value, (int)minute.Value, 0);
            Invalidate();
        }
    }

    private static GraphicsPath RoundRect(RectangleF r, float radius)
    {
        var path = new GraphicsPath();
        var d = radius * 2f;
        path.AddArc(r.X, r.Y, d, d, 180, 90);
        path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }
}

internal static class ModernGraphicsExtensions
{
    public static void DrawRoundedRectangle(this Graphics g, Pen pen, Rectangle rect, int radius)
    {
        using var p = new GraphicsPath();
        var d = radius * 2;
        p.AddArc(rect.X, rect.Y, d, d, 180, 90);
        p.AddArc(rect.Right - d, rect.Y, d, d, 270, 90);
        p.AddArc(rect.Right - d, rect.Bottom - d, d, d, 0, 90);
        p.AddArc(rect.X, rect.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        g.DrawPath(pen, p);
    }
}
