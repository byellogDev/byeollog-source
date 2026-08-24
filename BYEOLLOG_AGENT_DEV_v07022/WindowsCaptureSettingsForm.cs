using System.Runtime.InteropServices;

namespace HurogiCollector;

internal sealed class WindowsCaptureSettingsForm : Form
{
    private readonly CollectorStorage _storage;
    private readonly CheckBox _enabled = new();
    private readonly ComboBox _devices = new();
    private readonly Label _status = new();
    private readonly Button _refresh = new();
    private readonly Button _test = new();
    private readonly Button _save = new();

    public WindowsCaptureSettingsForm(CollectorStorage storage)
    {
        _storage = storage;
        Text = "Windows 마이크 설정";
        StartPosition = FormStartPosition.CenterParent;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ShowInTaskbar = false;
        ClientSize = new Size(580, 390);
        Font = new Font("맑은 고딕", 10F);
        BackColor = Color.FromArgb(245, 247, 251);
        ForeColor = Color.FromArgb(20, 31, 48);

        Controls.Add(new Label
        {
            Text = "Windows 캡처 장치 음소거",
            Font = new Font(Font, FontStyle.Bold),
            Location = new Point(28, 24),
            AutoSize = true
        });
        Controls.Add(new Label
        {
            Text = "선택한 입력 장치를 Windows에서 직접 음소거합니다.\n이 상태는 해당 장치를 쓰는 모든 앱에 적용되므로 원래 상태 복구를 항상 확인합니다.",
            Location = new Point(28, 58),
            Size = new Size(524, 52),
            ForeColor = Color.FromArgb(82, 94, 112)
        });

        _enabled.Text = "Windows 마이크 제어 사용";
        _enabled.Location = new Point(28, 120);
        _enabled.AutoSize = true;
        Controls.Add(_enabled);

        Controls.Add(new Label
        {
            Text = "캡처 장치",
            Location = new Point(28, 164),
            Size = new Size(126, 30),
            TextAlign = ContentAlignment.MiddleLeft
        });
        _devices.DropDownStyle = ComboBoxStyle.DropDownList;
        _devices.Location = new Point(154, 164);
        _devices.Size = new Size(398, 30);
        Controls.Add(_devices);

        _refresh.Text = "장치 새로고침";
        _refresh.Location = new Point(28, 214);
        _refresh.Size = new Size(132, 40);
        _refresh.Click += async (_, _) => await LoadDevicesAsync(preserveSelection: true);
        Controls.Add(_refresh);

        _test.Text = "현재 상태 확인";
        _test.Location = new Point(176, 214);
        _test.Size = new Size(132, 40);
        _test.Click += async (_, _) => await TestAsync();
        Controls.Add(_test);

        _status.Location = new Point(28, 270);
        _status.Size = new Size(524, 54);
        _status.ForeColor = Color.FromArgb(82, 94, 112);
        Controls.Add(_status);

        var cancel = new Button
        {
            Text = "취소",
            Location = new Point(326, 330),
            Size = new Size(104, 42),
            DialogResult = DialogResult.Cancel
        };
        Controls.Add(cancel);

        _save.Text = "저장";
        _save.Location = new Point(448, 330);
        _save.Size = new Size(104, 42);
        _save.Click += (_, _) => SaveAndClose();
        Controls.Add(_save);

        AcceptButton = _save;
        CancelButton = cancel;
        Shown += async (_, _) => await InitializeAsync();
    }

    private async Task InitializeAsync()
    {
        var settings = _storage.LoadWindowsCaptureSettings();
        _enabled.Checked = settings.Enabled;
        await LoadDevicesAsync(preserveSelection: false, settings.EndpointId, settings.EndpointName);
    }

