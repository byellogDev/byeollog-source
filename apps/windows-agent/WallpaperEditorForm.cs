using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace HurogiCollector;

/// <summary>Local-only wallpaper editor backed by the localhost overlay.</summary>
internal sealed class WallpaperEditorForm : Form
{
    private const string LocalHost = "byeollog-wallpaper.local";
    private readonly VNextLocalAgent _agent;
    private readonly CollectorStorage _storage;
    private readonly CoreWebView2Environment _environment;
    private readonly string _uiRoot;
    private readonly WebView2 _web = new() { Dock = DockStyle.Fill };
    private readonly Panel _loading = new() { Dock = DockStyle.Fill, BackColor = Color.FromArgb(246, 248, 252) };
    private readonly CancellationTokenSource _lifetime = new();
    private bool _started;
    private bool _closing;
    private string _documentId = Guid.NewGuid().ToString("N");
    private string _documentWorkspaceId = "";

    internal WallpaperEditorForm(VNextLocalAgent agent, CollectorStorage storage,
        CoreWebView2Environment environment, string uiRoot, Icon? appIcon)
    {
        _agent = agent;
        _storage = storage;
        _environment = environment;
        _uiRoot = uiRoot;
        Text = "별록 풍벽지 · 로컬 배치 편집";
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(1180, 760);
        Size = new Size(1540, 940);
        BackColor = Color.FromArgb(246, 248, 252);
        if (appIcon is not null) Icon = appIcon;
        var loadingText = new Label
        {
            AutoSize = true, Text = "로컬 풍벽지 편집기를 여는 중입니다…",
            Font = new Font("Malgun Gothic", 13F, FontStyle.Bold),
            ForeColor = Color.FromArgb(15, 35, 66), BackColor = Color.Transparent
        };
        _loading.Controls.Add(loadingText);
        _loading.Resize += (_, _) =>
        {
            loadingText.Left = Math.Max(20, (_loading.ClientSize.Width - loadingText.Width) / 2);
            loadingText.Top = Math.Max(20, (_loading.ClientSize.Height - loadingText.Height) / 2);
        };
        Controls.Add(_web);
        Controls.Add(_loading);
        _loading.BringToFront();
        Shown += WallpaperEditorForm_Shown;
        FormClosing += WallpaperEditorForm_FormClosing;
        _agent.WallpaperEditorStateChanged += Agent_WallpaperEditorStateChanged;
        _agent.WallpaperWorkspaceChanged += Agent_WallpaperWorkspaceChanged;
    }

