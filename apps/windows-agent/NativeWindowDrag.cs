using System.Runtime.InteropServices;

namespace HurogiCollector;

internal static class NativeWindowDrag
{
    private const int WmNcLButtonDown = 0x00A1;
    private const int HtCaption = 0x0002;

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    internal static void Begin(Form form)
    {
        if (form.IsDisposed || !form.IsHandleCreated) return;
        ReleaseCapture();
        SendMessage(form.Handle, WmNcLButtonDown, (IntPtr)HtCaption, IntPtr.Zero);
    }
}
