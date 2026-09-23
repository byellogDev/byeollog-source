using Microsoft.Win32;

namespace HurogiCollector;

/// <summary>
/// Keeps the compact borderless 420×560 status window inside the current monitor's working area.
/// The controller reacts to resolution, taskbar, DPI and monitor changes.
/// </summary>
internal sealed class AdaptiveWindowController : IDisposable
{
    internal const int DesignWidth = 420;
    internal const int DesignHeight = 560;
    private const int ScreenMargin = 18;

    private readonly Form _form;
    private string _screenDevice = "";
    private bool _disposed;
    private bool _applying;
    private bool _centerOnFirstShown = true;

    internal AdaptiveWindowController(Form form)
    {
        _form = form;
        _form.AutoScaleMode = AutoScaleMode.None;
        _form.MinimumSize = Size.Empty;
        _form.MaximumSize = Size.Empty;
        _form.DpiChanged += Form_DpiChanged;
        _form.LocationChanged += Form_LocationChanged;
        _form.Shown += Form_Shown;
        SystemEvents.DisplaySettingsChanged += DisplaySettingsChanged;
        SystemEvents.UserPreferenceChanged += UserPreferenceChanged;
        Apply(center: true);
    }

    private void Form_Shown(object? sender, EventArgs e) => Apply(center: _centerOnFirstShown);
    private void Form_DpiChanged(object? sender, DpiChangedEventArgs e) => Apply(center: false);
    private void Form_LocationChanged(object? sender, EventArgs e)
    {
        var device = Screen.FromControl(_form).DeviceName;
        if (string.Equals(device, _screenDevice, StringComparison.Ordinal)) return;
        _screenDevice = device;
        Apply(center: false);
    }
    private void DisplaySettingsChanged(object? sender, EventArgs e) => ApplyOnUiThread(center: true);
    private void UserPreferenceChanged(object? sender, UserPreferenceChangedEventArgs e) => ApplyOnUiThread(center: false);

    private void ApplyOnUiThread(bool center)
    {
        if (_disposed || _form.IsDisposed) return;
        try
        {
            if (_form.InvokeRequired) _form.BeginInvoke(new Action(() => Apply(center)));
            else Apply(center);
        }
        catch (InvalidOperationException) { }
    }

    internal void Apply(bool center)
    {
        if (_disposed || _applying || _form.IsDisposed || _form.WindowState == FormWindowState.Minimized) return;
        _applying = true;
        try
        {
            var working = Screen.FromControl(_form).WorkingArea;
            _screenDevice = Screen.FromControl(_form).DeviceName;
            var dpiScale = Math.Max(1d, _form.DeviceDpi / 96d);
            var preferredWidth = DesignWidth * dpiScale;
            var preferredHeight = DesignHeight * dpiScale;
            var availableWidth = Math.Max(320, working.Width - ScreenMargin * 2);
            var availableHeight = Math.Max(420, working.Height - ScreenMargin * 2);
            var fit = Math.Min(1d, Math.Min(availableWidth / preferredWidth, availableHeight / preferredHeight));
            var target = new Size(
                Math.Max(320, (int)Math.Floor(preferredWidth * fit)),
                Math.Max(420, (int)Math.Floor(preferredHeight * fit)));

            _form.ClientSize = target;
            if (center || !_form.Bounds.IntersectsWith(working))
            {
                _form.Location = new Point(
                    working.Left + Math.Max(0, (working.Width - _form.Width) / 2),
                    working.Top + Math.Max(0, (working.Height - _form.Height) / 2));
            }
        }
        finally
        {
            _applying = false;
        }
    }

    internal void PreserveCurrentLocationOnFirstShow()
    {
        _centerOnFirstShown = false;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _form.DpiChanged -= Form_DpiChanged;
        _form.LocationChanged -= Form_LocationChanged;
        _form.Shown -= Form_Shown;
        SystemEvents.DisplaySettingsChanged -= DisplaySettingsChanged;
        SystemEvents.UserPreferenceChanged -= UserPreferenceChanged;
    }
}