    private async Task LoadDevicesAsync(
        bool preserveSelection,
        string? requestedId = null,
        string? requestedName = null)
    {
        var selectedId = preserveSelection
            ? (_devices.SelectedItem as WindowsCaptureEndpoint)?.Id
            : requestedId;
        SetBusy(true, "Windows 캡처 장치를 읽는 중…");
        try
        {
            var endpoints = await Task.Run(CoreAudioCaptureAdapter.ListActiveEndpoints);
            _devices.Items.Clear();
            foreach (var endpoint in endpoints) _devices.Items.Add(endpoint);

            var selected = endpoints.FirstOrDefault(x =>
                string.Equals(x.Id, selectedId, StringComparison.Ordinal));
            if (selected is null && !string.IsNullOrWhiteSpace(selectedId))
            {
                selected = new WindowsCaptureEndpoint(
                    selectedId,
                    string.IsNullOrWhiteSpace(requestedName) ? "저장된 장치 (현재 연결 안 됨)" : requestedName + " (현재 연결 안 됨)",
                    false);
                _devices.Items.Add(selected);
            }
            _devices.SelectedItem = selected ?? endpoints.FirstOrDefault();
            _status.Text = endpoints.Count == 0
                ? "활성 캡처 장치를 찾지 못했습니다."
                : $"활성 캡처 장치 {endpoints.Count}개를 찾았습니다. 상태 확인은 장치를 변경하지 않습니다.";
            _status.ForeColor = endpoints.Count == 0
                ? Color.FromArgb(184, 91, 40)
                : Color.FromArgb(82, 94, 112);
        }
        catch (Exception ex)
        {
            _devices.Items.Clear();
            _status.Text = SafeMessage(ex);
            _status.ForeColor = Color.FromArgb(184, 91, 40);
        }
        finally
        {
            SetBusy(false, null);
        }
    }

    private async Task TestAsync()
    {
        if (_devices.SelectedItem is not WindowsCaptureEndpoint selected)
        {
            _status.Text = "확인할 캡처 장치를 선택해주세요.";
            _status.ForeColor = Color.FromArgb(184, 91, 40);
            return;
        }

        SetBusy(true, "선택한 장치의 음소거 상태를 읽는 중…");
        try
        {
            var muted = await Task.Run(() => CoreAudioCaptureAdapter.GetMute(selected.Id));
            _status.Text = $"상태 확인 성공 · 현재 Windows 음소거 {(muted ? "켜짐" : "꺼짐")} · 상태 변경 없음";
            _status.ForeColor = Color.FromArgb(23, 126, 79);
        }
        catch (Exception ex)
        {
            _status.Text = SafeMessage(ex);
            _status.ForeColor = Color.FromArgb(184, 91, 40);
        }
        finally
        {
            SetBusy(false, null);
        }
    }

    private void SaveAndClose()
    {
        if (_enabled.Checked && _devices.SelectedItem is not WindowsCaptureEndpoint)
        {
            _status.Text = "Windows 마이크 제어를 사용하려면 캡처 장치를 선택해주세요.";
            _status.ForeColor = Color.FromArgb(184, 91, 40);
            return;
        }

        var selected = _devices.SelectedItem as WindowsCaptureEndpoint;
        _storage.SaveWindowsCaptureSettings(new WindowsCaptureSettings(
            _enabled.Checked,
            selected?.Id ?? "",
            selected?.FriendlyName ?? ""));
        DialogResult = DialogResult.OK;
        Close();
    }

    private void SetBusy(bool busy, string? message)
    {
        _refresh.Enabled = !busy;
        _test.Enabled = !busy;
        _save.Enabled = !busy;
        _devices.Enabled = !busy;
        if (message is not null)
        {
            _status.Text = message;
            _status.ForeColor = Color.FromArgb(82, 94, 112);
        }
    }

    private static string SafeMessage(Exception ex)
    {
        if (ex is CoreAudioCaptureException coreAudio)
        {
            var root = coreAudio.InnerException ?? coreAudio;
            return $"{coreAudio.Step} 실패 · {root.GetType().Name} · 0x{root.HResult:X8}\n장치 새로고침 후 같은 문구를 전달해주세요.";
        }

        return ex switch
        {
            COMException com => $"Windows 캡처 장치 접근 실패 · 0x{com.HResult:X8}\n장치 연결과 Windows 오디오 서비스를 확인해주세요.",
            PlatformNotSupportedException => "이 기능은 Windows에서만 사용할 수 있습니다.",
            ArgumentException => "저장된 캡처 장치 정보가 올바르지 않습니다.",
            _ => $"Windows 캡처 장치 상태 확인 실패 · {ex.GetType().Name} · 0x{ex.HResult:X8}"
        };
    }
}
