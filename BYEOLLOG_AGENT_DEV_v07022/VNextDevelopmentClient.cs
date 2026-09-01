using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace HurogiCollector;

internal sealed record VNextDevelopmentEvent(
    string SchemaVersion,
    string Id,
    string WorkspaceId,
    string Source,
    string Platform,
    string Type,
    string? Subtype,
    object? Actor,
    long? Amount,
    string? Currency,
    object Payload,
    DateTimeOffset OccurredAt,
    DateTimeOffset ReceivedAt,
    string CorrelationId);

internal sealed record VNextDevelopmentSendResult(
    string EventId,
    bool Duplicate,
    int MatchedRuleCount,
    int QueuedExecutionCount,
    int CompletedSucceededCount,
    IReadOnlyList<string> QueuedExecutionIds);

internal sealed class VNextSessionRecoveryEventArgs : EventArgs
{
    public VNextSessionRecoveryEventArgs(string state, string code)
    {
        State = state;
        Code = code;
    }

    public string State { get; }
    public string Code { get; }
}

internal sealed record VNextAgentRegistrationResult(string DeviceId, bool Created);

internal sealed record VNextAgentSecretRotationResult(
    string DeviceId,
    long SecretRevision,
    DateTimeOffset RotatedAt,
    DateTimeOffset PreviousValidUntil);

internal sealed record VNextAgentDeviceStatusResult(string DeviceId, DateTimeOffset ReportedAt);
internal sealed record VNextRealtimeCredentials(string AccessToken, string WorkspaceId, long SessionEpoch);
internal sealed record VNextCollectionHealth(
    string State,
    DateTimeOffset? SessionStartedAt,
    DateTimeOffset? LastObservedAt,
    DateTimeOffset? LastUploadAt);

internal sealed record RaffleTtsCandidate(
    string ActorKey,
    string ActorName,
    string VoiceKey);

internal sealed record RaffleTtsCandidateBatch(
    string DrawId,
    int TotalCount,
    IReadOnlyList<RaffleTtsCandidate> Candidates,
    string? NextCursor);

internal sealed class VNextDevelopmentException : Exception
{
    public VNextDevelopmentException(string message, int? statusCode = null, string code = "unknown_error")
        : base(message)
    {
        StatusCode = statusCode;
        Code = code;
    }

    public int? StatusCode { get; }
    public string Code { get; }
}

/// <summary>
/// 운영 별록 계정과 같은 offsl 프로젝트의 자동화 클라이언트입니다.
/// 일반 로그인에서 검증된 세션만 채택합니다. 비밀번호와 access token은
/// 저장하지 않으며 refresh token은 현재 Windows 사용자 DPAPI로만 보관합니다.
/// </summary>
internal sealed partial class VNextDevelopmentClient : IDisposable
{
    internal const string AutomationCapability = "offsl-session-v1";
    internal const string SupabaseProjectRef = "offslvwaugvjotkywlus";
    internal const string SupabaseUrl = "https://offslvwaugvjotkywlus.supabase.co";
    internal const string PublishableKey = "sb_publishable_mSPhwp3wBb27PHQ80cCwhQ_XcpEIxif";
    private const string ExpectedJwtIssuer = SupabaseUrl + "/auth/v1";

    private static readonly Regex ActionTypePattern = new(
        "^[a-z][a-z0-9_.-]{0,119}$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex DeviceSecretPattern = new(
        "^[A-Za-z0-9_-]{43}$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex OverlayAssetKeyPattern = new(
        "^[a-z0-9][a-z0-9_-]{1,63}$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex Sha256Pattern = new(
        "^[0-9a-f]{64}$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex VoiceVersionPattern = new(
        "^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex OverlayDownloadPathPattern = new(
        "^assets/[0-9a-f-]{36}/v[1-9][0-9]*/[0-9a-f]{64}\\.(svg|png|webp|gif)$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly HashSet<string> OverlayMimeTypes = new(StringComparer.Ordinal)
    {
        "image/svg+xml",
        "image/png",
        "image/webp",
        "image/gif"
    };
    private const int MaximumOverlayAssetBytes = 10 * 1024 * 1024;
    private const int MaximumRaffleWinnerAudioBytes = 2 * 1024 * 1024;
    private const int WallpaperSchemaVersion = 2;
    private static readonly Regex ErrorCodePattern = new(
        "^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private readonly HttpClient _http;
    private readonly SemaphoreSlim _sessionGate = new(1, 1);
    private readonly object _connectionBoundaryGate = new();
    private readonly object _collectorPairAdoptionGate = new();
    private readonly CancellationTokenSource _shutdown = new();
    private readonly VNextSessionVault _sessionVault;
    private readonly JsonSerializerOptions _json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };
    private readonly JsonSerializerOptions _agentRequestJsonWithNulls = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never
    };

    private string _accessToken = "";
    private string _refreshToken = "";
    private DateTimeOffset _expiresAt = DateTimeOffset.MinValue;
    private bool _rememberSession;
    private long _sessionEpoch;
    private long _tokenRevision;
    private long _connectionIntentRevision;
    private CancellationTokenSource? _connectionBoundary = new();
    private Task<bool>? _pendingCollectorPairAdoption;
    private Task<bool>? _pendingRememberedSessionRestore;
    private bool _forceRefreshRequired;
    private int _disposed;
    private string _workspaceId = "";
    private Guid _authenticatedUserId;
    private string _sessionRecoveryState = "ready";

    public string SignedInEmail { get; private set; } = "";
    public bool IsSignedIn => !string.IsNullOrWhiteSpace(_accessToken) && !string.IsNullOrWhiteSpace(_refreshToken);
    internal string WorkspaceId => !string.IsNullOrWhiteSpace(_workspaceId)
        ? _workspaceId
        : throw new VNextDevelopmentException("별록 워크스페이스 연결 정보가 없습니다.", 401, "missing_workspace");
    public long SessionEpoch => Interlocked.Read(ref _sessionEpoch);
    public string SessionRecoveryState => Volatile.Read(ref _sessionRecoveryState);
    public event EventHandler? SessionChanged;
    public event EventHandler<VNextSessionRecoveryEventArgs>? SessionRecoveryChanged;

    public VNextDevelopmentClient()
        : this(AgentDataPaths.PrepareDataRoot().RootPath)
    {
    }

    public VNextDevelopmentClient(string sessionRootPath)
    {
        _http = new HttpClient(new SocketsHttpHandler
        {
            AutomaticDecompression = DecompressionMethods.GZip
                | DecompressionMethods.Deflate
                | DecompressionMethods.Brotli,
            ConnectTimeout = TimeSpan.FromSeconds(8),
            PooledConnectionLifetime = TimeSpan.FromMinutes(10)
        }) { Timeout = TimeSpan.FromSeconds(30) };
        _sessionVault = new VNextSessionVault(sessionRootPath);
    }

