using System.Drawing.Drawing2D;

namespace HurogiCollector;

internal sealed class HeaderBrandMarkControl : Control
{
    public Color AccentColor { get; set; } = Color.FromArgb(251, 190, 55);
    public Color SurfaceColor { get; set; } = Color.FromArgb(8, 21, 43);

    public HeaderBrandMarkControl()
    {
        SetStyle(ControlStyles.UserPaint |
                 ControlStyles.AllPaintingInWmPaint |
                 ControlStyles.OptimizedDoubleBuffer, true);
        DoubleBuffered = true;
        BackColor = Color.FromArgb(8, 21, 43);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;

        // Transparent BackColor을 사용하지 않습니다.
        // MainForm과 같은 색으로 컨트롤 전체를 직접 채워 런타임 예외를 방지합니다.
        using (var bg = new SolidBrush(SurfaceColor))
            e.Graphics.FillRectangle(bg, ClientRectangle);

        using var pen = new Pen(AccentColor, 4.2f)
        {
            LineJoin = LineJoin.Round,
            StartCap = LineCap.Round,
            EndCap = LineCap.Round
        };

        var center = new PointF(34, 33);
        var pts = new PointF[10];
        for (var i = 0; i < 10; i++)
        {
            var angle = (-90 + i * 36) * Math.PI / 180.0;
            var radius = i % 2 == 0 ? 25f : 11f;
            pts[i] = new PointF(
                center.X + (float)Math.Cos(angle) * radius,
                center.Y + (float)Math.Sin(angle) * radius);
        }

        e.Graphics.DrawPolygon(pen, pts);
        e.Graphics.DrawLine(pen, 54, 50, 75, 50);

        using var brush = new SolidBrush(AccentColor);
        e.Graphics.FillEllipse(brush, 78, 46, 8, 8);
        e.Graphics.FillEllipse(brush, 91, 46, 8, 8);
        e.Graphics.FillEllipse(brush, 104, 46, 8, 8);
    }
}

internal sealed class HeaderIconButton : Control
{
    internal enum IconKind { Minimize, Theme, Tray }

    private readonly IconKind _kind;
    private bool _hover;

    public Color SurfaceColor { get; set; } = Color.FromArgb(8, 21, 43);
    public Color HoverColor { get; set; } = Color.FromArgb(31, 58, 94);
    public Color BorderColor { get; set; } = Color.FromArgb(58, 84, 120);
    public Color IconColor { get; set; } = Color.White;
    public Color AccentColor { get; set; } = Color.FromArgb(251, 190, 55);
    public bool DarkMode { get; set; } = true;

    public HeaderIconButton(IconKind kind)
    {
        _kind = kind;
        Cursor = Cursors.Hand;
        DoubleBuffered = true;
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                 ControlStyles.OptimizedDoubleBuffer, true);

        MouseEnter += (_, _) => { _hover = true; Invalidate(); };
        MouseLeave += (_, _) => { _hover = false; Invalidate(); };
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;

        var rect = new RectangleF(1, 1, Width - 2, Height - 2);
        using var path = RoundRect(rect, 12);
        using var fill = new SolidBrush(_hover ? HoverColor : SurfaceColor);
        using var border = new Pen(BorderColor, 1.2f);
        e.Graphics.FillPath(fill, path);
        e.Graphics.DrawPath(border, path);

        switch (_kind)
        {
            case IconKind.Minimize:
                DrawMinimize(e.Graphics);
                break;
            case IconKind.Theme:
                DrawTheme(e.Graphics);
                break;
            case IconKind.Tray:
                DrawTray(e.Graphics);
                break;
        }
    }

    private void DrawMinimize(Graphics g)
    {
        using var pen = new Pen(IconColor, 2.3f)
        {
            StartCap = LineCap.Round,
            EndCap = LineCap.Round
        };
        g.DrawLine(pen, 17, 25, Width - 17, 25);
    }

    private void DrawTheme(Graphics g)
    {
        var cx = Width / 2f;
        var cy = Height / 2f;

        if (DarkMode)
        {
            using var sun = new Pen(AccentColor, 2f);
            using var fill = new SolidBrush(AccentColor);
            g.FillEllipse(fill, cx - 6, cy - 6, 12, 12);
            for (var i = 0; i < 8; i++)
            {
                var a = i * Math.PI / 4;
                var x1 = cx + (float)Math.Cos(a) * 10;
                var y1 = cy + (float)Math.Sin(a) * 10;
                var x2 = cx + (float)Math.Cos(a) * 14;
                var y2 = cy + (float)Math.Sin(a) * 14;
                g.DrawLine(sun, x1, y1, x2, y2);
            }
        }
        else
        {
            using var moon = new SolidBrush(IconColor);
            g.FillEllipse(moon, cx - 9, cy - 9, 18, 18);
            using var cut = new SolidBrush(_hover ? HoverColor : SurfaceColor);
            g.FillEllipse(cut, cx - 3, cy - 11, 18, 18);
        }
    }

    private void DrawTray(Graphics g)
    {
        using var pen = new Pen(IconColor, 2.1f)
        {
            StartCap = LineCap.Round,
            EndCap = LineCap.Round,
            LineJoin = LineJoin.Round
        };

        var cx = Width / 2;
        g.DrawLine(pen, cx, 14, cx, 29);
        g.DrawLine(pen, cx, 29, cx - 6, 23);
        g.DrawLine(pen, cx, 29, cx + 6, 23);
        g.DrawLine(pen, 15, 34, 35, 34);
        g.DrawLine(pen, 15, 34, 15, 29);
        g.DrawLine(pen, 35, 34, 35, 29);
    }

    private static GraphicsPath RoundRect(RectangleF r, float radius)
    {
        var p = new GraphicsPath();
        var d = radius * 2;
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }
}
