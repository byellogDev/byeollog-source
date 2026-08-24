using System.IO.Compression;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Security.Cryptography;

namespace HurogiCollector;

internal sealed record CollectorSession(string Id, DateTime StartLocal, DateTime? EndLocal, bool Active);
internal sealed record CollectorConfig(string ServerUrl, string CollectorToken);
internal sealed record RouletteEventRule(long Balloons, int ExpectedSpins, string EventName);
internal sealed record FixedRewardRule(long Balloons, string EventName, string UpboType, int Quantity);
internal sealed record ObsConnectionSettings(bool Enabled, int Port, string MicrophoneInputName, string Password)
{
    public static ObsConnectionSettings Default { get; } = new(false, 4455, "", "");
}
internal sealed class VNextAgentCredentialFile
{
    public string DeviceSecret { get; init; } = "";
    public string? PendingDeviceSecret { get; init; }
    public long SecretRevision { get; init; } = 1;
    public DateTimeOffset? RotatedAt { get; init; }
}
internal sealed record VNextAgentCredentialSnapshot(
    string DeviceSecret,
    string? PendingDeviceSecret,
    long SecretRevision,
    DateTimeOffset? RotatedAt);

internal sealed class CollectorStorage
{
    internal const string ProductionServerUrl = "https://byeollog.com";
    internal const string ProductionCollectorUrl = ProductionServerUrl + "/api/collector";
    private const string LegacyServerHost = "observer_abangseladmin.vercel.app";

