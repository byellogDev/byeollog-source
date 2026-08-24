namespace HurogiCollector;

internal sealed class ObsSettingsForm : Form
{
    private readonly CollectorStorage _storage;
    private readonly CheckBox _enabled = new();
    private readonly NumericUpDown _port = new();
    private readonly TextBox _inputName = new();
    private readonly TextBox _password = new();
    private readonly Label _status = new();
    private readonly Button _test = new();
    private readonly Button _save = new();

    public ObsSettingsForm(CollectorStorage storage)
    {
        _storage = storage;
        Text = "OBS 연결 설정";
        StartPosition = FormStartPosition.CenterParent;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ShowInTaskbar = false;
        ClientSize = new Size(520, 430);
        Font = new Font("맑은 고딕", 10F);
        BackColor = Color.FromArgb(245, 247, 251);
        ForeColor = Color.FromArgb(20, 31, 48);

        var title = new Label
        {
            Text = "OBS WebSocket 5.x",
            Font = new Font(Font, FontStyle.Bold),
            Location = new Point(28, 24),
            AutoSize = true
        };
        Controls.Add(title);

        var description = new Label
        {
            Text = "같은 PC의 OBS(127.0.0.1)에만 연결합니다.\nOBS 도구 → WebSocket 서버 설정에서 서버와 인증을 켜주세요.",
            Location = new Point(28, 58),
            Size = new Size(464, 48),
            ForeColor = Color.FromArgb(82, 94, 112)
        };
        Controls.Add(description);

        _enabled.Text = "OBS 연결 사용";
        _enabled.Location = new Point(28, 116);
        _enabled.AutoSize = true;
        Controls.Add(_enabled);

        AddLabel("포트", 154);
        _port.Location = new Point(184, 148);
        _port.Size = new Size(130, 30);
        _port.Minimum = 1;
        _port.Maximum = 65535;
        _port.Value = 4455;
        Controls.Add(_port);

        AddLabel("마이크 입력 이름", 204);
        _inputName.Location = new Point(184, 198);
        _inputName.Size = new Size(308, 30);
        _inputName.MaxLength = 128;
        _inputName.PlaceholderText = "예: 마이크/Aux";
        Controls.Add(_inputName);

        AddLabel("WebSocket 비밀번호", 254);
        _password.Location = new Point(184, 248);
        _password.Size = new Size(308, 30);
        _password.MaxLength = 256;
        _password.UseSystemPasswordChar = true;
        Controls.Add(_password);

        _status.Location = new Point(28, 296);
        _status.Size = new Size(464, 42);
        _status.ForeColor = Color.FromArgb(82, 94, 112);
        Controls.Add(_status);

        _test.Text = "연결 테스트";
        _test.Location = new Point(28, 354);
        _test.Size = new Size(132, 42);
        _test.Click += async (_, _) => await TestAsync();
        Controls.Add(_test);

        var cancel = new Button
        {
            Text = "취소",
            Location = new Point(266, 354),
            Size = new Size(104, 42),
            DialogResult = DialogResult.Cancel
        };
        Controls.Add(cancel);

        _save.Text = "저장";
        _save.Location = new Point(388, 354);
        _save.Size = new Size(104, 42);
        _save.Click += (_, _) => SaveAndClose();
        Controls.Add(_save);

        AcceptButton = _save;
        CancelButton = cancel;
        LoadSettings();
        FormClosed += (_, _) => _password.Clear();
    }

    private void AddLabel(string text, int top)
    {
        Controls.Add(new Label
        {
            Text = text,
            Location = new Point(28, top),
            Size = new Size(144, 28),
            TextAlign = ContentAlignment.MiddleLeft
        });
    }

    private void LoadSettings()
    {
        var settings = _storage.LoadObsSettings();
        _enabled.Checked = settings.Enabled;
        _port.Value = settings.Port;
        _inputName.Text = settings.MicrophoneInputName;
        _password.Text = settings.Password;
    }

    private ObsConnectionSettings CurrentSettings() => new(
        _enabled.Checked,
        decimal.ToInt32(_port.Value),
        _inputName.Text.Trim(),
        _password.Text);

    private bool ValidateSettings(bool requireEnabled)
    {
        if (requireEnabled && !_enabled.Checked)
        {
            _status.Text = "OBS 연결 사용을 먼저 체크해주세요.";
            _status.ForeColor = Color.FromArgb(184, 91, 40);
            return false;
        }
        if (_inputName.Text.Trim().Length == 0)
        {
            _status.Text = "OBS 오디오 믹서에 표시되는 마이크 입력 이름을 입력해주세요.";
            _status.ForeColor = Color.FromArgb(184, 91, 40);
            _inputName.Focus();
            return false;
        }
        return true;
    }

    private async Task TestAsync()
    {
        if (!ValidateSettings(requireEnabled: true)) return;
        _test.Enabled = false;
        _save.Enabled = false;
        _status.Text = "OBS에 연결하는 중…";
        _status.ForeColor = Color.FromArgb(82, 94, 112);
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(6));
            var settings = CurrentSettings();
            await using var obs = await ObsWebSocketClient.ConnectAsync(settings, timeout.Token);
            var info = await obs.GetVersionAsync(timeout.Token);
            if (!info.AvailableRequests.Contains("GetInputMute")
                || !info.AvailableRequests.Contains("SetInputMute"))
                throw new InvalidOperationException("연결된 OBS가 필요한 음소거 요청을 지원하지 않습니다.");
            var muted = await obs.GetInputMuteAsync(settings.MicrophoneInputName, timeout.Token);
            _status.Text = $"연결 성공 · OBS {info.ObsStudioVersion} · 현재 음소거 {(muted ? "켜짐" : "꺼짐")}";
            _status.ForeColor = Color.FromArgb(23, 126, 79);
        }
        catch (OperationCanceledException)
        {
            _status.Text = "OBS 연결 시간이 초과됐습니다.";
            _status.ForeColor = Color.FromArgb(184, 91, 40);
        }
        catch (Exception ex)
        {
            _status.Text = SafeMessage(ex);
            _status.ForeColor = Color.FromArgb(184, 91, 40);
        }
        finally
        {
            _test.Enabled = true;
            _save.Enabled = true;
        }
    }

    private void SaveAndClose()
    {
        if (_enabled.Checked && !ValidateSettings(requireEnabled: true)) return;
        _storage.SaveObsSettings(CurrentSettings());
        _password.Clear();
        DialogResult = DialogResult.OK;
        Close();
    }

    private static string SafeMessage(Exception ex) => ex switch
    {
        ObsAuthenticationException => "OBS WebSocket 비밀번호가 맞지 않습니다.",
        ObsProtocolException protocol => $"OBS WebSocket 연결 협상에 실패했습니다. (code {protocol.CloseCode})",
        ObsRequestException request => $"OBS가 요청을 거부했습니다. (code {request.Code})",
        System.Net.WebSockets.WebSocketException => "OBS에 연결할 수 없습니다. OBS와 WebSocket 서버를 확인해주세요.",
        InvalidDataException => "OBS WebSocket 응답 형식이 올바르지 않습니다.",
        _ => "OBS 연결 테스트 중 오류가 발생했습니다."
    };
}
