using System.Text.Json;

namespace HurogiCollector;

internal sealed class WeflabSettingsForm : Form
{
    private readonly VNextDevelopmentClient _client;
    private readonly string _workspace;
    private readonly long _epoch;
    private readonly TextBox _url = new() { Dock = DockStyle.Fill, PlaceholderText = "후원알림 오버레이 주소를 붙여넣으세요", MaxLength = 256 };
    private readonly Label _status = new() { Dock = DockStyle.Fill, AutoSize = true };
    private readonly Button _save = new() { Text = "저장", AutoSize = true };
    internal WeflabSettingsForm(VNextDevelopmentClient client)
    {
        _client = client; _workspace = client.WorkspaceId; _epoch = client.CaptureSessionEpoch();
        Text = "후원알림 오버레이 설정"; StartPosition = FormStartPosition.CenterParent;
        ClientSize = new Size(600, 310); MinimumSize = new Size(560, 350);
        Font = new Font("맑은 고딕", 10); BackColor = Color.FromArgb(25, 27, 45); ForeColor = Color.WhiteSmoke;
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(24), ColumnCount = 1, RowCount = 5 };
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 36));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 76));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
        layout.Controls.Add(new Label { Text = "후원알림 오버레이 주소", AutoSize = true });
        layout.Controls.Add(_url);
        layout.Controls.Add(new Label { Dock = DockStyle.Fill, Text = "업보 수집을 켜려면 이 주소가 필요합니다.\n웹 대시보드의 ‘업보 수집 설정’에서 ON/OFF를 설정하세요.\n이곳에 주소를 저장하는 것만으로 수집이 켜지지는 않습니다." });
        layout.Controls.Add(_status);
        var buttons = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft };
        var close = new Button { Text = "닫기", AutoSize = true }; close.Click += (_, _) => Close();
        buttons.Controls.Add(close); buttons.Controls.Add(_save); layout.Controls.Add(buttons); Controls.Add(layout);
        _save.Enabled = false;
        Shown += async (_, _) => await LoadAsync();
        _save.Click += async (_, _) => await SaveAsync();
    }
    private async Task<JsonElement> RequestAsync(object request)
    {
        if (!_client.IsSessionEpochCurrent(_epoch) || _client.WorkspaceId != _workspace) throw new InvalidOperationException();
        var result = await _client.WeflabTrialRpcAsync(_workspace, _epoch, request, CancellationToken.None);
        if (!_client.IsSessionEpochCurrent(_epoch) || _client.WorkspaceId != _workspace) throw new InvalidOperationException();
        return result;
    }
    private async Task LoadAsync()
    {
        try
        {
            var result = await RequestAsync(new { action = "settings_get" });
            if (IsDisposed) return;
            _url.Text = WeflabTrialProtocol.Text(result, "url"); ShowStatus(result); _save.Enabled = true;
        }
        catch { if (!IsDisposed) _status.Text = "설정을 읽지 못했습니다. 로그인·연결 상태를 확인해 주세요."; }
    }
    private async Task SaveAsync()
    {
        var url = _url.Text.Trim();
        if (url.Length > 0 && !System.Text.RegularExpressions.Regex.IsMatch(url, @"\Ahttps://weflab\.com/page/[A-Za-z0-9]+\z"))
        { _status.Text = "현재 연결을 지원하지 않는 주소입니다. 후원알림 오버레이 주소인지 확인해주세요."; return; }
        _save.Enabled = false;
        try
        {
            var result = await RequestAsync(new { action = "settings_save", url });
            _client.NotifyWeflabSettingsChanged();
            if (!IsDisposed) ShowStatus(result);
        }
        catch { if (!IsDisposed) _status.Text = "저장하지 못했습니다. 입력한 주소는 유지됩니다."; }
        finally { if (!IsDisposed) _save.Enabled = true; }
    }
    private void ShowStatus(JsonElement result)
    {
        _status.Text = WeflabTrialProtocol.Text(result, "url") == "" ? "주소 미설정 · 웹에서 업보 수집 설정을 확인해주세요." :
            result.TryGetProperty("active", out var active) && active.ValueKind == JsonValueKind.True
                ? "설정됨 · 별도 비교 수집 중 (PC 준비 시 PC 우선)"
                : "주소 저장됨 · 비교 수집은 대상 계정 등록 후 시작됩니다.";
    }
}