    private readonly string _root;
    private readonly string _seenPath;
    private readonly string _rawPath;
    private readonly string _logPath;
    private readonly string _sessionPath;
    private readonly string _configPath;
    private readonly string _obsSettingsPath;
    private readonly string _windowsCaptureSettingsPath;
    private readonly string _vNextAgentCredentialsPath;
    private readonly string _accountLoginMarkerPath;
    private readonly string _streamerNamePath;
    private readonly string _sessionsDir;
    private readonly string _rulesDir;
    private readonly string _draftRulesPath;
    private readonly string _fixedRulesDir;
    private readonly string _draftFixedRulesPath;
    private readonly string _themePath;
    private readonly string _pendingDiagnosticsPath;
    private readonly string _uploadedPath;
    private readonly string _vNextDevUploadedPath;
    private readonly object _logGate = new();
    private readonly HashSet<string> _seen = new(StringComparer.Ordinal);
    private readonly HashSet<string> _uploaded = new(StringComparer.Ordinal);
    private readonly HashSet<string> _vNextDevUploaded = new(StringComparer.Ordinal);
    private readonly JsonSerializerOptions _json = new() { WriteIndented = true };
    private static readonly Regex AgentSecretPattern = new(
        "^[A-Za-z0-9_-]{43}$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private const string AgentEnrollmentTokenFileName = "agent-enrollment-token.txt";

    public CollectorStorage()
    {
        _root = AgentDataPaths.PrepareDataRoot().RootPath;
        Directory.CreateDirectory(_root);
        _sessionsDir = Path.Combine(_root, "sessions");
        Directory.CreateDirectory(_sessionsDir);
        _rulesDir = Path.Combine(_root, "session_rules");
        Directory.CreateDirectory(_rulesDir);
        _draftRulesPath = Path.Combine(_root, "next_broadcast_roulette_rules.json");
        _fixedRulesDir = Path.Combine(_root, "session_fixed_rules");
        Directory.CreateDirectory(_fixedRulesDir);
        _draftFixedRulesPath = Path.Combine(_root, "next_broadcast_fixed_rules.json");
        _themePath = Path.Combine(_root, "theme.txt");
        _pendingDiagnosticsPath = Path.Combine(_root, "pending_server_diagnostics.jsonl");
        _uploadedPath = Path.Combine(_root, "uploaded_event_keys.txt");
        _vNextDevUploadedPath = Path.Combine(_root, "vnext_dev_uploaded_event_keys.txt");
        _seenPath = Path.Combine(_root, "seen_uids.txt");
        _rawPath = Path.Combine(_root, "donations.jsonl");
        _logPath = Path.Combine(_root, "collector.log");
        _sessionPath = Path.Combine(_root, "session_state.json");
        _configPath = Path.Combine(_root, "collector_config.json");
        _obsSettingsPath = Path.Combine(_root, "obs_settings.json");
        _windowsCaptureSettingsPath = Path.Combine(_root, "windows_capture_settings.json");
        _vNextAgentCredentialsPath = Path.Combine(_root, "vnext_agent_credentials.json");
        _accountLoginMarkerPath = Path.Combine(_root, "account_login.ok");
        _streamerNamePath = Path.Combine(_root, "streamer_name.txt");

        if (File.Exists(_seenPath))
        {
            foreach (var line in File.ReadLines(_seenPath))
            {
                var uid = line.Trim();
                if (uid.Length > 0) _seen.Add(uid);
            }
        }
        if (File.Exists(_uploadedPath))
        {
            foreach (var line in File.ReadLines(_uploadedPath))
            {
                var key = line.Trim();
                if (key.Length > 0) _uploaded.Add(key);
            }
        }
        if (File.Exists(_vNextDevUploadedPath))
        {
            foreach (var line in File.ReadLines(_vNextDevUploadedPath))
            {
                var key = line.Trim();
                if (key.Length > 0) _vNextDevUploaded.Add(key);
            }
        }
    }

    public string RootPath => _root;
    public int SeenCount => _seen.Count;
    public CollectorSession? Session { get; private set; }
    // In-memory only: a restarted Agent closes an interrupted session rather
    // than claiming it is still collecting.  This timestamp is a Weflab
    // observation signal, not an automation-worker heartbeat.
    public DateTimeOffset? LastWeflabObservedAt { get; private set; }
    public DateTimeOffset? LastSuccessfulUploadAt { get; private set; }
    public CollectorConfig Config { get; private set; } = new(ProductionCollectorUrl, "");
    public bool HasServerCredential =>
        !string.IsNullOrWhiteSpace(Config.ServerUrl) &&
        !string.IsNullOrWhiteSpace(Config.CollectorToken) &&
        File.Exists(_accountLoginMarkerPath);

    public void MarkWeflabObserved(DateTimeOffset observedAt)
    {
        if (Session?.Active != true) return;
        LastWeflabObservedAt = observedAt;
    }

    public void MarkSuccessfulUpload(DateTimeOffset uploadedAt)
    {
        if (Session?.Active != true) return;
        LastSuccessfulUploadAt = uploadedAt;
    }
    public string StreamerName
    {
        get
        {
            try
            {
                var value = File.Exists(_streamerNamePath) ? File.ReadAllText(_streamerNamePath, Encoding.UTF8).Trim() : "";
                return string.IsNullOrWhiteSpace(value) ? "스트리머" : value;
            }
            catch { return "스트리머"; }
        }
    }

    public void SaveStreamerName(string? name)
    {
        var value = (name ?? "").Trim();
        if (value.EndsWith("님", StringComparison.Ordinal)) value = value[..^1].TrimEnd();
        if (string.IsNullOrWhiteSpace(value)) value = "스트리머";
        CollectorStateLifecycle.AtomicWriteText(_streamerNamePath, value);
    }

    public void MarkAccountLoginComplete()
    {
        CollectorStateLifecycle.AtomicWriteText(_accountLoginMarkerPath, DateTimeOffset.Now.ToString("O"));
    }

    public void LoadState()
    {
        try { if (File.Exists(_sessionPath)) Session = JsonSerializer.Deserialize<CollectorSession>(File.ReadAllText(_sessionPath)); } catch { }
        try
        {
            if (File.Exists(_configPath))
            {
                var saved = JsonSerializer.Deserialize<CollectorConfig>(File.ReadAllText(_configPath));
                if (saved is not null && !string.IsNullOrWhiteSpace(saved.ServerUrl) && !string.IsNullOrWhiteSpace(saved.CollectorToken))
                {
                    // v0.4.6.4 이전 설정이 남아 있어도 로그인과 업로드는 정식 도메인을 사용합니다.
                    var serverUrl = saved.ServerUrl.Contains(LegacyServerHost, StringComparison.OrdinalIgnoreCase)
                        ? ProductionCollectorUrl
                        : saved.ServerUrl;
                    var plainToken = UnprotectToken(saved.CollectorToken);
                    Config = new CollectorConfig(serverUrl, plainToken);

                    // 레거시 평문 토큰이면 DPAPI로 재저장
                    var needsRewrite = !saved.CollectorToken.StartsWith("dpapi:", StringComparison.Ordinal)
                        || !string.Equals(serverUrl, saved.ServerUrl, StringComparison.Ordinal);
                    if (needsRewrite && !string.IsNullOrEmpty(plainToken))
                        SaveConfig(serverUrl, plainToken);
                }
            }
        }
        catch { }

        // seen_uids.txt는 장기적으로 무한 증가하지 않도록 현재 복구 세션의 키만 유지합니다.
        if (Session is not null)
        {
            var prefix = Session.Id + ":";
            _seen.RemoveWhere(x => !x.StartsWith(prefix, StringComparison.Ordinal));
            try { CollectorStateLifecycle.AtomicWriteLines(_seenPath, _seen); } catch { }
        }
    }

    public CollectorSession StartSession(DateTime startLocal)
    {
        // 같은 초에 세션을 다시 시작해도 파일/중복키가 충돌하지 않도록 밀리초+랜덤 접미사를 사용합니다.
        Session = new CollectorSession(DateTime.Now.ToString("yyyyMMdd-HHmmss-fff") + "-" + Guid.NewGuid().ToString("N")[..6], startLocal, null, true);
        LastWeflabObservedAt = null;
        LastSuccessfulUploadAt = null;
        _seen.Clear();
        try { CollectorStateLifecycle.AtomicWriteText(_seenPath, string.Empty); } catch { }
        SaveSession();
        var draft = LoadDraftRules();
        if (draft.Count > 0) SaveSessionRules(Session.Id, draft);
        var fixedDraft = LoadDraftFixedRules();
        if (fixedDraft.Count > 0) SaveSessionFixedRules(Session.Id, fixedDraft);
        return Session;
    }

    public CollectorSession? EndSession(DateTime endLocal)
    {
        if (Session is null) return null;
        Session = Session with { EndLocal = endLocal, Active = false };
        LastWeflabObservedAt = null;
        LastSuccessfulUploadAt = null;
        SaveSession();
        return Session;
    }

    public CollectorSession? CloseInterruptedSessionOnStartup()
    {
        if (Session?.Active != true) return Session;

        // 프로그램이 꺼져 있던 동안을 수집 시간으로 오인하지 않도록,
        // 가능하면 이 세션에서 마지막으로 실제 레코드를 받은 시각을 종료 시각으로 사용합니다.
        var endLocal = Session.StartLocal;
        try
        {
            var path = SessionFile(Session.Id);
            if (File.Exists(path))
            {
                foreach (var line in File.ReadLines(path))
                {
                    if (string.IsNullOrWhiteSpace(line)) continue;
                    try
                    {
                        using var doc = JsonDocument.Parse(line);
                        if (!doc.RootElement.TryGetProperty("received_at", out var at)) continue;
                        DateTime parsed;
                        if (at.ValueKind == JsonValueKind.String && DateTime.TryParse(at.GetString(), out parsed))
                        {
                            var local = parsed.Kind == DateTimeKind.Utc ? parsed.ToLocalTime() : parsed;
                            if (local > endLocal) endLocal = local;
                        }
                    }
                    catch { }
                }
            }
        }
        catch { }

        // 레코드가 하나도 없었던 세션은 시작 시각으로 마감합니다.
        Session = Session with { EndLocal = endLocal, Active = false };
        SaveSession();
        return Session;
    }

    private void SaveSession() =>
        CollectorStateLifecycle.AtomicWriteText(_sessionPath, JsonSerializer.Serialize(Session, _json));


    // H-02: Windows DPAPI(CurrentUser)로 토큰 보호
    private static string ProtectToken(string token)
    {
        if (string.IsNullOrEmpty(token)) return "";
        var bytes = Encoding.UTF8.GetBytes(token);
        var protectedBytes = ProtectedData.Protect(bytes, null, DataProtectionScope.CurrentUser);
        return "dpapi:" + Convert.ToBase64String(protectedBytes);
    }

    private static string UnprotectToken(string stored)
    {
        if (string.IsNullOrEmpty(stored)) return "";
        if (!stored.StartsWith("dpapi:", StringComparison.Ordinal))
            return stored; // 레거시 평문 호환
        try
        {
            var protectedBytes = Convert.FromBase64String(stored.Substring(6));
            var bytes = ProtectedData.Unprotect(protectedBytes, null, DataProtectionScope.CurrentUser);
            return Encoding.UTF8.GetString(bytes);
        }
        catch
        {
            return "";
        }
    }

    public void SaveConfig(string serverUrl, string token)
    {
        var plain = token.Trim();
        Config = new CollectorConfig(serverUrl.Trim(), plain);
        var toStore = new CollectorConfig(serverUrl.Trim(), ProtectToken(plain));
        CollectorStateLifecycle.AtomicWriteText(_configPath, JsonSerializer.Serialize(toStore, _json));
    }

    public ObsConnectionSettings LoadObsSettings()
    {
        try
        {
            if (!File.Exists(_obsSettingsPath)) return ObsConnectionSettings.Default;
            var saved = JsonSerializer.Deserialize<ObsConnectionSettings>(File.ReadAllText(_obsSettingsPath));
            if (saved is null) return ObsConnectionSettings.Default;
            var port = saved.Port is >= 1 and <= 65535 ? saved.Port : 4455;
            var inputName = (saved.MicrophoneInputName ?? "").Trim();
            if (inputName.Length > 128) inputName = inputName[..128];
            return new ObsConnectionSettings(saved.Enabled, port, inputName, UnprotectToken(saved.Password ?? ""));
        }
        catch
        {
            return ObsConnectionSettings.Default;
        }
    }

    public void SaveObsSettings(ObsConnectionSettings settings)
    {
        var port = settings.Port is >= 1 and <= 65535 ? settings.Port : 4455;
        var inputName = (settings.MicrophoneInputName ?? "").Trim();
        if (inputName.Length > 128) inputName = inputName[..128];
        var password = settings.Password ?? "";
        var toStore = new ObsConnectionSettings(
            settings.Enabled,
            port,
            inputName,
            ProtectToken(password));
        CollectorStateLifecycle.AtomicWriteText(_obsSettingsPath, JsonSerializer.Serialize(toStore, _json));
    }

    public WindowsCaptureSettings LoadWindowsCaptureSettings()
    {
        try
        {
            if (!File.Exists(_windowsCaptureSettingsPath)) return WindowsCaptureSettings.Default;
            var saved = JsonSerializer.Deserialize<WindowsCaptureSettings>(
                File.ReadAllText(_windowsCaptureSettingsPath, Encoding.UTF8));
            if (saved is null) return WindowsCaptureSettings.Default;
            var endpointId = (saved.EndpointId ?? "").Trim();
            var endpointName = (saved.EndpointName ?? "").Trim();
            if (endpointId.Length > 512 || endpointId.Any(char.IsControl))
                return WindowsCaptureSettings.Default;
            if (endpointName.Length > 256) endpointName = endpointName[..256];
            return new WindowsCaptureSettings(saved.Enabled, endpointId, endpointName);
        }
        catch
        {
            return WindowsCaptureSettings.Default;
        }
    }

    public void SaveWindowsCaptureSettings(WindowsCaptureSettings settings)
    {
        var endpointId = (settings.EndpointId ?? "").Trim();
        var endpointName = (settings.EndpointName ?? "").Trim();
        if (endpointId.Length > 512 || endpointId.Any(char.IsControl))
            throw new ArgumentException("Windows 캡처 장치 ID가 올바르지 않습니다.", nameof(settings));
        if (endpointName.Length > 256) endpointName = endpointName[..256];
        if (settings.Enabled && endpointId.Length == 0)
            throw new ArgumentException("Windows 캡처 장치를 먼저 선택해주세요.", nameof(settings));
        var normalized = new WindowsCaptureSettings(settings.Enabled, endpointId, endpointName);
        CollectorStateLifecycle.AtomicWriteText(
            _windowsCaptureSettingsPath,
            JsonSerializer.Serialize(normalized, _json));
    }

    public string LoadOrCreateVNextAgentDeviceSecret()
        => LoadOrCreateVNextAgentCredentials().DeviceSecret;

    public VNextAgentCredentialSnapshot LoadOrCreateVNextAgentCredentials()
    {
        if (File.Exists(_vNextAgentCredentialsPath))
        {
            try
            {
                var saved = JsonSerializer.Deserialize<VNextAgentCredentialFile>(
                    File.ReadAllText(_vNextAgentCredentialsPath, Encoding.UTF8));
                var secret = saved is null ? "" : UnprotectToken(saved.DeviceSecret ?? "");
                if (!AgentSecretPattern.IsMatch(secret))
                    throw new InvalidDataException("Agent device secret is invalid");
                var pendingSecret = string.IsNullOrWhiteSpace(saved?.PendingDeviceSecret)
                    ? null
                    : UnprotectToken(saved.PendingDeviceSecret);
                if (pendingSecret is not null
                    && (!AgentSecretPattern.IsMatch(pendingSecret)
                        || string.Equals(secret, pendingSecret, StringComparison.Ordinal)))
                    throw new InvalidDataException("Pending Agent device secret is invalid");
                var revision = saved!.SecretRevision < 1 ? 1 : saved.SecretRevision;
                return new VNextAgentCredentialSnapshot(secret, pendingSecret, revision, saved.RotatedAt);
            }
            catch (Exception ex) when (ex is not InvalidOperationException)
            {
                throw new InvalidOperationException(
                    "저장된 Agent 장치 키를 읽지 못했습니다. vnext_agent_credentials.json을 삭제하지 말고 관리자에게 문의해주세요.",
                    ex);
            }
        }

        var secretToCreate = Base64Url(RandomNumberGenerator.GetBytes(32));
        var contents = JsonSerializer.Serialize(
            new VNextAgentCredentialFile
            {
                DeviceSecret = ProtectToken(secretToCreate),
                SecretRevision = 1,
                RotatedAt = DateTimeOffset.UtcNow
            },
            _json);
        var temporaryPath = _vNextAgentCredentialsPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            File.WriteAllText(temporaryPath, contents, new UTF8Encoding(false));
            File.Move(temporaryPath, _vNextAgentCredentialsPath, overwrite: false);
            return new VNextAgentCredentialSnapshot(secretToCreate, null, 1, DateTimeOffset.UtcNow);
        }
        catch
        {
            try
            {
                if (File.Exists(temporaryPath)) File.Delete(temporaryPath);
            }
            catch { }

            if (File.Exists(_vNextAgentCredentialsPath))
                return LoadOrCreateVNextAgentCredentials();
            throw;
        }
    }