    private async void WallpaperEditorForm_Shown(object? sender, EventArgs e)
    {
        if (_started || _closing) return;
        _started = true;
        try { await InitializeAsync(); }
        catch (OperationCanceledException) when (_closing || _lifetime.IsCancellationRequested) { }
        catch (Exception ex)
        {
            _storage.Log($"Local wallpaper editor open failed: type={ex.GetType().Name} hresult=0x{ex.HResult:X8}");
            if (!_closing)
            {
                MessageBox.Show("풍벽지 편집기를 열지 못했습니다.\n\n" + ex.Message,
                    "별록 풍벽지", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                Close();
            }
        }
    }

    private async Task InitializeAsync()
    {
        await _web.EnsureCoreWebView2Async(_environment);
        _lifetime.Token.ThrowIfCancellationRequested();
        var core = _web.CoreWebView2;
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsZoomControlEnabled = true;
        core.Settings.AreHostObjectsAllowed = false;
        core.Settings.IsWebMessageEnabled = true;
        core.SetVirtualHostNameToFolderMapping(LocalHost, _uiRoot, CoreWebView2HostResourceAccessKind.DenyCors);
        core.WebMessageReceived += Core_WebMessageReceived;
        core.NavigationStarting += Core_NavigationStarting;
        core.FrameNavigationStarting += Core_NavigationStarting;
        core.NavigationCompleted += Core_NavigationCompleted;
        core.NewWindowRequested += Core_NewWindowRequested;
        core.PermissionRequested += Core_PermissionRequested;
        core.DownloadStarting += Core_DownloadStarting;
        NavigateCurrentWorkspace();
    }

    private static bool TrustedSource(string? raw) =>
        Uri.TryCreate(raw, UriKind.Absolute, out var uri)
        && uri.Scheme == Uri.UriSchemeHttps
        && uri.IdnHost.Equals(LocalHost, StringComparison.OrdinalIgnoreCase)
        && uri.IsDefaultPort;

    private async void Core_WebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!TrustedSource(e.Source)) return;
        var documentId = _documentId;
        string id = "";
        try
        {
            using var document = JsonDocument.Parse(e.WebMessageAsJson);
            var root = document.RootElement;
            if (!root.TryGetProperty("documentId", out var requestedDocument)
                || requestedDocument.GetString() != documentId
                || _documentWorkspaceId != _agent.WallpaperWorkspaceId) return;
            id = root.GetProperty("id").GetString() ?? "";
            if (root.GetProperty("type").GetString() != "wallpaper-editor-request" || id.Length > 40) return;
            var operation = root.GetProperty("operation").GetString();
            JsonElement data;
            if (operation == "wallpaper-refresh")
                data = await _agent.RefreshWallpaperEditorStateAsync(_lifetime.Token);
            else if (operation == "wallpaper-control")
            {
                var method = root.TryGetProperty("method", out var methodValue) ? methodValue.GetString() : "GET";
                data = string.Equals(method, "POST", StringComparison.OrdinalIgnoreCase)
                    ? await _agent.ApplyWallpaperEditorControlAsync(root.GetProperty("body").Clone(), _lifetime.Token)
                    : await _agent.GetWallpaperEditorStateAsync(_lifetime.Token);
            }
            else if (operation == "context")
                data = JsonSerializer.SerializeToElement(new { streamer_name = "로컬 편집기" });
            else if (operation == "soop-runtime-status")
                data = JsonSerializer.SerializeToElement(new { ok = true, connected = false });
            else if (operation == "wallpaper-image-mask")
            {
                var body = root.GetProperty("body");
                var url = body.TryGetProperty("url", out var urlValue) ? urlValue.GetString() ?? "" : "";
                var mask = _agent.CreateWallpaperImageMask(url);
                data = JsonSerializer.SerializeToElement(new
                {
                    width = mask.Width, height = mask.Height,
                    maskWidth = mask.MaskWidth, maskHeight = mask.MaskHeight,
                    alpha = mask.Alpha, density = mask.Density
                });
            }
            else throw new InvalidOperationException("이 기능은 로컬 풍벽지 편집기에서 사용할 수 없습니다.");
            if (documentId == _documentId && _documentWorkspaceId == _agent.WallpaperWorkspaceId)
                PostResponse(new { id, ok = true, data });
        }
        catch (OperationCanceledException) when (_closing || _lifetime.IsCancellationRequested) { }
        catch (Exception ex)
        {
            if (documentId != _documentId || _documentWorkspaceId != _agent.WallpaperWorkspaceId) return;
            var requestError = ex as VNextDevelopmentException;
            _storage.Log("Local wallpaper editor request failed: type=" + ex.GetType().Name
                + " status=" + (requestError?.StatusCode?.ToString() ?? "0")
                + " code=" + (requestError?.Code ?? "local_editor_request_failed"));
            PostResponse(new
            {
                id,
                ok = false,
                status = requestError?.StatusCode ?? 0,
                code = requestError?.Code ?? "local_editor_request_failed",
                message = ex.Message
            });
        }
    }

    private void PostResponse(object value)
    {
        if (_closing || _web.CoreWebView2 is null) return;
        try { _web.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(value)); }
        catch (InvalidOperationException) { }
    }

    private void Agent_WallpaperEditorStateChanged()
    {
        if (_closing || !IsHandleCreated) return;
        try { BeginInvoke(new Action(() => PostResponse(new { type = "wallpaper-editor-state-changed" }))); }
        catch (InvalidOperationException) { }
    }

    private void NavigateCurrentWorkspace()
    {
        _documentId = Guid.NewGuid().ToString("N");
        _documentWorkspaceId = _agent.WallpaperWorkspaceId;
        _web.Source = new Uri($"https://{LocalHost}/wallpaper_editor.html?document={_documentId}");
    }

    private void Agent_WallpaperWorkspaceChanged()
    {
        if (_closing || !IsHandleCreated) return;
        try
        {
            BeginInvoke(new Action(() =>
            {
                if (_closing || _web.CoreWebView2 is null || _documentWorkspaceId == _agent.WallpaperWorkspaceId) return;
                // A new document discards old drafts, timers and request IDs.
                // Durable edits remain in the previous workspace's local cache.
                NavigateCurrentWorkspace();
            }));
        }
        catch (InvalidOperationException) { }
    }

    private void Core_NavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (TrustedSource(e.Uri)) return;
        e.Cancel = true;
        _storage.Log("Local wallpaper editor navigation blocked: " + WebViewTrustPolicy.SafeOriginForLog(e.Uri));
    }

    private void Core_NavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (!e.IsSuccess || _closing) return;
        _loading.Visible = false;
        _web.Focus();
    }

    private static void Core_NewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e) => e.Handled = true;
    private static void Core_DownloadStarting(object? sender, CoreWebView2DownloadStartingEventArgs e) => e.Cancel = true;
    private static void Core_PermissionRequested(object? sender, CoreWebView2PermissionRequestedEventArgs e)
    {
        e.State = CoreWebView2PermissionState.Deny;
        e.SavesInProfile = false;
        e.Handled = true;
    }

    private void WallpaperEditorForm_FormClosing(object? sender, FormClosingEventArgs e)
    {
        if (_closing) return;
        _closing = true;
        try { _lifetime.Cancel(); } catch { }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _agent.WallpaperEditorStateChanged -= Agent_WallpaperEditorStateChanged;
            _agent.WallpaperWorkspaceChanged -= Agent_WallpaperWorkspaceChanged;
            try { _lifetime.Cancel(); } catch { }
            _lifetime.Dispose();
            _web.Dispose();
        }
        base.Dispose(disposing);
    }
}