    public Task<bool> BeginRememberedSessionRestore()
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);
        var restore = RestoreRememberedSessionWithTimeoutAsync();
        lock (_collectorPairAdoptionGate)
            _pendingRememberedSessionRestore = restore;
        return restore;
    }

    public Task<bool> BeginCollectorPairSessionAdoption(
        JsonElement pairResponse,
        string fallbackEmail)
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);
        var responseSnapshot = pairResponse.Clone();
        var adoption = AdoptCollectorPairSessionWithTimeoutAsync(responseSnapshot, fallbackEmail);
        lock (_collectorPairAdoptionGate)
            _pendingCollectorPairAdoption = adoption;
        return adoption;
    }

    public async Task<bool> WaitForPendingCollectorPairSessionAdoptionAsync(
        TimeSpan timeout,
        CancellationToken cancellationToken = default)
    {
        if (IsSignedIn) return true;

        Task<bool>? pending;
        Task<bool>? restore;
        lock (_collectorPairAdoptionGate)
        {
            pending = _pendingCollectorPairAdoption;
            restore = _pendingRememberedSessionRestore;
        }
        var candidates = new[] { pending, restore }.Where(task => task is not null).Cast<Task<bool>>().ToArray();
        if (candidates.Length == 0) return false;

        try
        {
            await Task.WhenAll(candidates).WaitAsync(timeout, cancellationToken);
        }
        catch (TimeoutException)
        {
            return IsSignedIn;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return IsSignedIn;
        }
        catch
        {
            return IsSignedIn;
        }
        return IsSignedIn;
    }

    private async Task<bool> RestoreRememberedSessionWithTimeoutAsync()
    {
        using var totalTimeout = CancellationTokenSource.CreateLinkedTokenSource(_shutdown.Token);
        totalTimeout.CancelAfter(TimeSpan.FromSeconds(8));
        try
        {
            return await TryRestoreRememberedSessionAsync(totalTimeout.Token);
        }
        catch (OperationCanceledException)
        {
            return false;
        }
        catch (ObjectDisposedException)
        {
            return false;
        }
    }

    private async Task<bool> TryRestoreRememberedSessionAsync(CancellationToken cancellationToken)
    {
        var connectionIntent = Interlocked.Increment(ref _connectionIntentRevision);
        if (!_sessionVault.TryRead(out var remembered)) return false;

        try
        {
            var body = JsonSerializer.Serialize(new { refresh_token = remembered.RefreshToken });
            using var request = CreateAuthRequest("refresh_token", body);
            using var response = await _http.SendAsync(request, cancellationToken);
            var responseText = await response.Content.ReadAsStringAsync(cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                if (!IsTransientAuthFailure(response.StatusCode)) _sessionVault.DeleteInvalidVault();
                return false;
            }

            var candidate = ParseSession(responseText, remembered.Email);
            if (!TryReadExpectedAccessTokenClaims(candidate.AccessToken, out var tokenUserId, out _)
                || tokenUserId != remembered.UserId)
            {
                _sessionVault.DeleteInvalidVault();
                return false;
            }
            var authorizedIdentity = await ValidateAuthorizedAutomationIdentityAsync(
                candidate.AccessToken,
                remembered.UserId,
                remembered.WorkspaceId,
                cancellationToken);
            if (authorizedIdentity is null || authorizedIdentity.UserId != remembered.UserId)
                return false;

            if (!string.IsNullOrWhiteSpace(authorizedIdentity.Email))
                candidate = candidate with { Email = authorizedIdentity.Email };
            await _sessionGate.WaitAsync(cancellationToken);
            try
            {
                if (Interlocked.Read(ref _connectionIntentRevision) != connectionIntent)
                    return false;
                PublishSession(
                    candidate,
                    rememberSession: true,
                    advanceConnectionEpoch: true,
                    workspaceId: authorizedIdentity.WorkspaceId,
                    authenticatedUserId: authorizedIdentity.UserId);
                return true;
            }
            finally
            {
                _sessionGate.Release();
            }
        }
        catch (HttpRequestException)
        {
            return false;
        }
        catch (VNextDevelopmentException)
        {
            return false;
        }
    }

    private async Task<bool> AdoptCollectorPairSessionWithTimeoutAsync(
        JsonElement pairResponse,
        string fallbackEmail)
    {
        using var totalTimeout = CancellationTokenSource.CreateLinkedTokenSource(_shutdown.Token);
        totalTimeout.CancelAfter(TimeSpan.FromSeconds(8));
        try
        {
            return await TryAdoptCollectorPairSessionAsync(
                pairResponse,
                fallbackEmail,
                totalTimeout.Token);
        }
        catch (OperationCanceledException)
        {
            return false;
        }
        catch (ObjectDisposedException)
        {
            return false;
        }
    }

    public async Task<bool> TryAdoptCollectorPairSessionAsync(
        JsonElement pairResponse,
        string fallbackEmail,
        CancellationToken cancellationToken = default)
    {
        // 호출이 시작되는 즉시 intent를 발급합니다. 아래 로컬 형식 검사나 원격
        // Auth/RLS 검증과 연결 해제가 겹쳐도 DisconnectAsync가 나중 revision을
        // 기록하므로 이 호출의 늦은 결과는 게시될 수 없습니다.
        var connectionIntent = Interlocked.Increment(ref _connectionIntentRevision);
        if (pairResponse.ValueKind != JsonValueKind.Object
            || !pairResponse.TryGetProperty("automation_ready", out var readyValue)
            || readyValue.ValueKind is not JsonValueKind.True
            || !pairResponse.TryGetProperty("automation_capability", out var capabilityValue)
            || capabilityValue.ValueKind != JsonValueKind.String
            || !string.Equals(capabilityValue.GetString(), AutomationCapability, StringComparison.Ordinal)
            || !pairResponse.TryGetProperty("workspace_id", out var legacyWorkspaceValue)
            || legacyWorkspaceValue.ValueKind != JsonValueKind.String
            || !Guid.TryParseExact(legacyWorkspaceValue.GetString(), "D", out var legacyWorkspaceId)
            || !pairResponse.TryGetProperty("automation_workspace_id", out var automationWorkspaceValue)
            || automationWorkspaceValue.ValueKind != JsonValueKind.String
            || !Guid.TryParseExact(automationWorkspaceValue.GetString(), "D", out var automationWorkspaceId)
            || !string.Equals(
                legacyWorkspaceValue.GetString(),
                automationWorkspaceValue.GetString(),
                StringComparison.Ordinal)
            || legacyWorkspaceId != automationWorkspaceId)
            return false;

        // 서버가 선언한 프로젝트 ref와 URL이 Agent에 고정된 offsl 값과 모두 정확히
        // 일치해야만 세션 후보를 읽습니다. 다른 Supabase 프로젝트의 토큰은
        // /auth/v1/user 또는 refresh 요청에 한 번도 사용하지 않습니다.
        if (!pairResponse.TryGetProperty("automation_project_ref", out var projectRefValue)
            || projectRefValue.ValueKind != JsonValueKind.String
            || !string.Equals(projectRefValue.GetString(), SupabaseProjectRef, StringComparison.Ordinal)
            || !pairResponse.TryGetProperty("automation_project_url", out var projectUrlValue)
            || projectUrlValue.ValueKind != JsonValueKind.String
            || !string.Equals(projectUrlValue.GetString(), SupabaseUrl, StringComparison.Ordinal))
            return false;

        if (!pairResponse.TryGetProperty("automation_session", out var sessionValue)
            || sessionValue.ValueKind != JsonValueKind.Object)
            return false;

        try
        {
            var candidate = ParseSession(sessionValue.GetRawText(), fallbackEmail);
            if (!TryReadExpectedAccessTokenClaims(candidate.AccessToken, out var tokenUserId, out _))
                return false;

            var authorizedIdentity = await ValidateAuthorizedAutomationIdentityAsync(
                candidate.AccessToken,
                tokenUserId,
                automationWorkspaceId.ToString("D"),
                cancellationToken);
            if (authorizedIdentity is null) return false;

            if (!string.IsNullOrWhiteSpace(authorizedIdentity.Email))
                candidate = candidate with { Email = authorizedIdentity.Email };

            using var linked = CreateLinkedCancellation(cancellationToken);
            await _sessionGate.WaitAsync(linked.Token);
            try
            {
                if (Interlocked.Read(ref _connectionIntentRevision) != connectionIntent)
                    return false;
                PublishSession(
                    candidate,
                    rememberSession: true,
                    advanceConnectionEpoch: true,
                    workspaceId: authorizedIdentity.WorkspaceId,
                    authenticatedUserId: authorizedIdentity.UserId);
                return true;
            }
            finally
            {
                _sessionGate.Release();
            }
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return false;
        }
        catch (VNextDevelopmentException)
        {
            return false;
        }
        catch (HttpRequestException)
        {
            return false;
        }
    }

    public async Task<VNextDevelopmentSendResult> SendEventAsync(VNextDevelopmentEvent normalizedEvent, CancellationToken cancellationToken = default)
    {
        var body = JsonSerializer.Serialize(normalizedEvent, _json);
        using var response = await SendWithSessionRecoveryAsync(
            accessToken =>
            {
                var request = new HttpRequestMessage(HttpMethod.Post, SupabaseUrl + "/functions/v1/event-runtime-g3a");
                request.Headers.TryAddWithoutValidation("apikey", PublishableKey);
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
                request.Content = new StringContent(body, Encoding.UTF8, "application/json");
                return request;
            },
            HttpCompletionOption.ResponseContentRead,
            cancellationToken);
        var responseText = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var code = ReadErrorCode(responseText);
            throw new VNextDevelopmentException(
                $"뉴별록 전송 실패 (HTTP {(int)response.StatusCode}, {code})",
                (int)response.StatusCode,
                code);
        }

        return ParseSendResult(responseText);
    }

    private static VNextDevelopmentSendResult ParseSendResult(string responseText)
    {
        try
        {
            using var document = JsonDocument.Parse(responseText);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                throw new VNextDevelopmentException("뉴별록 응답 형식이 올바르지 않습니다.", code: "invalid_response");

            var eventId = root.TryGetProperty("eventId", out var eventIdValue)
                ? eventIdValue.GetString() ?? ""
                : "";
            if (string.IsNullOrWhiteSpace(eventId))
                throw new VNextDevelopmentException("뉴별록 응답에 이벤트 ID가 없습니다.", code: "invalid_response");

            var duplicate = root.TryGetProperty("duplicate", out var duplicateValue)
                && duplicateValue.ValueKind is JsonValueKind.True or JsonValueKind.False
                && duplicateValue.GetBoolean();
            var matchedRuleCount = ArrayLength(root, "matchedRuleIds");
            var queuedExecutionCount = ArrayLength(root, "queuedExecutionIds");
            var completedSucceededCount = 0;
            if (root.TryGetProperty("completed", out var completed) && completed.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in completed.EnumerateArray())
                {
                    if (item.ValueKind == JsonValueKind.Object
                        && item.TryGetProperty("status", out var status)
                        && string.Equals(status.GetString(), "succeeded", StringComparison.OrdinalIgnoreCase))
                    {
                        completedSucceededCount++;
                    }
                }
            }

            return new VNextDevelopmentSendResult(
                eventId,
                duplicate,
                matchedRuleCount,
                queuedExecutionCount,
                completedSucceededCount,
                ReadStringArray(root, "queuedExecutionIds"));
        }
        catch (VNextDevelopmentException)
        {
            throw;
        }
        catch (Exception)
        {
            throw new VNextDevelopmentException("뉴별록 응답을 해석하지 못했습니다.", code: "invalid_response");
        }
    }

    private static int ArrayLength(JsonElement root, string propertyName)
    {
        return root.TryGetProperty(propertyName, out var value) && value.ValueKind == JsonValueKind.Array
            ? value.GetArrayLength()
            : 0;
    }

    private static IReadOnlyList<string> ReadStringArray(JsonElement root, string propertyName)
    {
        if (!root.TryGetProperty(propertyName, out var value) || value.ValueKind != JsonValueKind.Array)
            return Array.Empty<string>();
        return value.EnumerateArray()
            .Where(item => item.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(item.GetString()))
            .Select(item => item.GetString()!)
            .ToArray();
    }

    public async Task<VNextAgentRegistrationResult> RegisterAgentDeviceAsync(
        string deviceId,
        string deviceSecret,
        string? enrollmentToken,
        CancellationToken cancellationToken = default)
    {
        if (!Guid.TryParseExact(deviceId, "D", out var parsedDeviceId))
            throw new VNextDevelopmentException("Agent 장치 식별값이 올바르지 않습니다.", code: "invalid_device");

        var normalizedDeviceId = parsedDeviceId.ToString("D");
        var normalizedSecret = NormalizeDeviceSecret(deviceSecret, "Agent 장치 키");
        var normalizedEnrollment = enrollmentToken is null
            ? null
            : NormalizeDeviceSecret(enrollmentToken, "Agent 등록 토큰");
        var responseText = await SendAgentRequestAsync(new
        {
            operation = "register",
            workspaceId = WorkspaceId,
            deviceId = normalizedDeviceId,
            deviceSecret = normalizedSecret,
            enrollmentToken = normalizedEnrollment
        }, cancellationToken);

        try
        {
            using var document = JsonDocument.Parse(responseText);
            var root = document.RootElement;
            if (!string.Equals(RequiredString(root, "deviceId"), normalizedDeviceId, StringComparison.OrdinalIgnoreCase)
                || !root.TryGetProperty("registered", out var registered)
                || registered.ValueKind != JsonValueKind.True
                || !root.TryGetProperty("created", out var created)
                || created.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            {
                throw new VNextDevelopmentException(
                    "Agent 장치 등록 응답이 올바르지 않습니다.",
                    code: "invalid_agent_response");
            }

            return new VNextAgentRegistrationResult(normalizedDeviceId, created.GetBoolean());
        }
        catch (VNextDevelopmentException)
        {
            throw;
        }
        catch (Exception)
        {
            throw new VNextDevelopmentException(
                "Agent 장치 등록 응답을 해석하지 못했습니다.",
                code: "invalid_agent_response");
        }
    }

    public async Task<VNextAgentSecretRotationResult> RotateAgentDeviceSecretAsync(
        string deviceId,
        string currentDeviceSecret,
        string newDeviceSecret,
        CancellationToken cancellationToken = default)
    {
        if (!Guid.TryParseExact(deviceId, "D", out var parsedDeviceId))
            throw new VNextDevelopmentException("Agent 장치 식별값이 올바르지 않습니다.", code: "invalid_device");
        var normalizedDeviceId = parsedDeviceId.ToString("D");
        var currentSecret = NormalizeDeviceSecret(currentDeviceSecret, "현재 Agent 장치 키");
        var nextSecret = NormalizeDeviceSecret(newDeviceSecret, "새 Agent 장치 키");
        if (string.Equals(currentSecret, nextSecret, StringComparison.Ordinal))
            throw new VNextDevelopmentException("새 Agent 장치 키가 현재 키와 같습니다.", code: "invalid_new_device_secret");

        var responseText = await SendAgentRequestAsync(new
        {
            operation = "rotate_secret",
            workspaceId = WorkspaceId,
            deviceId = normalizedDeviceId,
            deviceSecret = currentSecret,
            newDeviceSecret = nextSecret
        }, cancellationToken);

        try
        {
            using var document = JsonDocument.Parse(responseText);
            var root = document.RootElement;
            var responseDeviceId = RequiredString(root, "deviceId");
            var secretRevision = RequiredLong(root, "secretRevision", 2, long.MaxValue);
            if (!DateTimeOffset.TryParse(RequiredString(root, "rotatedAt"), out var rotatedAt)
                || !DateTimeOffset.TryParse(RequiredString(root, "previousValidUntil"), out var previousValidUntil)
                || previousValidUntil <= rotatedAt
                || !string.Equals(responseDeviceId, normalizedDeviceId, StringComparison.OrdinalIgnoreCase))
                throw new VNextDevelopmentException("Agent 장치 키 회전 응답이 올바르지 않습니다.", code: "invalid_agent_response");
            return new VNextAgentSecretRotationResult(
                normalizedDeviceId,
                secretRevision,
                rotatedAt.ToUniversalTime(),
                previousValidUntil.ToUniversalTime());
        }
        catch (VNextDevelopmentException)
        {
            throw;
        }
        catch
        {
            throw new VNextDevelopmentException(
                "Agent 장치 키 회전 응답을 해석하지 못했습니다.",
                code: "invalid_agent_response");
        }
    }

    public async Task<VNextOverlayAssetManifest> GetOverlayAssetManifestAsync(
        string deviceId,
        string deviceSecret,
        CancellationToken cancellationToken = default)
    {
        if (!Guid.TryParseExact(deviceId, "D", out var parsedDeviceId))
            throw new VNextDevelopmentException("Agent 장치 식별값이 올바르지 않습니다.", code: "invalid_device");
        var responseText = await SendAgentRequestAsync(new
        {
            operation = "overlay_manifest",
            workspaceId = WorkspaceId,
            deviceId = parsedDeviceId.ToString("D"),
            deviceSecret = NormalizeDeviceSecret(deviceSecret, "Agent 장치 키")
        }, cancellationToken);

        try
        {
            using var document = JsonDocument.Parse(responseText);
            var root = document.RootElement;
            if (!root.TryGetProperty("schemaVersion", out var schemaVersion)
                || !schemaVersion.TryGetInt32(out var schema)
                || schema != 1
                || !root.TryGetProperty("generatedAt", out var generatedAtValue)
                || !DateTimeOffset.TryParse(generatedAtValue.GetString(), out var generatedAt)
                || !root.TryGetProperty("assets", out var assetsValue)
                || assetsValue.ValueKind != JsonValueKind.Array
                || assetsValue.GetArrayLength() > 100)
                throw new VNextDevelopmentException("Agent 이미지 manifest 형식이 올바르지 않습니다.", code: "invalid_overlay_manifest");

            var assets = assetsValue.EnumerateArray()
                .Select(item => ParseOverlayAsset(item, manifestItem: true))
                .ToArray();
            if (assets.Select(asset => asset.AssetId).Distinct(StringComparer.OrdinalIgnoreCase).Count() != assets.Length
                || assets.Select(asset => (asset.AssetKey, asset.VersionNumber)).Distinct().Count() != assets.Length)
                throw new VNextDevelopmentException("Agent 이미지 manifest에 중복 항목이 있습니다.", code: "invalid_overlay_manifest");
            return new VNextOverlayAssetManifest(schema, generatedAt, assets);
        }
        catch (VNextDevelopmentException)
        {
            throw;
        }
        catch
        {
            throw new VNextDevelopmentException("Agent 이미지 manifest를 해석하지 못했습니다.", code: "invalid_overlay_manifest");
        }
    }

    public async Task<VNextAgentDeviceStatusResult> ReportAgentDeviceStatusAsync(
        string deviceId,
        string deviceSecret,
        string agentVersion,
        string platform,
        IReadOnlyCollection<string> supportedActionTypes,
        bool overlayAssetsReady,
        int managedOverlayAssets,
        IReadOnlyCollection<VNextReadyOverlayAsset> readyOverlayAssets,
        VNextCollectionHealth collectionHealth,
        CancellationToken cancellationToken = default)
    {
        if (!Guid.TryParseExact(deviceId, "D", out var parsedDeviceId))
            throw new VNextDevelopmentException("Agent 장치 식별값이 올바르지 않습니다.", code: "invalid_device");
        if (string.IsNullOrWhiteSpace(agentVersion)
            || agentVersion.Length > 64
            || !Regex.IsMatch(agentVersion, "^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$", RegexOptions.CultureInvariant))
            throw new VNextDevelopmentException("Agent 버전이 올바르지 않습니다.", code: "invalid_device_status");
        if (platform is not ("windows" or "linux" or "macos" or "unknown"))
            throw new VNextDevelopmentException("Agent 운영체제가 올바르지 않습니다.", code: "invalid_device_status");
        if (managedOverlayAssets is < 0 or > 100)
            throw new VNextDevelopmentException("Agent 관리 이미지 수가 올바르지 않습니다.", code: "invalid_device_status");
        if (readyOverlayAssets is null || readyOverlayAssets.Count > 100)
            throw new VNextDevelopmentException("Agent 정확 이미지 준비 목록이 올바르지 않습니다.", code: "invalid_device_status");
        if (collectionHealth is null
            || collectionHealth.State is not ("active" or "idle" or "recovering" or "error"))
            throw new VNextDevelopmentException("수집 상태가 올바르지 않습니다.", code: "invalid_collection_health");

        var normalizedReadyOverlayAssets = new List<VNextReadyOverlayAsset>(readyOverlayAssets.Count);
        var readyIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in readyOverlayAssets)
        {
            if (!Guid.TryParseExact(item.AssetId, "D", out var assetId)
                || !Sha256Pattern.IsMatch(item.ContentSha256)
                || !readyIds.Add(assetId.ToString("D")))
                throw new VNextDevelopmentException("Agent 정확 이미지 준비 목록이 올바르지 않습니다.", code: "invalid_device_status");
            normalizedReadyOverlayAssets.Add(new VNextReadyOverlayAsset(
                assetId.ToString("D"),
                item.ContentSha256));
        }
        normalizedReadyOverlayAssets.Sort((left, right) =>
            string.Compare(left.AssetId, right.AssetId, StringComparison.Ordinal));

        var normalizedDeviceId = parsedDeviceId.ToString("D");
        var normalizedActionTypes = NormalizeSupportedActionTypes(supportedActionTypes);
        var normalizedSecret = NormalizeDeviceSecret(deviceSecret, "Agent 장치 키");
        try
        {
            // Telemetry is not latency-sensitive.  Send both Agent liveness and
            // collector health in one authenticated PostgREST round-trip so an
            // idle Agent consumes no Edge Function invocation.
            var directResponse = await SendDirectRpcAsync(
                "g3a_agent_direct_report_v1",
                new
                {
                    p_workspace_id = WorkspaceId,
                    p_device_id = normalizedDeviceId,
                    p_device_secret_hash = DeviceSecretSha256(normalizedSecret),
                    p_agent_version = agentVersion,
                    p_platform = platform,
                    p_supported_action_types = normalizedActionTypes,
                    p_collection_state = collectionHealth.State,
                    p_session_started_at = collectionHealth.SessionStartedAt,
                    p_last_observed_at = collectionHealth.LastObservedAt,
                    p_last_upload_at = collectionHealth.LastUploadAt
                },
                cancellationToken,
                preserveNulls: true);
            return ParseDeviceStatusResponse(directResponse, normalizedDeviceId);
        }
        catch (Exception ex) when (
            ex is not OperationCanceledException
            && (DirectTransportCanFallback(ex)
                || ex is JsonException
                || ex is VNextDevelopmentException { Code: "invalid_agent_response" }))
        {
            // Rollout safety: the current action Edge accepts the combined
            // payload while a database migration or PostgREST schema refresh
            // is still converging. This fallback does not affect action claim.
            var edgeResponse = await SendAgentRequestAsync(new
            {
                operation = "device_status",
                workspaceId = WorkspaceId,
                deviceId = normalizedDeviceId,
                deviceSecret = normalizedSecret,
                agentVersion,
                platform,
                supportedActionTypes = normalizedActionTypes,
                overlayAssetsReady,
                managedOverlayAssets,
                readyOverlayAssets = normalizedReadyOverlayAssets,
                collectionState = collectionHealth.State,
                sessionStartedAt = collectionHealth.SessionStartedAt,
                lastObservedAt = collectionHealth.LastObservedAt,
                lastUploadAt = collectionHealth.LastUploadAt
            }, cancellationToken, preserveNulls: true);
            return ParseDeviceStatusResponse(edgeResponse, normalizedDeviceId);
        }
    }

    private static VNextAgentDeviceStatusResult ParseDeviceStatusResponse(
        string responseText,
        string normalizedDeviceId)
    {
        try
        {
            using var document = JsonDocument.Parse(responseText);
            var root = document.RootElement;
            var responseDeviceId = RequiredString(root, "deviceId");
            if (!string.Equals(responseDeviceId, normalizedDeviceId, StringComparison.OrdinalIgnoreCase)
                || !root.TryGetProperty("reportedAt", out var reportedAtValue)
                || reportedAtValue.ValueKind != JsonValueKind.String
                || !DateTimeOffset.TryParse(reportedAtValue.GetString(), out var reportedAt))
                throw new VNextDevelopmentException("Agent 상태 보고 응답이 올바르지 않습니다.", code: "invalid_agent_response");
            return new VNextAgentDeviceStatusResult(normalizedDeviceId, reportedAt);
        }
        catch (VNextDevelopmentException)
        {
            throw;
        }
        catch
        {
            throw new VNextDevelopmentException("Agent 상태 보고 응답을 해석하지 못했습니다.", code: "invalid_agent_response");
        }
    }

    public async Task<byte[]> DownloadOverlayAssetAsync(
        VNextOverlayAssetDescriptor asset,
        CancellationToken cancellationToken = default)
    {
        if (asset.DeliveryMode != "managed_bundle"
            || string.IsNullOrWhiteSpace(asset.DownloadPath)
            || !OverlayDownloadPathPattern.IsMatch(asset.DownloadPath))
            throw new VNextDevelopmentException("관리 이미지 다운로드 경로가 올바르지 않습니다.", code: "invalid_overlay_path");

        var encodedPath = string.Join('/', asset.DownloadPath.Split('/').Select(Uri.EscapeDataString));
        using var response = await SendWithSessionRecoveryAsync(
            accessToken =>
            {
                var request = new HttpRequestMessage(
                    HttpMethod.Get,
                    SupabaseUrl + "/storage/v1/object/authenticated/byeollog-overlay-assets/" + encodedPath);
                request.Headers.TryAddWithoutValidation("apikey", PublishableKey);
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
                request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue(asset.MimeType));
                return request;
            },
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new VNextDevelopmentException(
                $"Agent 이미지 다운로드 실패 (HTTP {(int)response.StatusCode})",
                (int)response.StatusCode,
                "overlay_download_failed");
        if (response.Content.Headers.ContentLength is long declaredLength
            && (declaredLength > asset.ByteSize || declaredLength > MaximumOverlayAssetBytes))
            throw new VNextDevelopmentException("Agent 이미지 응답 크기가 제한을 초과했습니다.", code: "overlay_download_too_large");
        var contentType = response.Content.Headers.ContentType?.MediaType;
        if (!string.IsNullOrWhiteSpace(contentType)
            && !string.Equals(contentType, asset.MimeType, StringComparison.OrdinalIgnoreCase))
            throw new VNextDevelopmentException("Agent 이미지 MIME 형식이 manifest와 다릅니다.", code: "overlay_download_mime_mismatch");

        await using var source = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var destination = new MemoryStream(Math.Min(asset.ByteSize, MaximumOverlayAssetBytes));
        var buffer = new byte[32 * 1024];
        while (true)
        {
            var read = await source.ReadAsync(buffer, cancellationToken);
            if (read == 0) break;
            if (destination.Length + read > asset.ByteSize || destination.Length + read > MaximumOverlayAssetBytes)
                throw new VNextDevelopmentException("Agent 이미지 응답 크기가 manifest와 다릅니다.", code: "overlay_download_too_large");
            await destination.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
        }
        return destination.ToArray();
    }

    public async Task<VNextAgentClaimResult> ClaimAgentExecutionWithWallpaperAsync(
        string deviceId,
        string deviceSecret,
        IReadOnlyCollection<string> supportedActionTypes,
        long? knownWallpaperRevision,
        int leaseSeconds = 45,
        CancellationToken cancellationToken = default)
    {
        if (!Guid.TryParseExact(deviceId, "D", out var parsedDeviceId))
            throw new VNextDevelopmentException("Agent 장치 식별값이 올바르지 않습니다.", code: "invalid_device");
        var normalizedDeviceId = parsedDeviceId.ToString("D");
        var normalizedSecret = NormalizeDeviceSecret(deviceSecret, "Agent 장치 키");
        var normalizedActionTypes = NormalizeSupportedActionTypes(supportedActionTypes);
        var responseText = await SendAgentRequestAsync(new
        {
            operation = "claim",
            workspaceId = WorkspaceId,
            deviceId = normalizedDeviceId,
            deviceSecret = normalizedSecret,
            leaseSeconds,
            supportedActionTypes = normalizedActionTypes,
            knownWallpaperRevision,
            wallpaperSchemaVersion = WallpaperSchemaVersion
        }, cancellationToken);

        try
        {
            using var document = JsonDocument.Parse(responseText);
            var root = document.RootElement;
            VNextWallpaperSync? wallpaper = null;
            if (root.TryGetProperty("wallpaper", out var wallpaperValue))
            {
                if (wallpaperValue.ValueKind != JsonValueKind.Object
                    || !wallpaperValue.TryGetProperty("changed", out var changedValue)
                    || changedValue.ValueKind is not (JsonValueKind.True or JsonValueKind.False)
                    || !wallpaperValue.TryGetProperty("revision", out var revisionValue)
                    || !revisionValue.TryGetInt64(out var wallpaperRevision)
                    || wallpaperRevision < 0)
                    throw new VNextDevelopmentException("풍벽지 동기화 응답 형식이 올바르지 않습니다.", code: "invalid_agent_response");
                var changed = changedValue.GetBoolean();
                var unavailable = wallpaperValue.TryGetProperty("unavailable", out var unavailableValue)
                    && unavailableValue.ValueKind == JsonValueKind.True;
                JsonElement? state = null;
                if (changed)
                {
                    if (!wallpaperValue.TryGetProperty("state", out var stateValue)
                        || stateValue.ValueKind != JsonValueKind.Object
                        || !IsValidWallpaperState(stateValue, wallpaperRevision))
                        throw new VNextDevelopmentException("풍벽지 상태 응답 형식이 올바르지 않습니다.", code: "invalid_agent_response");
                    state = stateValue.Clone();
                }
                wallpaper = new VNextWallpaperSync(changed, wallpaperRevision, unavailable, state);
            }
            if (!root.TryGetProperty("job", out var job) || job.ValueKind == JsonValueKind.Null)
                return new VNextAgentClaimResult(null, wallpaper);
            if (job.ValueKind != JsonValueKind.Object)
                throw new VNextDevelopmentException("Agent claim 응답 형식이 올바르지 않습니다.", code: "invalid_agent_response");

            var executionId = RequiredString(job, "executionId");
            var idempotencyKey = RequiredString(job, "idempotencyKey");
            var workspaceId = RequiredString(job, "workspaceId");
            var eventId = RequiredString(job, "eventId");
            var executionTarget = RequiredString(job, "executionTarget");
            var agentDeviceId = RequiredString(job, "agentDeviceId");
            var actionType = RequiredString(job, "actionType");
            if (!Guid.TryParseExact(executionId, "D", out var parsedExecutionId)
                || !Guid.TryParseExact(eventId, "D", out var parsedEventId)
                || !Sha256Pattern.IsMatch(idempotencyKey)
                || executionTarget != "local_agent"
                || workspaceId != WorkspaceId)
                throw new VNextDevelopmentException("Agent claim 실행 경계가 올바르지 않습니다.", code: "invalid_agent_response");
            if (!string.Equals(agentDeviceId, normalizedDeviceId, StringComparison.OrdinalIgnoreCase))
                throw new VNextDevelopmentException("다른 장치에 지정된 Agent 작업입니다.", code: "invalid_agent_response");
            if (!normalizedActionTypes.Contains(actionType, StringComparer.Ordinal))
                throw new VNextDevelopmentException("지원하지 않는 Agent 액션이 전달되었습니다.", code: "invalid_agent_response");
            if (!job.TryGetProperty("actionParams", out var actionParams) || actionParams.ValueKind != JsonValueKind.Object)
                throw new VNextDevelopmentException("Agent actionParams 형식이 올바르지 않습니다.", code: "invalid_agent_response");
            if (!job.TryGetProperty("leaseExpiresAt", out var leaseValue)
                || !DateTimeOffset.TryParse(leaseValue.GetString(), out var leaseExpiresAt))
                throw new VNextDevelopmentException("Agent lease 형식이 올바르지 않습니다.", code: "invalid_agent_response");

            VNextOverlayAssetDescriptor? overlayAsset = null;
            if (job.TryGetProperty("overlayAsset", out var overlayValue)
                && overlayValue.ValueKind != JsonValueKind.Null)
                overlayAsset = ParseOverlayAsset(overlayValue, manifestItem: false);
            var hasLegacyOverlayKey = actionParams.TryGetProperty("overlayAssetKey", out var legacyOverlayKeyValue);
            var hasPackagedOverlayKey = actionParams.TryGetProperty("overlayImageKey", out var packagedOverlayKeyValue);
            if (hasLegacyOverlayKey && hasPackagedOverlayKey)
                throw new VNextDevelopmentException("Agent 작업의 오버레이 이미지 키가 중복되었습니다.", code: "invalid_agent_response");
            var overlayKeyValue = hasPackagedOverlayKey ? packagedOverlayKeyValue : legacyOverlayKeyValue;
            var overlayAssetKey = (hasLegacyOverlayKey || hasPackagedOverlayKey)
                && overlayKeyValue.ValueKind == JsonValueKind.String
                ? overlayKeyValue.GetString()
                : null;
            var overlayAssetId = actionParams.TryGetProperty("overlayAssetId", out var overlayIdValue)
                && overlayIdValue.ValueKind == JsonValueKind.String
                ? overlayIdValue.GetString()
                : null;
            if (overlayAssetKey is not null && overlayAssetId is not null)
                throw new VNextDevelopmentException("Agent 작업의 오버레이 이미지 연결이 중복되었습니다.", code: "invalid_agent_response");
            if (overlayAsset is not null)
            {
                var isTimedMute = actionType == TimedMuteActionAdapter.ObsActionType
                    || actionType == TimedMuteActionAdapter.WindowsActionType;
                var matchesReference = overlayAssetKey is not null
                    ? string.Equals(overlayAsset.AssetKey, overlayAssetKey, StringComparison.Ordinal)
                    : overlayAssetId is not null
                        && string.Equals(overlayAsset.AssetId, overlayAssetId, StringComparison.OrdinalIgnoreCase);
                if (!isTimedMute || !matchesReference)
                    throw new VNextDevelopmentException("Agent 작업의 오버레이 이미지 연결이 올바르지 않습니다.", code: "invalid_agent_response");
            }
            if (overlayAssetKey is not null && overlayAsset is null
                && !OverlayAssetCache.IsPackagedImageKey(overlayAssetKey))
                throw new VNextDevelopmentException("Agent 작업의 오버레이 이미지가 이 버전에 포함되어 있지 않습니다.", code: "invalid_agent_response");
            if (overlayAssetId is not null && overlayAsset is null
                && !OverlayAssetCache.TryMapBuiltInAssetIdToKey(overlayAssetId, out _))
                throw new VNextDevelopmentException("Agent 작업의 오버레이 이미지 버전이 없습니다.", code: "invalid_agent_response");

            var parsedJob = new VNextAgentJob(
                parsedExecutionId.ToString("D"),
                idempotencyKey,
                workspaceId,
                parsedEventId.ToString("D"),
                executionTarget,
                agentDeviceId.ToLowerInvariant(),
                actionType,
                actionParams.Clone(),
                RequiredInt(job, "timeoutMs", 100, 300_000),
                RequiredInt(job, "attemptNo", 1, 20),
                RequiredInt(job, "maxAttempts", 1, 20),
                RequiredInt(job, "retryBackoffSeconds", 1, 86_400),
                leaseExpiresAt,
                overlayAsset);
            return new VNextAgentClaimResult(parsedJob, wallpaper);
        }
        catch (VNextDevelopmentException)
        {
            throw;
        }
        catch (Exception)
        {
            throw new VNextDevelopmentException("Agent claim 응답을 해석하지 못했습니다.", code: "invalid_agent_response");
        }
    }

    public async Task<VNextWallpaperSync> GetWallpaperSnapshotAsync(
        string deviceId,
        string deviceSecret,
        long knownWallpaperRevision,
        CancellationToken cancellationToken = default)
    {
        if (!Guid.TryParseExact(deviceId, "D", out var parsedDeviceId) || knownWallpaperRevision < 0)
            throw new VNextDevelopmentException("풍벽지 동기화 요청값이 올바르지 않습니다.", code: "invalid_wallpaper_request");
        var normalizedDeviceId = parsedDeviceId.ToString("D");
        var normalizedSecret = NormalizeDeviceSecret(deviceSecret, "Agent 장치 키");
        try
        {
            var directResponse = await SendDirectRpcAsync(
                "g3a_agent_direct_wallpaper_snapshot_v1",
                new
                {
                    p_workspace_id = WorkspaceId,
                    p_known_revision = knownWallpaperRevision,
                    p_device_id = normalizedDeviceId,
                    p_device_secret_hash = DeviceSecretSha256(normalizedSecret)
                },
                cancellationToken);
            using var directDocument = JsonDocument.Parse(directResponse);
            return AgentWallpaperSnapshotMapper.Build(
                directDocument.RootElement,
                WorkspaceId,
                SupabaseUrl);
        }
        catch (Exception ex) when (
            ex is not OperationCanceledException
            && (DirectTransportCanFallback(ex)
                || ex is JsonException or InvalidDataException))
        {
            // A malformed/newer direct snapshot cannot blank OBS. Keep the
            // already proven Edge renderer as a compatibility recovery path.
        }

        var responseText = await SendAgentRequestAsync(new
        {
            operation = "wallpaper",
            workspaceId = WorkspaceId,
            deviceId = normalizedDeviceId,
            deviceSecret = normalizedSecret,
            knownWallpaperRevision,
            wallpaperSchemaVersion = WallpaperSchemaVersion
        }, cancellationToken);
        try
        {
            using var document = JsonDocument.Parse(responseText);
            var root = document.RootElement;
            if (!root.TryGetProperty("wallpaper", out var wallpaperValue)
                || wallpaperValue.ValueKind != JsonValueKind.Object
                || !wallpaperValue.TryGetProperty("changed", out var changedValue)
                || changedValue.ValueKind is not (JsonValueKind.True or JsonValueKind.False)
                || !wallpaperValue.TryGetProperty("revision", out var revisionValue)
                || !revisionValue.TryGetInt64(out var wallpaperRevision)
                || wallpaperRevision < 0)
                throw new VNextDevelopmentException("풍벽지 동기화 응답 형식이 올바르지 않습니다.", code: "invalid_agent_response");
            var changed = changedValue.GetBoolean();
            var unavailable = wallpaperValue.TryGetProperty("unavailable", out var unavailableValue)
                && unavailableValue.ValueKind == JsonValueKind.True;
            JsonElement? state = null;
            if (changed)
            {
                if (!wallpaperValue.TryGetProperty("state", out var stateValue)
                    || stateValue.ValueKind != JsonValueKind.Object
                    || !IsValidWallpaperState(stateValue, wallpaperRevision))
                    throw new VNextDevelopmentException("풍벽지 상태 응답 형식이 올바르지 않습니다.", code: "invalid_agent_response");
                state = stateValue.Clone();
            }
            return new VNextWallpaperSync(changed, wallpaperRevision, unavailable, state);
        }
        catch (VNextDevelopmentException)
        {
            throw;
        }
        catch (Exception)
        {
            throw new VNextDevelopmentException("풍벽지 동기화 응답을 해석하지 못했습니다.", code: "invalid_agent_response");
        }
    }

    public async Task<bool> HasPendingAgentExecutionAsync(
        string deviceId,
        string deviceSecret,
        IReadOnlyCollection<string> supportedActionTypes,
        CancellationToken cancellationToken = default)
    {
        if (!Guid.TryParseExact(deviceId, "D", out var parsedDeviceId))
            throw new VNextDevelopmentException("Agent 장치 식별값이 올바르지 않습니다.", code: "invalid_device");
        var normalizedSecret = NormalizeDeviceSecret(deviceSecret, "Agent 장치 키");
        var responseText = await SendDirectRpcAsync(
            "g3a_agent_direct_pending_v1",
            new
            {
                p_workspace_id = WorkspaceId,
                p_device_id = parsedDeviceId.ToString("D"),
                p_device_secret_hash = DeviceSecretSha256(normalizedSecret),
                p_supported_action_types = NormalizeSupportedActionTypes(supportedActionTypes)
            },
            cancellationToken);
        try
        {
            using var document = JsonDocument.Parse(responseText);
            if (document.RootElement.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                throw new VNextDevelopmentException("Agent 안전 점검 응답이 올바르지 않습니다.", code: "invalid_agent_response");
            return document.RootElement.GetBoolean();
        }
        catch (VNextDevelopmentException)
        {
            throw;
        }
        catch
        {
            throw new VNextDevelopmentException("Agent 안전 점검 응답을 해석하지 못했습니다.", code: "invalid_agent_response");
        }
    }

    public async Task<VNextAgentJob?> ClaimAgentExecutionAsync(
        string deviceId,
        string deviceSecret,
        IReadOnlyCollection<string> supportedActionTypes,
        int leaseSeconds = 45,
        CancellationToken cancellationToken = default) =>
        (await ClaimAgentExecutionWithWallpaperAsync(
            deviceId,
            deviceSecret,
            supportedActionTypes,
            knownWallpaperRevision: null,
            leaseSeconds,
            cancellationToken)).Job;

    private static bool IsValidWallpaperState(JsonElement state, long expectedRevision)
    {
        if (!state.TryGetProperty("schemaVersion", out var schemaValue)
            || !schemaValue.TryGetInt32(out var schemaVersion)
            || schemaVersion is not (1 or 2)
            || !state.TryGetProperty("revision", out var stateRevisionValue)
            || !stateRevisionValue.TryGetInt64(out var stateRevision)
            || stateRevision != expectedRevision
            || !state.TryGetProperty("tiles", out var tilesValue)
            || tilesValue.ValueKind != JsonValueKind.Array
            || tilesValue.GetArrayLength() > 216)
            return false;
        return schemaVersion != 2
            || state.TryGetProperty("assets", out var assetsValue)
                && assetsValue.ValueKind == JsonValueKind.Array
                && assetsValue.GetArrayLength() <= 216;
    }

    public Task<RaffleWinnerSpeechDownload> DownloadRaffleWinnerSpeechAsync(
        string deviceId,
        string deviceSecret,
        string executionId,
        int attemptNo,
        int winnerOrdinal,
        string expectedVoiceKey,
        CancellationToken cancellationToken = default)
    {
        if (!Guid.TryParseExact(deviceId, "D", out var parsedDeviceId)
            || !Guid.TryParseExact(executionId, "D", out var parsedExecutionId)
            || attemptNo is < 1 or > 10
            || winnerOrdinal is < 0 or > 99
            || !Sha256Pattern.IsMatch(expectedVoiceKey))
            throw new VNextDevelopmentException(
                "당첨 음성 실행 식별값이 올바르지 않습니다.",
                code: "invalid_raffle_speech_request");

        return DownloadRaffleSpeechAsync(
            deviceId,
            deviceSecret,
            expectedVoiceKey,
            new
            {
                operation = "raffle_winner_tts",
                workspaceId = WorkspaceId,
                deviceId = parsedDeviceId.ToString("D"),
                deviceSecret = NormalizeDeviceSecret(deviceSecret, "Agent 장치 키"),
                executionId = parsedExecutionId.ToString("D"),
                attemptNo,
                winnerOrdinal,
                expectedVoiceKey
            },
            cancellationToken);
    }

    public async Task<RaffleTtsCandidateBatch> ListRaffleTtsCandidatesAsync(
        string deviceId,
        string deviceSecret,
        string drawId,
        string? cursor = null,
        int limit = 25,
        CancellationToken cancellationToken = default)
    {
        if (!Guid.TryParseExact(deviceId, "D", out var parsedDeviceId)
            || !Guid.TryParseExact(drawId, "D", out var parsedDrawId)
            || limit is < 1 or > 25
            || (cursor is not null && !TryNormalizeRaffleActorKey(cursor, out _)))
            throw new VNextDevelopmentException(
                "추첨 후보 음성 요청 식별값이 올바르지 않습니다.",
                code: "invalid_raffle_speech_request");

        var body = JsonSerializer.Serialize(new
        {
            operation = "raffle_tts_candidates",
            workspaceId = WorkspaceId,
            deviceId = parsedDeviceId.ToString("D"),
            deviceSecret = NormalizeDeviceSecret(deviceSecret, "Agent 장치 키"),
            drawId = parsedDrawId.ToString("D"),
            afterActorKey = cursor,
            limit
        }, _json);
        using var response = await SendWithSessionRecoveryAsync(
            accessToken =>
            {
                var request = new HttpRequestMessage(
                    HttpMethod.Post,
                    SupabaseUrl + "/functions/v1/agent-runtime-g3a");
                request.Headers.TryAddWithoutValidation("apikey", PublishableKey);
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
                request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
                request.Content = new StringContent(body, Encoding.UTF8, "application/json");
                return request;
            },
            HttpCompletionOption.ResponseContentRead,
            cancellationToken);
        var responseText = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var code = ReadErrorCode(responseText);
            if (code is "recent_authentication_required" or "device_session_already_used")
                await InvalidateCurrentSessionPermanentlyAsync(cancellationToken);
            throw RaffleSpeechRequestException(response.StatusCode, code);
        }

        try
        {
            using var document = JsonDocument.Parse(responseText);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || root.EnumerateObject().Count() != 4
                || !root.TryGetProperty("drawId", out var returnedDrawId)
                || returnedDrawId.ValueKind != JsonValueKind.String
                || !string.Equals(returnedDrawId.GetString(), parsedDrawId.ToString("D"), StringComparison.OrdinalIgnoreCase)
                || !root.TryGetProperty("totalCount", out var totalCountValue)
                || !totalCountValue.TryGetInt32(out var totalCount)
                || totalCount is < 0 or > 100_000
                || !root.TryGetProperty("candidates", out var candidatesValue)
                || candidatesValue.ValueKind != JsonValueKind.Array
                || candidatesValue.GetArrayLength() > limit)
                throw new FormatException();

            var candidates = new List<RaffleTtsCandidate>(candidatesValue.GetArrayLength());
            var actorKeys = new HashSet<string>(StringComparer.Ordinal);
            var previousActorKey = cursor;
            foreach (var candidate in candidatesValue.EnumerateArray())
            {
                if (candidate.ValueKind != JsonValueKind.Object
                    || candidate.EnumerateObject().Count() != 3
                    || !candidate.TryGetProperty("actorKey", out var actorKeyValue)
                    || actorKeyValue.ValueKind != JsonValueKind.String
                    || !TryNormalizeRaffleActorKey(actorKeyValue.GetString(), out var actorKey)
                    || !actorKeys.Add(actorKey)
                    || !candidate.TryGetProperty("actorName", out var actorNameValue)
                    || actorNameValue.ValueKind != JsonValueKind.String
                    || !TryNormalizeRaffleActorName(actorNameValue.GetString(), out var actorName)
                    || !candidate.TryGetProperty("voiceKey", out var voiceKeyValue)
                    || voiceKeyValue.ValueKind != JsonValueKind.String
                    || !Sha256Pattern.IsMatch(voiceKeyValue.GetString() ?? "")
                    || !CryptographicOperations.FixedTimeEquals(
                        Convert.FromHexString(RaffleWinnerSpeechCache.ComputeVoiceKey(actorName)),
                        Convert.FromHexString(voiceKeyValue.GetString()!)))
                    throw new FormatException();
                if (previousActorKey is not null
                    && StringComparer.Ordinal.Compare(actorKey, previousActorKey) <= 0)
                    throw new FormatException();
                candidates.Add(new RaffleTtsCandidate(
                    actorKey,
                    actorName,
                    voiceKeyValue.GetString()!));
                previousActorKey = actorKey;
            }

            string? nextCursor = null;
            if (root.TryGetProperty("nextCursor", out var nextCursorValue)
                && nextCursorValue.ValueKind != JsonValueKind.Null)
            {
                if (nextCursorValue.ValueKind != JsonValueKind.String
                    || !TryNormalizeRaffleActorKey(nextCursorValue.GetString(), out var parsedCursor))
                    throw new FormatException();
                nextCursor = parsedCursor;
            }
            if (nextCursor is not null
                && (candidates.Count == 0
                    || !string.Equals(nextCursor, candidates[^1].ActorKey, StringComparison.Ordinal)))
                throw new FormatException();

            return new RaffleTtsCandidateBatch(
                parsedDrawId.ToString("D"),
                totalCount,
                candidates,
                nextCursor);
        }
        catch (VNextDevelopmentException)
        {
            throw;
        }
        catch (Exception)
        {
            throw new VNextDevelopmentException(
                "추첨 후보 음성 목록을 해석하지 못했습니다.",
                code: "invalid_raffle_speech_response");
        }
    }

    public Task<RaffleWinnerSpeechDownload> DownloadRaffleCandidateSpeechAsync(
        string deviceId,
        string deviceSecret,
        string drawId,
        string actorKey,
        string expectedVoiceKey,
        CancellationToken cancellationToken = default)
    {
        if (!Guid.TryParseExact(deviceId, "D", out var parsedDeviceId)
            || !Guid.TryParseExact(drawId, "D", out var parsedDrawId)
            || !TryNormalizeRaffleActorKey(actorKey, out var parsedActorKey)
            || !Sha256Pattern.IsMatch(expectedVoiceKey))
            throw new VNextDevelopmentException(
                "추첨 후보 음성 요청 식별값이 올바르지 않습니다.",
                code: "invalid_raffle_speech_request");

        return DownloadRaffleSpeechAsync(
            deviceId,
            deviceSecret,
            expectedVoiceKey,
            new
            {
                operation = "raffle_candidate_tts",
                workspaceId = WorkspaceId,
                deviceId = parsedDeviceId.ToString("D"),
                deviceSecret = NormalizeDeviceSecret(deviceSecret, "Agent 장치 키"),
                drawId = parsedDrawId.ToString("D"),
                actorKey = parsedActorKey,
                expectedVoiceKey
            },
            cancellationToken);
    }

    private async Task<RaffleWinnerSpeechDownload> DownloadRaffleSpeechAsync(
        string deviceId,
        string deviceSecret,
        string expectedVoiceKey,
        object requestBody,
        CancellationToken cancellationToken)
    {
        if (!Guid.TryParseExact(deviceId, "D", out _)
            || !Sha256Pattern.IsMatch(expectedVoiceKey))
            throw new VNextDevelopmentException(
                "당첨 음성 실행 식별값이 올바르지 않습니다.",
                code: "invalid_raffle_speech_request");

        _ = NormalizeDeviceSecret(deviceSecret, "Agent 장치 키");
        var body = JsonSerializer.Serialize(requestBody, _json);
        using var response = await SendWithSessionRecoveryAsync(
            accessToken =>
            {
                var request = new HttpRequestMessage(
                    HttpMethod.Post,
                    SupabaseUrl + "/functions/v1/agent-runtime-g3a");
                request.Headers.TryAddWithoutValidation("apikey", PublishableKey);
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
                request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("audio/wav"));
                request.Content = new StringContent(body, Encoding.UTF8, "application/json");
                return request;
            },
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var responseText = await response.Content.ReadAsStringAsync(cancellationToken);
            var code = ReadErrorCode(responseText);
            if (code is "recent_authentication_required" or "device_session_already_used")
                await InvalidateCurrentSessionPermanentlyAsync(cancellationToken);
            throw RaffleSpeechRequestException(response.StatusCode, code);
        }

        var contentType = response.Content.Headers.ContentType?.MediaType;
        if (!string.Equals(contentType, "audio/wav", StringComparison.OrdinalIgnoreCase))
            throw new VNextDevelopmentException(
                "당첨 음성 응답 형식이 올바르지 않습니다.",
                code: "invalid_raffle_speech_response");
        if (response.Content.Headers.ContentLength is long declaredLength
            && (declaredLength is < 44 or > MaximumRaffleWinnerAudioBytes))
            throw new VNextDevelopmentException(
                "당첨 음성 응답 크기가 제한을 초과했습니다.",
                code: "raffle_speech_too_large");
        if (!response.Headers.TryGetValues("x-byeollog-audio-sha256", out var hashValues))
            throw new VNextDevelopmentException(
                "당첨 음성 무결성 정보가 없습니다.",
                code: "invalid_raffle_speech_response");
        var expectedHash = hashValues.SingleOrDefault()?.Trim().ToLowerInvariant();
        if (expectedHash is null || !Sha256Pattern.IsMatch(expectedHash))
            throw new VNextDevelopmentException(
                "당첨 음성 무결성 정보가 올바르지 않습니다.",
                code: "invalid_raffle_speech_response");
        if (!response.Headers.TryGetValues("x-byeollog-voice-key", out var voiceKeyValues)
            || voiceKeyValues.Count() != 1)
            throw new VNextDevelopmentException(
                "당첨 음성 대상 식별 정보가 없습니다.",
                code: "invalid_raffle_speech_response");
        var returnedVoiceKey = voiceKeyValues.Single().Trim().ToLowerInvariant();
        if (!Sha256Pattern.IsMatch(returnedVoiceKey)
            || !CryptographicOperations.FixedTimeEquals(
                Convert.FromHexString(returnedVoiceKey),
                Convert.FromHexString(expectedVoiceKey)))
            throw new VNextDevelopmentException(
                "요청한 당첨자와 음성 대상이 일치하지 않습니다.",
                code: "raffle_speech_identity_mismatch");
        if (!response.Headers.TryGetValues("x-byeollog-voice-version", out var versionValues)
            || versionValues.Count() != 1)
            throw new VNextDevelopmentException(
                "당첨 음성 버전 정보가 없습니다.",
                code: "invalid_raffle_speech_response");
        var voiceVersion = versionValues.Single().Trim();
        if (!VoiceVersionPattern.IsMatch(voiceVersion))
            throw new VNextDevelopmentException(
                "당첨 음성 버전 정보가 올바르지 않습니다.",
                code: "invalid_raffle_speech_response");

        await using var source = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var destination = new MemoryStream();
        var buffer = new byte[32 * 1024];
        while (true)
        {
            var read = await source.ReadAsync(buffer, cancellationToken);
            if (read == 0) break;
            if (destination.Length + read > MaximumRaffleWinnerAudioBytes)
                throw new VNextDevelopmentException(
                    "당첨 음성 응답 크기가 제한을 초과했습니다.",
                    code: "raffle_speech_too_large");
            await destination.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
        }
        var audio = destination.ToArray();
        if (audio.Length < 44
            || !CryptographicOperations.FixedTimeEquals(
                SHA256.HashData(audio),
                Convert.FromHexString(expectedHash)))
            throw new VNextDevelopmentException(
                "당첨 음성 응답 무결성 검증에 실패했습니다.",
                code: "raffle_speech_hash_mismatch");
        ByeollogRaffleAudio.ValidateWinnerAudioForPreflight(audio);
        return new RaffleWinnerSpeechDownload(
            audio,
            returnedVoiceKey,
            voiceVersion,
            expectedHash);
    }

    private static VNextDevelopmentException RaffleSpeechRequestException(
        HttpStatusCode statusCode,
        string code) =>
        new(
            code switch
            {
                "raffle_tts_unavailable" => "당첨 음성 서버가 아직 준비되지 않았습니다.",
                "execution_state_conflict" => "당첨 음성 요청이 현재 실행 상태와 일치하지 않습니다.",
                "device_auth_failed" => "이 PC의 장치 키가 서버 등록 정보와 일치하지 않습니다.",
                "voice_identity_mismatch" => "서버가 확인한 당첨자와 음성 대상이 일치하지 않습니다.",
                _ => $"당첨 음성 요청 실패 (HTTP {(int)statusCode}, {code})"
            },
            (int)statusCode,
            code);

    private static bool TryNormalizeRaffleActorName(string? value, out string actorName)
    {
        actorName = (value ?? "").Trim();
        return actorName.Length is >= 1 and <= 120 && !actorName.Any(char.IsControl);
    }

    private static bool TryNormalizeRaffleActorKey(string? value, out string actorKey)
    {
        actorKey = (value ?? "").Trim();
        return actorKey.Length is >= 1 and <= 180 && !actorKey.Any(char.IsControl);
    }

    private static string[] NormalizeSupportedActionTypes(IReadOnlyCollection<string>? actionTypes)
    {
        if (actionTypes is null || actionTypes.Count is < 1 or > 32)
            throw new VNextDevelopmentException(
                "Agent 지원 액션 목록이 올바르지 않습니다.",
                code: "invalid_supported_action_types");

        var unique = new HashSet<string>(StringComparer.Ordinal);
        foreach (var actionType in actionTypes)
        {
            if (actionType is null || !ActionTypePattern.IsMatch(actionType) || !unique.Add(actionType))
                throw new VNextDevelopmentException(
                    "Agent 지원 액션 목록이 올바르지 않습니다.",
                    code: "invalid_supported_action_types");
        }
        return unique.Order(StringComparer.Ordinal).ToArray();
    }

    private static string NormalizeDeviceSecret(string? value, string displayName)
    {
        var normalized = (value ?? "").Trim();
        if (!DeviceSecretPattern.IsMatch(normalized))
            throw new VNextDevelopmentException(displayName + "가 올바르지 않습니다.", code: "invalid_device_secret");
        return normalized;
    }

    private static string DeviceSecretSha256(string normalizedSecret) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(normalizedSecret)))
            .ToLowerInvariant();

    private static bool DirectTransportCanFallback(Exception error) => error switch
    {
        HttpRequestException => true,
        VNextDevelopmentException request =>
            request.StatusCode is 400 or 404 or 409 or 500 or 502 or 503 or 504
            || request.Code.StartsWith("PGRST", StringComparison.OrdinalIgnoreCase)
            || request.Code is "direct_transport_unavailable",
        _ => false
    };

    private async Task<string> SendDirectRpcAsync(
        string functionName,
        object payload,
        CancellationToken cancellationToken,
        bool preserveNulls = false)
    {
        if (!Regex.IsMatch(functionName, "^[a-z][a-z0-9_]{1,79}$", RegexOptions.CultureInvariant))
            throw new ArgumentException("Direct RPC name is invalid.", nameof(functionName));
        var body = JsonSerializer.Serialize(
            payload,
            preserveNulls ? _agentRequestJsonWithNulls : _json);
        using var response = await SendWithSessionRecoveryAsync(
            accessToken =>
            {
                var request = new HttpRequestMessage(
                    HttpMethod.Post,
                    SupabaseUrl + "/rest/v1/rpc/" + functionName);
                request.Headers.TryAddWithoutValidation("apikey", PublishableKey);
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
                request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
                request.Content = new StringContent(body, Encoding.UTF8, "application/json");
                return request;
            },
            HttpCompletionOption.ResponseContentRead,
            cancellationToken);
        var responseText = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var code = ReadErrorCode(responseText);
            throw new VNextDevelopmentException(
                $"Agent 직접 동기화 요청 실패 (HTTP {(int)response.StatusCode}, {code})",
                (int)response.StatusCode,
                string.IsNullOrWhiteSpace(code) ? "direct_transport_unavailable" : code);
        }
        return responseText;
    }

    public async Task<byte[]> DownloadAuthenticatedWallpaperImageAsync(
        Uri uri,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(uri);
        if (uri.Scheme != Uri.UriSchemeHttps
            || !string.Equals(uri.Host, SupabaseProjectRef + ".supabase.co", StringComparison.OrdinalIgnoreCase)
            || !uri.IsDefaultPort
            || !string.IsNullOrEmpty(uri.UserInfo)
            || !uri.AbsolutePath.StartsWith(
                "/storage/v1/object/authenticated/byeollog-signature-assets/workspaces/",
                StringComparison.Ordinal))
            throw new VNextDevelopmentException("풍벽지 인증 이미지 주소가 올바르지 않습니다.", code: "invalid_wallpaper_path");

        using var response = await SendWithSessionRecoveryAsync(
            accessToken =>
            {
                var request = new HttpRequestMessage(HttpMethod.Get, uri);
                request.Headers.TryAddWithoutValidation("apikey", PublishableKey);
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
                request.Headers.Accept.ParseAdd("image/png,image/jpeg,image/webp,image/gif");
                return request;
            },
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new VNextDevelopmentException(
                $"풍벽지 인증 이미지 다운로드 실패 (HTTP {(int)response.StatusCode})",
                (int)response.StatusCode,
                "wallpaper_download_failed");
        if (response.Content.Headers.ContentLength is long length && length > 12 * 1024 * 1024)
            throw new VNextDevelopmentException("풍벽지 이미지 응답 크기가 제한을 초과했습니다.", code: "wallpaper_download_too_large");

        await using var source = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var destination = new MemoryStream();
        var buffer = new byte[32 * 1024];
        while (true)
        {
            var read = await source.ReadAsync(buffer, cancellationToken);
            if (read == 0) break;
            if (destination.Length + read > 12 * 1024 * 1024)
                throw new VNextDevelopmentException("풍벽지 이미지 응답 크기가 제한을 초과했습니다.", code: "wallpaper_download_too_large");
            await destination.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
        }
        return destination.ToArray();
    }

    public async Task HeartbeatAgentExecutionAsync(
        string deviceId,
        string deviceSecret,
        string executionId,
        int attemptNo,
        int leaseSeconds = 45,
        CancellationToken cancellationToken = default)
    {
        await SendAgentRequestAsync(new
        {
            operation = "heartbeat",
            workspaceId = WorkspaceId,
            deviceId,
            deviceSecret = NormalizeDeviceSecret(deviceSecret, "Agent 장치 키"),
            executionId,
            attemptNo,
            leaseSeconds
        }, cancellationToken);
    }

    public async Task AckAgentExecutionAsync(
        string deviceId,
        string deviceSecret,
        VNextAgentAck ack,
        CancellationToken cancellationToken = default)
    {
        await SendAgentRequestAsync(new
        {
            operation = "ack",
            workspaceId = WorkspaceId,
            deviceId,
            deviceSecret = NormalizeDeviceSecret(deviceSecret, "Agent 장치 키"),
            executionId = ack.ExecutionId,
            attemptNo = ack.AttemptNo,
            succeeded = ack.Succeeded,
            retryable = ack.Retryable,
            result = ack.Result,
            error = ack.Error
        }, cancellationToken);
    }

    private async Task<string> SendAgentRequestAsync(
        object payload,
        CancellationToken cancellationToken,
        bool preserveNulls = false)
    {
        var body = JsonSerializer.Serialize(payload, preserveNulls ? _agentRequestJsonWithNulls : _json);
        using var response = await SendWithSessionRecoveryAsync(
            accessToken =>
            {
                var request = new HttpRequestMessage(HttpMethod.Post, SupabaseUrl + "/functions/v1/agent-runtime-g3a");
                request.Headers.TryAddWithoutValidation("apikey", PublishableKey);
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
                request.Content = new StringContent(body, Encoding.UTF8, "application/json");
                return request;
            },
            HttpCompletionOption.ResponseContentRead,
            cancellationToken);
        var responseText = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var code = ReadErrorCode(responseText);
            if (code is "recent_authentication_required" or "device_session_already_used")
                await InvalidateCurrentSessionPermanentlyAsync(cancellationToken);
            var message = code switch
            {
                "recent_authentication_required" =>
                    "새 PC 등록을 위해 뉴별록 owner/admin 계정으로 다시 로그인해주세요.",
                "device_session_already_used" =>
                    "이 로그인 세션은 다른 PC 등록에 이미 사용됐습니다. 뉴별록 기능을 다시 연결해주세요.",
                "device_limit_reached" =>
                    "등록 가능한 PC 수를 초과했습니다. 사용하지 않는 PC를 장치 관리에서 해제해주세요.",
                "device_auth_failed" =>
                    "이 PC의 장치 키가 서버 등록 정보와 일치하지 않습니다. 로컬 인증 파일을 삭제하지 말고 관리자에게 문의해주세요.",
                "device_enrollment_failed" =>
                    "이 PC를 등록할 권한이 없거나 기존 1회용 등록 토큰이 만료됐습니다.",
                _ => $"vNext Agent 요청 실패 (HTTP {(int)response.StatusCode}, {code})"
            };
            throw new VNextDevelopmentException(
                message,
                (int)response.StatusCode,
                code);
        }
        return responseText;
    }

    private async Task<HttpResponseMessage> SendWithSessionRecoveryAsync(
        Func<string, HttpRequestMessage> requestFactory,
        HttpCompletionOption completionOption,
        CancellationToken cancellationToken,
        string? initialAccessToken = null)
    {
        ArgumentNullException.ThrowIfNull(requestFactory);
        for (var attempt = 0; attempt < 2; attempt++)
        {
            var accessToken = attempt == 0 && !string.IsNullOrWhiteSpace(initialAccessToken)
                ? initialAccessToken
                : await GetValidAccessTokenAsync(cancellationToken);
            var requestLease = CaptureSessionRequestLease(accessToken);
            using var request = requestFactory(accessToken);
            var response = await _http.SendAsync(request, completionOption, cancellationToken);
            if (response.StatusCode != HttpStatusCode.Unauthorized) return response;

            if (attempt == 0)
            {
                response.Dispose();
                RaiseSessionRecoveryChanged("recovering", "runtime_401");
                try
                {
                    await GetValidAccessTokenAsync(
                        cancellationToken,
                        forceRefresh: true,
                        unauthorizedLease: requestLease);
                    RaiseSessionRecoveryChanged("recovered", "runtime_401_replayed");
                    continue;
                }
                catch (Exception ex) when (ex is VNextDevelopmentException or HttpRequestException)
                {
                    RaiseSessionRecoveryChanged(
                        IsSignedIn ? "retrying" : "attention",
                        ex is VNextDevelopmentException development ? development.Code : "network_error");
                    throw;
                }
            }

            await MarkRefreshRequiredIfCurrentAsync(requestLease, cancellationToken);
            RaiseSessionRecoveryChanged("retrying", "runtime_401_after_refresh");
            return response;
        }
        throw new InvalidOperationException("방송 자동화 세션 재시도 경로가 완료되지 않았습니다.");
    }

    private static string RequiredString(JsonElement source, string propertyName)
    {
        if (!source.TryGetProperty(propertyName, out var value)
            || value.ValueKind != JsonValueKind.String
            || string.IsNullOrWhiteSpace(value.GetString()))
            throw new VNextDevelopmentException($"Agent 응답에 {propertyName} 값이 없습니다.", code: "invalid_agent_response");
        return value.GetString()!;
    }

    private static int RequiredInt(JsonElement source, string propertyName, int minimum, int maximum)
    {
        if (!source.TryGetProperty(propertyName, out var value)
            || !value.TryGetInt32(out var parsed)
            || parsed < minimum
            || parsed > maximum)
            throw new VNextDevelopmentException($"Agent 응답의 {propertyName} 값이 올바르지 않습니다.", code: "invalid_agent_response");
        return parsed;
    }

    private static long RequiredLong(JsonElement source, string propertyName, long minimum, long maximum)
    {
        if (!source.TryGetProperty(propertyName, out var value)
            || !value.TryGetInt64(out var parsed)
            || parsed < minimum
            || parsed > maximum)
            throw new VNextDevelopmentException($"Agent 응답의 {propertyName} 값이 올바르지 않습니다.", code: "invalid_agent_response");
        return parsed;
    }

    private static VNextOverlayAssetDescriptor ParseOverlayAsset(JsonElement value, bool manifestItem)
    {
        if (value.ValueKind != JsonValueKind.Object)
            throw new VNextDevelopmentException("Agent 오버레이 이미지 형식이 올바르지 않습니다.", code: "invalid_overlay_manifest");
        var assetId = RequiredString(value, "assetId").ToLowerInvariant();
        var assetKey = RequiredString(value, "assetKey");
        var versionNumber = RequiredInt(value, "versionNumber", 1, int.MaxValue);
        var displayName = RequiredString(value, "displayName").Trim();
        var mimeType = RequiredString(value, "mimeType");
        var sha256 = RequiredString(value, "contentSha256").ToLowerInvariant();
        var byteSize = RequiredInt(value, "byteSize", 1, MaximumOverlayAssetBytes);
        var widthPx = RequiredInt(value, "widthPx", 1, 7_680);
        var heightPx = RequiredInt(value, "heightPx", 1, 7_680);
        var deliveryMode = RequiredString(value, "deliveryMode");
        if (!Guid.TryParseExact(assetId, "D", out _)
            || !OverlayAssetKeyPattern.IsMatch(assetKey)
            || displayName.Length is < 1 or > 120
            || displayName.Any(char.IsControl)
            || !OverlayMimeTypes.Contains(mimeType)
            || !Sha256Pattern.IsMatch(sha256)
            || deliveryMode is not ("agent_builtin" or "managed_bundle"))
            throw new VNextDevelopmentException("Agent 오버레이 이미지 메타데이터가 올바르지 않습니다.", code: "invalid_overlay_manifest");

        var required = false;
        string? downloadPath = null;
        if (manifestItem)
        {
            if (!value.TryGetProperty("required", out var requiredValue)
                || requiredValue.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                throw new VNextDevelopmentException("Agent 이미지 필수 상태가 없습니다.", code: "invalid_overlay_manifest");
            required = requiredValue.GetBoolean();
            if (value.TryGetProperty("downloadPath", out var pathValue) && pathValue.ValueKind != JsonValueKind.Null)
            {
                if (pathValue.ValueKind != JsonValueKind.String) throw new VNextDevelopmentException("Agent 이미지 경로가 올바르지 않습니다.", code: "invalid_overlay_manifest");
                downloadPath = pathValue.GetString();
            }
            if ((deliveryMode == "agent_builtin" && downloadPath is not null)
                || (deliveryMode == "managed_bundle"
                    && (string.IsNullOrWhiteSpace(downloadPath) || !OverlayDownloadPathPattern.IsMatch(downloadPath))))
                throw new VNextDevelopmentException("Agent 이미지 전달 경로가 올바르지 않습니다.", code: "invalid_overlay_manifest");
        }

        return new VNextOverlayAssetDescriptor(
            assetId,
            assetKey,
            versionNumber,
            displayName,
            mimeType,
            sha256,
            byteSize,
            widthPx,
            heightPx,
            deliveryMode,
            required,
            downloadPath);
    }

    public async Task DisconnectAsync(CancellationToken cancellationToken = default)
    {
        Interlocked.Increment(ref _connectionIntentRevision);
        string token;
        using (var linked = CreateLinkedCancellation(cancellationToken))
        {
            await _sessionGate.WaitAsync(linked.Token);
            try
            {
                token = _accessToken;
                var requestLease = CaptureSessionRequestLease(token);
                _sessionVault.MarkDisconnectedAndDelete();
                InvalidateSessionIfCurrentUnderGate(requestLease);
            }
            finally
            {
                _sessionGate.Release();
            }
        }
        try
        {
            if (!string.IsNullOrWhiteSpace(token))
            {
                using var request = new HttpRequestMessage(HttpMethod.Post, SupabaseUrl + "/auth/v1/logout?scope=local");
                request.Headers.TryAddWithoutValidation("apikey", PublishableKey);
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _shutdown.Token);
                timeout.CancelAfter(TimeSpan.FromSeconds(3));
                using var _ = await _http.SendAsync(request, timeout.Token);
            }
        }
        catch
        {
            // 명시적 연결 해제는 로컬 tombstone과 epoch가 권위값입니다.
        }
    }

    [Obsolete("명시적 연결 해제에는 DisconnectAsync를 사용하세요.")]
    public Task SignOutAsync() => DisconnectAsync();

    private HttpRequestMessage CreateAuthRequest(string grantType, string body)
    {
        var request = new HttpRequestMessage(
            HttpMethod.Post,
            SupabaseUrl + "/auth/v1/token?grant_type=" + Uri.EscapeDataString(grantType));
        request.Headers.TryAddWithoutValidation("apikey", PublishableKey);
        request.Content = new StringContent(body, Encoding.UTF8, "application/json");
        return request;
    }

    private async Task<string> GetValidAccessTokenAsync(
        CancellationToken cancellationToken,
        bool forceRefresh = false,
        SessionRequestLease? unauthorizedLease = null)
    {
        using var linked = CreateLinkedCancellation(cancellationToken);
        await _sessionGate.WaitAsync(linked.Token);
        try
        {
            if (!IsSignedIn)
                throw new VNextDevelopmentException("뉴별록 계정 연결이 필요합니다.", 401, "missing_session");

            if (unauthorizedLease is not null && !IsRequestLeaseCurrentUnderGate(unauthorizedLease))
                return _accessToken;

            if (!forceRefresh
                && !_forceRefreshRequired
                && _expiresAt > DateTimeOffset.UtcNow.AddMinutes(2))
                return _accessToken;

            var refreshEpoch = SessionEpoch;
            var refreshRevision = Interlocked.Read(ref _tokenRevision);
            var expectedUserId = _authenticatedUserId;
            var expectedWorkspaceId = _workspaceId;
            if (expectedUserId == Guid.Empty || string.IsNullOrWhiteSpace(expectedWorkspaceId))
            {
                InvalidateSessionIfCurrentUnderGate(
                    new SessionRequestLease(refreshEpoch, refreshRevision, true));
                throw new VNextDevelopmentException(
                    "방송 자동화 사용자 또는 워크스페이스 연결 정보가 없습니다.",
                    401,
                    "missing_automation_identity");
            }
            _forceRefreshRequired = true;
            var body = JsonSerializer.Serialize(new { refresh_token = _refreshToken });
            using var request = CreateAuthRequest("refresh_token", body);
            using var response = await _http.SendAsync(request, linked.Token);
            var responseText = await response.Content.ReadAsStringAsync(linked.Token);
            if (!response.IsSuccessStatusCode)
            {
                if (!IsTransientAuthFailure(response.StatusCode))
                {
                    _sessionVault.DeleteInvalidVault();
                    InvalidateSessionIfCurrentUnderGate(
                        new SessionRequestLease(refreshEpoch, refreshRevision, true));
                }
                throw BuildAuthException(response.StatusCode, responseText);
            }

            if (SessionEpoch != refreshEpoch)
                throw new OperationCanceledException("세션이 변경되어 이전 갱신 결과를 버렸습니다.", linked.Token);
            var candidate = ParseSession(responseText, SignedInEmail);
            if (!TryReadExpectedAccessTokenClaims(candidate.AccessToken, out var refreshedUserId, out _)
                || refreshedUserId != expectedUserId)
            {
                _sessionVault.DeleteInvalidVault();
                InvalidateSessionIfCurrentUnderGate(
                    new SessionRequestLease(refreshEpoch, refreshRevision, true));
                throw new VNextDevelopmentException(
                    "갱신된 방송 자동화 세션의 사용자가 기존 연결과 다릅니다.",
                    401,
                    "automation_principal_changed");
            }

            // refresh 결과도 새 인증 세션입니다. 토큰 claim만 신뢰하지 않고
            // Auth 사용자와 현재 workspace membership 한 행을 다시 확인한 뒤
            // 같은 사용자일 때만 메모리 세션을 교체합니다. 네트워크/일시 오류는
            // 이 호출을 실패시키되 후보 토큰을 게시하지 않습니다.
            var authorizedIdentity = await ValidateAuthorizedAutomationIdentityAsync(
                candidate.AccessToken,
                expectedUserId,
                expectedWorkspaceId,
                linked.Token);
            if (authorizedIdentity is null || authorizedIdentity.UserId != expectedUserId)
                throw new VNextDevelopmentException(
                    "갱신된 방송 자동화 세션의 사용자 권한을 확인하지 못했습니다.",
                    503,
                    "automation_identity_revalidation_failed");

            if (!string.IsNullOrWhiteSpace(authorizedIdentity.Email))
                candidate = candidate with { Email = authorizedIdentity.Email };
            PublishSession(
                candidate,
                _rememberSession,
                advanceConnectionEpoch: false,
                authenticatedUserId: authorizedIdentity.UserId);
            return _accessToken;
        }
        finally
        {
            _sessionGate.Release();
        }
    }

    private sealed record SessionCandidate(
        string AccessToken,
        string RefreshToken,
        DateTimeOffset ExpiresAt,
        string Email);

    private sealed record AuthorizedAutomationIdentity(Guid UserId, string WorkspaceId, string Email);

    private async Task<AuthorizedAutomationIdentity?> ValidateAuthorizedAutomationIdentityAsync(
        string accessToken,
        Guid expectedTokenUserId,
        string expectedWorkspaceId,
        CancellationToken cancellationToken)
    {
        // Supabase Auth가 서명·세션 상태를 검증한 사용자만 다음 RLS 확인으로 넘깁니다.
        using var userRequest = new HttpRequestMessage(HttpMethod.Get, SupabaseUrl + "/auth/v1/user");
        userRequest.Headers.TryAddWithoutValidation("apikey", PublishableKey);
        userRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        using var linked = CreateLinkedCancellation(cancellationToken);
        using var userResponse = await _http.SendAsync(userRequest, linked.Token);
        var userResponseText = await userResponse.Content.ReadAsStringAsync(linked.Token);
        if (!userResponse.IsSuccessStatusCode) return null;

        Guid authenticatedUserId;
        string authenticatedEmail;
        try
        {
            using var userDocument = JsonDocument.Parse(userResponseText);
            var user = userDocument.RootElement;
            if (user.ValueKind != JsonValueKind.Object
                || !TryReadGuidProperty(user, "id", out authenticatedUserId)
                || authenticatedUserId != expectedTokenUserId)
                return null;
            authenticatedEmail = user.TryGetProperty("email", out var emailValue)
                && emailValue.ValueKind == JsonValueKind.String
                    ? emailValue.GetString() ?? ""
                    : "";
        }
        catch (JsonException)
        {
            return null;
        }

        // 쌍 응답의 동적 workspace와 현재 Auth 사용자의 membership이 정확히 한 행으로
        // 일치해야 합니다. RLS뿐 아니라 user_id도 명시해 모호한 다중 행을 거부합니다.
        var normalizedUserId = authenticatedUserId.ToString("D");
        var query = "/rest/v1/workspace_members?select=workspace_id,user_id"
            + "&workspace_id=eq." + Uri.EscapeDataString(expectedWorkspaceId)
            + "&user_id=eq." + Uri.EscapeDataString(normalizedUserId)
            + "&limit=2";

        using var request = new HttpRequestMessage(HttpMethod.Get, SupabaseUrl + query);
        request.Headers.TryAddWithoutValidation("apikey", PublishableKey);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        using var response = await _http.SendAsync(request, linked.Token);
        var responseText = await response.Content.ReadAsStringAsync(linked.Token);
        if (!response.IsSuccessStatusCode) return null;

        try
        {
            using var document = JsonDocument.Parse(responseText);
            if (document.RootElement.ValueKind != JsonValueKind.Array
                || document.RootElement.GetArrayLength() != 1)
                return null;
            var row = document.RootElement[0];
            if (row.ValueKind != JsonValueKind.Object
                || !TryReadGuidProperty(row, "workspace_id", out var workspaceId)
                || !TryReadGuidProperty(row, "user_id", out var memberUserId))
                return null;
            var normalized = workspaceId.ToString("D");
            if (!string.Equals(normalized, expectedWorkspaceId, StringComparison.OrdinalIgnoreCase)
                || memberUserId != authenticatedUserId)
                return null;
            return new AuthorizedAutomationIdentity(authenticatedUserId, normalized, authenticatedEmail);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static bool TryReadGuidProperty(JsonElement value, string propertyName, out Guid result)
    {
        result = Guid.Empty;
        return value.ValueKind == JsonValueKind.Object
            && value.TryGetProperty(propertyName, out var property)
            && property.ValueKind == JsonValueKind.String
            && Guid.TryParseExact(property.GetString(), "D", out result);
    }

    private static bool TryReadExpectedAccessTokenClaims(
        string accessToken,
        out Guid userId,
        out DateTimeOffset expiresAt)
    {
        userId = Guid.Empty;
        expiresAt = DateTimeOffset.MinValue;
        if (string.IsNullOrWhiteSpace(accessToken) || accessToken.Length > 16384) return false;

        var parts = accessToken.Split('.');
        if (parts.Length != 3 || parts[1].Length == 0) return false;
        try
        {
            var payload = parts[1].Replace('-', '+').Replace('_', '/');
            payload += (payload.Length % 4) switch
            {
                0 => "",
                2 => "==",
                3 => "=",
                _ => throw new FormatException("invalid base64url length")
            };
            using var document = JsonDocument.Parse(Convert.FromBase64String(payload));
            var claims = document.RootElement;
            if (claims.ValueKind != JsonValueKind.Object
                || !claims.TryGetProperty("iss", out var issuer)
                || issuer.ValueKind != JsonValueKind.String
                || !string.Equals(issuer.GetString(), ExpectedJwtIssuer, StringComparison.Ordinal)
                || !claims.TryGetProperty("aud", out var audience)
                || audience.ValueKind != JsonValueKind.String
                || !string.Equals(audience.GetString(), "authenticated", StringComparison.Ordinal)
                || !claims.TryGetProperty("role", out var role)
                || role.ValueKind != JsonValueKind.String
                || !string.Equals(role.GetString(), "authenticated", StringComparison.Ordinal)
                || !TryReadGuidProperty(claims, "sub", out userId)
                || !claims.TryGetProperty("exp", out var expiration)
                || expiration.ValueKind != JsonValueKind.Number
                || !expiration.TryGetInt64(out var expirationSeconds))
                return false;

            expiresAt = DateTimeOffset.FromUnixTimeSeconds(expirationSeconds);
            return expiresAt > DateTimeOffset.UtcNow;
        }
        catch (ArgumentException)
        {
            return false;
        }
        catch (FormatException)
        {
            return false;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static SessionCandidate ParseSession(string responseText, string fallbackEmail)
    {
        using var document = JsonDocument.Parse(responseText);
        var root = document.RootElement;
        var accessToken = root.TryGetProperty("access_token", out var access) ? access.GetString() ?? "" : "";
        var refreshToken = root.TryGetProperty("refresh_token", out var refresh) ? refresh.GetString() ?? "" : "";
        if (string.IsNullOrWhiteSpace(accessToken))
            throw new VNextDevelopmentException("뉴별록 로그인 응답에 세션 토큰이 없습니다.", 401, "missing_access_token");

        if (string.IsNullOrWhiteSpace(refreshToken))
            throw new VNextDevelopmentException("뉴별록 로그인 응답에 갱신 토큰이 없습니다.", 401, "missing_refresh_token");

        var expiresIn = 3600d;
        if (root.TryGetProperty("expires_in", out var expires) && expires.TryGetDouble(out var parsed) && parsed > 0)
            expiresIn = parsed;
        var expiresAt = DateTimeOffset.UtcNow.AddSeconds(expiresIn);

        var emailText = fallbackEmail;
        if (root.TryGetProperty("user", out var user)
            && user.ValueKind == JsonValueKind.Object
            && user.TryGetProperty("email", out var email)
            && !string.IsNullOrWhiteSpace(email.GetString()))
        {
            emailText = email.GetString()!;
        }
        return new SessionCandidate(accessToken, refreshToken, expiresAt, emailText);
    }

    private void PublishSession(
        SessionCandidate candidate,
        bool rememberSession,
        bool advanceConnectionEpoch,
        string? workspaceId = null,
        Guid authenticatedUserId = default)
    {
        Volatile.Write(ref _sessionRecoveryState, "ready");
        if (!TryReadExpectedAccessTokenClaims(candidate.AccessToken, out var tokenUserId, out var tokenExpiresAt))
            throw new VNextDevelopmentException(
                "offsl 프로젝트에서 발급한 방송 자동화 세션이 아닙니다.",
                401,
                "invalid_automation_session_issuer");
        if (authenticatedUserId == Guid.Empty || tokenUserId != authenticatedUserId)
            throw new VNextDevelopmentException(
                "방송 자동화 세션의 인증 사용자가 일치하지 않습니다.",
                401,
                "automation_principal_changed");
        if (candidate.ExpiresAt > tokenExpiresAt)
            candidate = candidate with { ExpiresAt = tokenExpiresAt };
        if (advanceConnectionEpoch && string.IsNullOrWhiteSpace(workspaceId))
            throw new VNextDevelopmentException(
                "방송 자동화 워크스페이스가 확인되지 않았습니다.",
                403,
                "missing_workspace");
        if (!advanceConnectionEpoch
            && (_authenticatedUserId == Guid.Empty
                || _authenticatedUserId != authenticatedUserId
                || string.IsNullOrWhiteSpace(_workspaceId)))
            throw new VNextDevelopmentException(
                "갱신된 방송 자동화 세션의 사용자가 기존 연결과 다릅니다.",
                401,
                "automation_principal_changed");
        if (rememberSession)
        {
            try
            {
                _sessionVault.Save(new VNextRememberedSession(
                    candidate.RefreshToken,
                    advanceConnectionEpoch ? workspaceId! : _workspaceId,
                    authenticatedUserId,
                    candidate.Email,
                    DateTimeOffset.UtcNow));
            }
            catch
            {
                // DPAPI or local storage failure must never undo a verified login
                // or interrupt the legacy Collector path. This process can still
                // refresh in memory and the next ordinary login may save again.
                rememberSession = false;
            }
        }
        CancellationTokenSource? previousBoundary = null;
        if (advanceConnectionEpoch)
        {
            lock (_connectionBoundaryGate)
            {
                _accessToken = candidate.AccessToken;
                _refreshToken = candidate.RefreshToken;
                _expiresAt = candidate.ExpiresAt;
                SignedInEmail = candidate.Email;
                _rememberSession = rememberSession;
                _forceRefreshRequired = false;
                _workspaceId = workspaceId!;
                _authenticatedUserId = authenticatedUserId;
                Interlocked.Increment(ref _tokenRevision);
                Interlocked.Increment(ref _sessionEpoch);
                previousBoundary = _connectionBoundary;
                _connectionBoundary = new CancellationTokenSource();
            }
            CancelAndDispose(previousBoundary);
            RaiseSessionChanged();
            return;
        }
        _accessToken = candidate.AccessToken;
        _refreshToken = candidate.RefreshToken;
        _expiresAt = candidate.ExpiresAt;
        SignedInEmail = candidate.Email;
        _rememberSession = rememberSession;
        _forceRefreshRequired = false;
        Interlocked.Increment(ref _tokenRevision);
    }

    private static VNextDevelopmentException BuildAuthException(HttpStatusCode statusCode, string responseText)
    {
        var code = ReadErrorCode(responseText);
        var message = code switch
        {
            "invalid_credentials" => "뉴별록 계정 이메일 또는 비밀번호가 맞지 않습니다.",
            "email_not_confirmed" => "뉴별록 계정 이메일 확인이 필요합니다.",
            _ => $"뉴별록 계정 인증 실패 (HTTP {(int)statusCode}, {code})"
        };
        return new VNextDevelopmentException(message, (int)statusCode, code);
    }

    private static string ReadErrorCode(string responseText)
    {
        try
        {
            using var document = JsonDocument.Parse(responseText);
            var root = document.RootElement;
            foreach (var key in new[] { "error_code", "code", "error" })
            {
                if (root.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String)
                {
                    var text = value.GetString()?.Trim();
                    if (!string.IsNullOrWhiteSpace(text) && ErrorCodePattern.IsMatch(text)) return text;
                }
            }
        }
        catch { }
        return "unknown_error";
    }

    internal bool IsSessionEpochCurrent(long expectedEpoch) =>
        expectedEpoch == SessionEpoch && IsSignedIn;

    internal long CaptureSessionEpoch() => SessionEpoch;

    internal async Task<VNextRealtimeCredentials> GetRealtimeCredentialsAsync(
        CancellationToken cancellationToken = default)
    {
        var accessToken = await GetValidAccessTokenAsync(cancellationToken);
        var epoch = SessionEpoch;
        var workspaceId = WorkspaceId;
        if (!IsSessionEpochCurrent(epoch))
            throw new VNextDevelopmentException(
                "Realtime 연결 중 별록 로그인이 변경됐습니다.",
                401,
                "stale_session");
        return new VNextRealtimeCredentials(accessToken, workspaceId, epoch);
    }

    internal bool TryStartSessionOperation<T>(
        long expectedEpoch,
        CancellationToken cancellationToken,
        Func<CancellationToken, Task<T>> start,
        out CancellationTokenSource? operationLifetime,
        out Task<T>? operation)
    {
        ArgumentNullException.ThrowIfNull(start);
        lock (_connectionBoundaryGate)
        {
            operationLifetime = null;
            operation = null;
            if (_connectionBoundary is null
                || expectedEpoch != SessionEpoch
                || !IsSignedIn)
                return false;
            var lifetime = CancellationTokenSource.CreateLinkedTokenSource(
                cancellationToken,
                _connectionBoundary.Token);
            if (lifetime.IsCancellationRequested)
            {
                lifetime.Dispose();
                return false;
            }
            try
            {
                var started = start(lifetime.Token);
                operationLifetime = lifetime;
                operation = started;
                return true;
            }
            catch
            {
                lifetime.Dispose();
                throw;
            }
        }
    }

    private sealed record SessionRequestLease(long ConnectionEpoch, long TokenRevision, bool MatchedToken);

    private SessionRequestLease CaptureSessionRequestLease(string accessToken)
    {
        var epoch = SessionEpoch;
        var revision = Interlocked.Read(ref _tokenRevision);
        var matched = !string.IsNullOrWhiteSpace(accessToken)
            && string.Equals(_accessToken, accessToken, StringComparison.Ordinal);
        if (epoch != SessionEpoch || revision != Interlocked.Read(ref _tokenRevision)) matched = false;
        return new SessionRequestLease(epoch, revision, matched);
    }

    private bool IsRequestLeaseCurrentUnderGate(SessionRequestLease lease) =>
        lease.MatchedToken
        && SessionEpoch == lease.ConnectionEpoch
        && Interlocked.Read(ref _tokenRevision) == lease.TokenRevision;

    private async Task MarkRefreshRequiredIfCurrentAsync(
        SessionRequestLease lease,
        CancellationToken cancellationToken)
    {
        using var linked = CreateLinkedCancellation(cancellationToken);
        await _sessionGate.WaitAsync(linked.Token);
        try
        {
            if (IsRequestLeaseCurrentUnderGate(lease)) _forceRefreshRequired = true;
        }
        finally
        {
            _sessionGate.Release();
        }
    }

    private async Task InvalidateCurrentSessionPermanentlyAsync(CancellationToken cancellationToken)
    {
        using var linked = CreateLinkedCancellation(cancellationToken);
        await _sessionGate.WaitAsync(linked.Token);
        try
        {
            var lease = CaptureSessionRequestLease(_accessToken);
            _sessionVault.DeleteInvalidVault();
            InvalidateSessionIfCurrentUnderGate(lease);
        }
        finally
        {
            _sessionGate.Release();
        }
    }

    private void InvalidateSessionIfCurrentUnderGate(SessionRequestLease lease)
    {
        CancellationTokenSource? previousBoundary;
        lock (_connectionBoundaryGate)
        {
            if (!lease.MatchedToken
                || SessionEpoch != lease.ConnectionEpoch
                || Interlocked.Read(ref _tokenRevision) != lease.TokenRevision)
                return;
            _accessToken = "";
            _refreshToken = "";
            _expiresAt = DateTimeOffset.MinValue;
            SignedInEmail = "";
            _rememberSession = false;
            _forceRefreshRequired = false;
            _workspaceId = "";
            _authenticatedUserId = Guid.Empty;
            Volatile.Write(ref _sessionRecoveryState, "ready");
            Interlocked.Increment(ref _tokenRevision);
            Interlocked.Increment(ref _sessionEpoch);
            previousBoundary = _connectionBoundary;
            _connectionBoundary = new CancellationTokenSource();
        }
        CancelAndDispose(previousBoundary);
        RaiseSessionChanged();
    }

    private static void CancelAndDispose(CancellationTokenSource? source)
    {
        if (source is null) return;
        try { source.Cancel(); } catch (ObjectDisposedException) { }
        source.Dispose();
    }

    private void RaiseSessionChanged()
    {
        ThreadPool.QueueUserWorkItem(_ =>
        {
            try { SessionChanged?.Invoke(this, EventArgs.Empty); } catch { }
        });
    }

    private void RaiseSessionRecoveryChanged(string state, string code)
    {
        Volatile.Write(ref _sessionRecoveryState, state);
        ThreadPool.QueueUserWorkItem(_ =>
        {
            try { SessionRecoveryChanged?.Invoke(this, new VNextSessionRecoveryEventArgs(state, code)); }
            catch { }
        });
    }

    private CancellationTokenSource CreateLinkedCancellation(CancellationToken cancellationToken) =>
        CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _shutdown.Token);

    private static bool IsTransientAuthFailure(HttpStatusCode statusCode) =>
        statusCode == HttpStatusCode.TooManyRequests || (int)statusCode >= 500;

    public Task ShutdownAsync()
    {
        try { _shutdown.Cancel(); } catch { }
        return Task.CompletedTask;
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        Interlocked.Increment(ref _connectionIntentRevision);
        try { _shutdown.Cancel(); } catch { }
        CancellationTokenSource? previousBoundary;
        lock (_connectionBoundaryGate)
        {
            previousBoundary = _connectionBoundary;
            _connectionBoundary = null;
            _accessToken = "";
            _refreshToken = "";
            _expiresAt = DateTimeOffset.MinValue;
            SignedInEmail = "";
            _rememberSession = false;
            _forceRefreshRequired = false;
            _workspaceId = "";
            _authenticatedUserId = Guid.Empty;
            Volatile.Write(ref _sessionRecoveryState, "ready");
        }
        CancelAndDispose(previousBoundary);
        _sessionGate.Dispose();
        _http.Dispose();
        _shutdown.Dispose();
    }
}