    public VNextAgentCredentialSnapshot BeginVNextAgentDeviceSecretRotation(string expectedCurrentSecret)
    {
        var current = LoadOrCreateVNextAgentCredentials();
        if (!CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(current.DeviceSecret),
                Encoding.ASCII.GetBytes(expectedCurrentSecret)))
            throw new InvalidOperationException("Agent 장치 키가 회전 준비 중 변경되었습니다.");
        if (current.PendingDeviceSecret is not null) return current;

        var pendingSecret = Base64Url(RandomNumberGenerator.GetBytes(32));
        var pending = current with { PendingDeviceSecret = pendingSecret };
        SaveVNextAgentCredentials(pending);
        return pending;
    }

    public VNextAgentCredentialSnapshot CommitVNextAgentDeviceSecretRotation(
        string expectedCurrentSecret,
        string expectedPendingSecret,
        long secretRevision,
        DateTimeOffset rotatedAt)
    {
        if (secretRevision < 2)
            throw new ArgumentOutOfRangeException(nameof(secretRevision));
        var current = LoadOrCreateVNextAgentCredentials();
        if (!string.Equals(current.DeviceSecret, expectedCurrentSecret, StringComparison.Ordinal)
            || !string.Equals(current.PendingDeviceSecret, expectedPendingSecret, StringComparison.Ordinal))
            throw new InvalidOperationException("Agent 장치 키 회전 상태가 응답과 일치하지 않습니다.");

        var committed = new VNextAgentCredentialSnapshot(
            expectedPendingSecret,
            null,
            secretRevision,
            rotatedAt.ToUniversalTime());
        SaveVNextAgentCredentials(committed);
        return committed;
    }

    private void SaveVNextAgentCredentials(VNextAgentCredentialSnapshot credentials)
    {
        if (!AgentSecretPattern.IsMatch(credentials.DeviceSecret)
            || (credentials.PendingDeviceSecret is not null
                && !AgentSecretPattern.IsMatch(credentials.PendingDeviceSecret))
            || credentials.SecretRevision < 1)
            throw new InvalidDataException("Agent 장치 키 저장 상태가 올바르지 않습니다.");

        var contents = JsonSerializer.Serialize(
            new VNextAgentCredentialFile
            {
                DeviceSecret = ProtectToken(credentials.DeviceSecret),
                PendingDeviceSecret = credentials.PendingDeviceSecret is null
                    ? null
                    : ProtectToken(credentials.PendingDeviceSecret),
                SecretRevision = credentials.SecretRevision,
                RotatedAt = credentials.RotatedAt?.ToUniversalTime()
            },
            _json);
        CollectorStateLifecycle.AtomicWriteText(_vNextAgentCredentialsPath, contents);
    }

    public string? LoadVNextAgentEnrollmentToken()
    {
        var path = Path.Combine(AppContext.BaseDirectory, AgentEnrollmentTokenFileName);
        if (!File.Exists(path)) return null;

        var token = File.ReadAllText(path, Encoding.UTF8).Trim();
        if (!AgentSecretPattern.IsMatch(token))
            throw new InvalidOperationException("Agent 1회용 등록 토큰 파일이 올바르지 않습니다.");
        return token;
    }

    public void DeleteVNextAgentEnrollmentToken()
    {
        var path = Path.Combine(AppContext.BaseDirectory, AgentEnrollmentTokenFileName);
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch { }
    }

    private static string Base64Url(byte[] value) =>
        Convert.ToBase64String(value)
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');

    public void ClearServerCredential()
    {
        var baseUrl = (Config.ServerUrl ?? "").Trim();
        if (baseUrl.EndsWith("/api/collector", StringComparison.OrdinalIgnoreCase))
            baseUrl = baseUrl[..^"/api/collector".Length];
        if (string.IsNullOrWhiteSpace(baseUrl))
            baseUrl = ProductionServerUrl;

        Config = new CollectorConfig(baseUrl.TrimEnd('/') + "/api/collector", "");
        try
        {
            if (File.Exists(_configPath)) File.Delete(_configPath);
            if (File.Exists(_accountLoginMarkerPath)) File.Delete(_accountLoginMarkerPath);
            if (File.Exists(_streamerNamePath)) File.Delete(_streamerNamePath);
        }
        catch { }
    }




    public string LoadTheme()
    {
        try
        {
            if (!File.Exists(_themePath)) return "dark";
            var value = File.ReadAllText(_themePath).Trim().ToLowerInvariant();
            return value is "light" or "dark" ? value : "dark";
        }
        catch { return "dark"; }
    }

    public void SaveTheme(string theme)
    {
        var value = string.Equals(theme, "light", StringComparison.OrdinalIgnoreCase) ? "light" : "dark";
        CollectorStateLifecycle.AtomicWriteText(_themePath, value);
    }

    public List<RouletteEventRule> LoadDraftRules()
    {
        try { return File.Exists(_draftRulesPath) ? JsonSerializer.Deserialize<List<RouletteEventRule>>(File.ReadAllText(_draftRulesPath)) ?? new() : new(); }
        catch { return new(); }
    }

    public void SaveDraftRules(IEnumerable<RouletteEventRule> rules)
    {
        var normalized = rules.Where(r => r.Balloons > 0 && r.ExpectedSpins > 0 && !string.IsNullOrWhiteSpace(r.EventName))
            .GroupBy(r => r.Balloons).Select(g => g.Last()).OrderBy(r => r.Balloons).ToList();
        CollectorStateLifecycle.AtomicWriteText(_draftRulesPath, JsonSerializer.Serialize(normalized, _json));
    }

    public List<RouletteEventRule> LoadSessionRules(string sessionId)
    {
        var path = RulesFile(sessionId);
        try
        {
            if (!File.Exists(path)) return new();
            return JsonSerializer.Deserialize<List<RouletteEventRule>>(File.ReadAllText(path)) ?? new();
        }
        catch { return new(); }
    }

    public void SaveSessionRules(string sessionId, IEnumerable<RouletteEventRule> rules)
    {
        var normalized = rules.Where(r => r.Balloons > 0 && r.ExpectedSpins > 0 && !string.IsNullOrWhiteSpace(r.EventName))
            .GroupBy(r => r.Balloons).Select(g => g.Last()).OrderBy(r => r.Balloons).ToList();
        CollectorStateLifecycle.AtomicWriteText(RulesFile(sessionId), JsonSerializer.Serialize(normalized, _json));
    }


    public List<FixedRewardRule> LoadDraftFixedRules()
    {
        try { return File.Exists(_draftFixedRulesPath) ? JsonSerializer.Deserialize<List<FixedRewardRule>>(File.ReadAllText(_draftFixedRulesPath)) ?? new() : new(); }
        catch { return new(); }
    }

    public void SaveDraftFixedRules(IEnumerable<FixedRewardRule> rules)
    {
        var normalized = NormalizeFixedRules(rules);
        CollectorStateLifecycle.AtomicWriteText(_draftFixedRulesPath, JsonSerializer.Serialize(normalized, _json));
    }

    public List<FixedRewardRule> LoadSessionFixedRules(string sessionId)
    {
        var path = FixedRulesFile(sessionId);
        try
        {
            if (!File.Exists(path)) return new();
            return JsonSerializer.Deserialize<List<FixedRewardRule>>(File.ReadAllText(path)) ?? new();
        }
        catch { return new(); }
    }

    public void SaveSessionFixedRules(string sessionId, IEnumerable<FixedRewardRule> rules)
    {
        var normalized = NormalizeFixedRules(rules);
        CollectorStateLifecycle.AtomicWriteText(FixedRulesFile(sessionId), JsonSerializer.Serialize(normalized, _json));
    }

    private static List<FixedRewardRule> NormalizeFixedRules(IEnumerable<FixedRewardRule> rules)
        => rules.Where(r => r.Balloons > 0 && r.Quantity > 0 && !string.IsNullOrWhiteSpace(r.EventName) && !string.IsNullOrWhiteSpace(r.UpboType))
            .GroupBy(r => $"{r.Balloons}|{r.EventName.Trim()}|{r.UpboType.Trim()}", StringComparer.Ordinal)
            .Select(g => g.Last() with { EventName = g.Last().EventName.Trim(), UpboType = g.Last().UpboType.Trim() })
            .OrderBy(r => r.Balloons).ThenBy(r => r.EventName).ThenBy(r => r.UpboType).ToList();

    public bool TrySave(string uid, JsonElement row)
    {
        if (string.IsNullOrWhiteSpace(uid)) return false;
        // 위플랩 uid가 먼 훗날 재사용되더라도 다른 방송 세션까지 영구 차단하지 않습니다.
        // 같은 세션 안에서는 동일 uid를 계속 중복 제거합니다.
        var eventTime = "";
        if (row.ValueKind == JsonValueKind.Object)
        {
            if (row.TryGetProperty("create_time", out var ct)) eventTime = ct.ToString().Trim();
            if (eventTime.Length == 0 && row.TryGetProperty("time", out var tm)) eventTime = tm.ToString().Trim();
        }
        // 같은 방송 안에서도 위플랩이 UID를 재사용하는 경우를 대비해 원본 시각까지 중복키에 포함합니다.
        var seenKey = (Session?.Id ?? "nosession") + ":" + uid + (eventTime.Length > 0 ? "@" + eventTime : "");
        if (_seen.Contains(seenKey)) return false;
        var json = row.GetRawText();
        File.AppendAllText(_rawPath, json + Environment.NewLine, new UTF8Encoding(false));
        File.AppendAllText(_seenPath, seenKey + Environment.NewLine, new UTF8Encoding(false));
        _seen.Add(seenKey);

        if (Session is not null)
        {
            var sessionFile = SessionFile(Session.Id);
            using var rawDoc = JsonDocument.Parse(json);
            var safeRaw = rawDoc.RootElement.Clone();
            var wrapper = JsonSerializer.Serialize(new { received_at = DateTime.Now, uid, raw = safeRaw });
            File.AppendAllText(sessionFile, wrapper + Environment.NewLine, new UTF8Encoding(false));
        }
        return true;
    }

    public List<JsonElement> LoadSessionRows(string sessionId)
    {
        var path = SessionFile(sessionId);
        var rows = new List<JsonElement>();
        if (!File.Exists(path)) return rows;
        foreach (var line in File.ReadLines(path))
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            try
            {
                using var doc = JsonDocument.Parse(line);
                if (doc.RootElement.TryGetProperty("raw", out var raw)) rows.Add(raw.Clone());
            }
            catch { }
        }
        return rows;
    }


    public List<JsonElement> LoadPendingSessionRows(string sessionId)
    {
        return LoadSessionRows(sessionId).Where(row => !_uploaded.Contains(UploadEventKey(sessionId, row))).ToList();
    }

    public int PendingUploadCount(string sessionId)
    {
        return LoadPendingSessionRows(sessionId).Count;
    }

    public void MarkUploaded(string sessionId, IEnumerable<JsonElement> rows)
    {
        var added = new List<string>();
        foreach (var row in rows)
        {
            var key = UploadEventKey(sessionId, row);
            if (_uploaded.Add(key)) added.Add(key);
        }
        if (added.Count == 0) return;
        try { File.AppendAllLines(_uploadedPath, added, new UTF8Encoding(false)); } catch { }
    }

    public List<JsonElement> LoadPendingVNextDevelopmentRows(string sessionId)
    {
        return LoadSessionRows(sessionId)
            .Where(row => !_vNextDevUploaded.Contains(UploadEventKey(sessionId, row)))
            .ToList();
    }

    public int PendingVNextDevelopmentCount(string sessionId)
    {
        return LoadPendingVNextDevelopmentRows(sessionId).Count;
    }

    public void MarkVNextDevelopmentUploaded(string sessionId, IEnumerable<JsonElement> rows)
    {
        var added = new List<string>();
        foreach (var row in rows)
        {
            var key = UploadEventKey(sessionId, row);
            if (_vNextDevUploaded.Add(key)) added.Add(key);
        }
        if (added.Count == 0) return;
        try { File.AppendAllLines(_vNextDevUploadedPath, added, new UTF8Encoding(false)); } catch { }
    }

    private static string UploadEventKey(string sessionId, JsonElement row)
    {
        var uid = "";
        var eventTime = "";
        if (row.ValueKind == JsonValueKind.Object)
        {
            if (row.TryGetProperty("uid", out var u)) uid = u.ToString().Trim();
            if (row.TryGetProperty("create_time", out var ct)) eventTime = ct.ToString().Trim();
            if (eventTime.Length == 0 && row.TryGetProperty("time", out var tm)) eventTime = tm.ToString().Trim();
        }
        // 수집 중복키와 동일한 기준을 사용해, 서버 응답을 받기 전까지는 항상 재전송 대상으로 남깁니다.
        return sessionId + ":" + uid + (eventTime.Length > 0 ? "@" + eventTime : "");
    }

    public void EnqueuePendingDiagnostic(string json)
    {
        try { File.AppendAllText(_pendingDiagnosticsPath, json + Environment.NewLine, new UTF8Encoding(false)); } catch { }
    }

    public List<string> LoadPendingDiagnostics()
    {
        try
        {
            if (!File.Exists(_pendingDiagnosticsPath)) return new();
            return File.ReadLines(_pendingDiagnosticsPath).Where(x => !string.IsNullOrWhiteSpace(x)).TakeLast(200).ToList();
        }
        catch { return new(); }
    }

    public void ReplacePendingDiagnostics(IEnumerable<string> rows)
    {
        try
        {
            var list = rows.Where(x => !string.IsNullOrWhiteSpace(x)).TakeLast(200).ToList();
            if (list.Count == 0)
            {
                if (File.Exists(_pendingDiagnosticsPath)) File.Delete(_pendingDiagnosticsPath);
                return;
            }
            CollectorStateLifecycle.AtomicWriteLines(_pendingDiagnosticsPath, list);
        }
        catch { }
    }

    public string ExportDebugZip(
        string appVersion,
        string webViewVersion,
        string? currentUrl,
        CollectorPreflightReport preflight)
    {
        var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
        var temp = Path.Combine(Path.GetTempPath(), "ByeollogAgentDebug-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(temp);
        try
        {
            CopySanitizedText(_logPath, Path.Combine(temp, "collector.log"));
            CopySanitizedJson(_sessionPath, Path.Combine(temp, "session_state.json"));
            CopySanitizedJson(_draftRulesPath, Path.Combine(temp, "next_broadcast_roulette_rules.json"));
            CopySanitizedJson(_draftFixedRulesPath, Path.Combine(temp, "next_broadcast_fixed_rules.json"));
            CopySanitizedJsonLines(_pendingDiagnosticsPath, Path.Combine(temp, "pending_server_diagnostics.jsonl"));
            // 업로드 키 원문은 후원 UID를 포함할 수 있어 내보내지 않고 건수만 status.json에 기록한다.
            if (Session is not null) { CopySanitizedJsonLines(SessionFile(Session.Id), Path.Combine(temp, "session_records.jsonl")); CopySanitizedJson(RulesFile(Session.Id), Path.Combine(temp, "session_roulette_rules.json")); CopySanitizedJson(FixedRulesFile(Session.Id), Path.Combine(temp, "session_fixed_rules.json")); }
            var status = new
            {
                generated_at = DateTime.Now,
                app_version = appVersion,
                webview2_version = webViewVersion,
                current_url_origin = SanitizeUrl(currentUrl),
                seen_uid_count = SeenCount,
                uploaded_event_key_count = _uploaded.Count,
                vnext_dev_uploaded_event_key_count = _vNextDevUploaded.Count,
                session = Session is null ? null : new { Session.StartLocal, Session.EndLocal, Session.Active },
                server_url_origin = SanitizeUrl(Config.ServerUrl),
                collector_token_saved = !string.IsNullOrWhiteSpace(Config.CollectorToken)
            };
            File.WriteAllText(Path.Combine(temp, "status.json"), JsonSerializer.Serialize(status, _json), new UTF8Encoding(false));
            File.WriteAllText(
                Path.Combine(temp, "preflight.json"),
                JsonSerializer.Serialize(preflight, new JsonSerializerOptions(_json)
                {
                    PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower
                }),
                new UTF8Encoding(false));
            File.WriteAllText(Path.Combine(temp, "PRIVACY_NOTICE.txt"), "별록 에이전트 진단 ZIP\n\n이 파일은 이메일, 계정 ID, 닉네임, 메시지, 토큰, 후원 UID, 사용자 입력 규칙명, OBS 입력명, OBS 비밀번호, Agent 장치 ID를 포함하지 않거나 마스킹한 진단 자료입니다. preflight.json은 읽기 전용 방송 준비 검사 결과만 포함합니다. 운영 및 vNext 개발 업로드 키 원문과 URL 경로·쿼리는 포함하지 않습니다. 그래도 외부 공개 업로드는 피하고 별록 관리자에게만 전달해주세요. 전달 목적이 끝나면 ZIP을 삭제해주세요.\n", new UTF8Encoding(false));
            var zip = Path.Combine(_root, $"debug-{stamp}.zip");
            if (File.Exists(zip)) File.Delete(zip);
            ZipFile.CreateFromDirectory(temp, zip, CompressionLevel.Optimal, false);
            return zip;
        }
        finally { try { Directory.Delete(temp, true); } catch { } }
    }

    public string ExportAcceptanceZip(CollectorAcceptanceReport report)
    {
        var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
        var temp = Path.Combine(Path.GetTempPath(), "ByeollogAcceptance-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(temp);
        try
        {
            File.WriteAllText(
                Path.Combine(temp, "acceptance.json"),
                JsonSerializer.Serialize(report, new JsonSerializerOptions(_json)
                {
                    PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower
                }),
                new UTF8Encoding(false));
            File.WriteAllText(
                Path.Combine(temp, "RESULT_KO.txt"),
                report.UserSummary(),
                new UTF8Encoding(false));
            File.WriteAllText(
                Path.Combine(temp, "PRIVACY_NOTICE.txt"),
                "별록 vNext 실기기 검증 ZIP\n\n이 ZIP에는 실행 ID, 이벤트 ID, 워크스페이스·계정·장치 식별자, 후원자·닉네임·메시지, 토큰, OBS 입력명·비밀번호가 들어 있지 않습니다. 오버레이 이미지 버전·SHA-256, 익명 상태 판정, 브라우저 소스 조회 횟수와 사용자의 OBS·FreeShot 화면 확인 결과만 포함합니다. 운영 데이터 원문은 포함하지 않습니다. 별록 관리자에게만 전달하고 확인이 끝나면 삭제해주세요.\n",
                new UTF8Encoding(false));
            var zip = Path.Combine(_root, $"acceptance-v070_RC2-{stamp}.zip");
            if (File.Exists(zip)) File.Delete(zip);
            ZipFile.CreateFromDirectory(temp, zip, CompressionLevel.Optimal, false);
            return zip;
        }
        finally { try { Directory.Delete(temp, true); } catch { } }
    }

    public void Log(string message)
    {
        var line = $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] {message}";
        lock (_logGate)
        {
            File.AppendAllText(_logPath, line + Environment.NewLine, new UTF8Encoding(false));
        }
    }

    private string SessionFile(string id) => Path.Combine(_sessionsDir, id + ".jsonl");
    private string RulesFile(string id) => Path.Combine(_rulesDir, id + ".json");
    private string FixedRulesFile(string id) => Path.Combine(_fixedRulesDir, id + ".json");
    private static readonly HashSet<string> SensitiveDebugKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        "uid","source_uid","source_event_key","id","user_id","userid","bjid","soop_id","fan",
        "nickname","name","contact","message","msg","email","token","access_token","refresh_token",
        "password","station_url","device_token","code","code_hash","token_hash","session_id",
        "roulette","roulette_result","result","list","title","item","event_name","eventname","upbo_type","upbotype"
    };

    private static string MaskValue(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return "[REDACTED]";
        var digest = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        return "[MASKED:" + Convert.ToHexString(digest)[..12].ToLowerInvariant() + "]";
    }

    private static void RedactNode(JsonNode? node)
    {
        if (node is JsonObject obj)
        {
            foreach (var key in obj.Select(x => x.Key).ToList())
            {
                if (SensitiveDebugKeys.Contains(key))
                {
                    obj[key] = MaskValue(obj[key]?.ToJsonString());
                    continue;
                }
                RedactNode(obj[key]);
            }
        }
        else if (node is JsonArray array)
        {
            foreach (var item in array) RedactNode(item);
        }
    }

    private static string SanitizeJson(string text)
    {
        try
        {
            var node = JsonNode.Parse(text);
            RedactNode(node);
            return node?.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) ?? "{}";
        }
        catch { return SanitizePlainText(text); }
    }

    private static string SanitizePlainText(string text)
    {
        var output = Regex.Replace(text, @"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", "[EMAIL]", RegexOptions.IgnoreCase);
        output = Regex.Replace(output, @"Bearer\s+[^\s]+", "Bearer [REDACTED]", RegexOptions.IgnoreCase);
        output = Regex.Replace(output, @"blc_[A-Za-z0-9_-]+", "[COLLECTOR_TOKEN]", RegexOptions.IgnoreCase);
        output = Regex.Replace(output, @"((?:handoff|token|code|idx|soop_id)=)[^&\s]+", "$1[REDACTED]", RegexOptions.IgnoreCase);
        output = Regex.Replace(output, @"((?:uid|source_uid|source_event_key|id|user_id|bjid|nickname|name|message|msg|contact)=)[^\s,;]+", "$1[REDACTED]", RegexOptions.IgnoreCase);
        output = Regex.Replace(output,
            @"(""(?:uid|source_uid|source_event_key|id|user_id|userid|bjid|soop_id|fan|nickname|name|contact|message|msg|email|token|access_token|refresh_token|password|station_url|device_token|code|code_hash|token_hash|session_id|roulette|roulette_result|result|title|item|event_name|eventname|upbo_type|upbotype)""\s*:\s*)(?:""(?:\\.|[^""\\])*""|-?\d+(?:\.\d+)?|true|false|null)",
            "$1\"[REDACTED]\"", RegexOptions.IgnoreCase);
        output = Regex.Replace(output, @"(https?://[A-Za-z0-9.-]+(?::\d+)?)(?:/[^\s""'<>]*)?", "$1/[PATH_REDACTED]", RegexOptions.IgnoreCase);
        return output;
    }

    private static string? SanitizeUrl(string? value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri)) return null;
        return uri.GetLeftPart(UriPartial.Authority);
    }

    private static void CopySanitizedText(string from, string to)
    {
        if (!File.Exists(from)) return;
        File.WriteAllText(to, SanitizePlainText(File.ReadAllText(from)), new UTF8Encoding(false));
    }

    private static void CopySanitizedJson(string from, string to)
    {
        if (!File.Exists(from)) return;
        File.WriteAllText(to, SanitizeJson(File.ReadAllText(from)), new UTF8Encoding(false));
    }

    private static void CopySanitizedJsonLines(string from, string to)
    {
        if (!File.Exists(from)) return;
        var lines = File.ReadLines(from).Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => SanitizeJson(x));
        File.WriteAllLines(to, lines, new UTF8Encoding(false));
    }
}
