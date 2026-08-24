using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace HurogiCollector;

internal sealed record VNextAutomationState(
    JsonElement Rules,
    IReadOnlyList<VNextAutomationDeviceView> AgentDevices,
    IReadOnlyList<VNextAutomationOverlayAssetView> OverlayAssets,
    IReadOnlyList<VNextAutomationAssetReadinessView> AssetReadiness,
    JsonElement Raffle);

internal sealed record VNextAutomationDeviceView(
    [property: JsonPropertyName("deviceId")] string DeviceId,
    [property: JsonPropertyName("displayName")] string DisplayName,
    [property: JsonPropertyName("registeredAt")] DateTimeOffset RegisteredAt,
    [property: JsonPropertyName("lastSeenAt")] DateTimeOffset? LastSeenAt,
    [property: JsonPropertyName("lastReportedAt")] DateTimeOffset? LastReportedAt,
    [property: JsonPropertyName("revokedAt")] DateTimeOffset? RevokedAt,
    [property: JsonPropertyName("agentVersion")] string? AgentVersion,
    [property: JsonPropertyName("platform")] string? Platform,
    [property: JsonPropertyName("supportedActionTypes")] IReadOnlyList<string> SupportedActionTypes,
    [property: JsonPropertyName("overlayAssetsReady")] bool? OverlayAssetsReady,
    [property: JsonPropertyName("managedOverlayAssets")] int? ManagedOverlayAssets,
    [property: JsonPropertyName("managementRevision")] long ManagementRevision,
    [property: JsonPropertyName("connectionState")] string ConnectionState);

internal sealed record VNextAutomationOverlayAssetView(
    [property: JsonPropertyName("assetId")] string AssetId,
    [property: JsonPropertyName("assetKey")] string AssetKey,
    [property: JsonPropertyName("versionNumber")] int VersionNumber,
    [property: JsonPropertyName("displayName")] string DisplayName,
    [property: JsonPropertyName("mimeType")] string MimeType,
    [property: JsonPropertyName("contentSha256")] string ContentSha256,
    [property: JsonPropertyName("byteSize")] int ByteSize,
    [property: JsonPropertyName("widthPx")] int WidthPx,
    [property: JsonPropertyName("heightPx")] int HeightPx,
    [property: JsonPropertyName("deliveryMode")] string DeliveryMode,
    [property: JsonPropertyName("durationSeconds")] IReadOnlyList<int> DurationSeconds);

internal sealed record VNextAutomationAssetReadinessView(
    [property: JsonPropertyName("agentDeviceId")] string AgentDeviceId,
    [property: JsonPropertyName("assetId")] string AssetId,
    [property: JsonPropertyName("contentSha256")] string ContentSha256,
    [property: JsonPropertyName("reportedAt")] DateTimeOffset ReportedAt,
    [property: JsonPropertyName("fresh")] bool Fresh);

internal sealed record VNextAutomationSaveReceipt(string RuleId, int RuleVersion, bool Enabled);
internal sealed record VNextAutomationToggleReceipt(string RuleId, bool Enabled);
internal sealed record VNextAutomationDeleteReceipt(string RuleId, int DeletedVersion);
internal sealed record VNextAutomationTestReceipt(
    string EventId,
    string ExecutionId,
    string ActionType,
    string AgentDeviceId);
internal sealed record VNextRaffleStartReceipt(
    string RoundId,
    string DrawId,
    int WinnerTarget,
    int RemainingCount);
internal sealed record VNextRaffleNextReceipt(
    string DrawId,
    string RoundId,
    string ExecutionId,
    string AgentDeviceId,
    JsonElement Winner,
    int DrawnCount,
    int RemainingCount,
    bool Completed);
internal sealed record VNextRaffleReannounceReceipt(
    string DrawId,
    string RoundId,
    int DrawIndex,
    int ReannounceNumber,
    string ExecutionId,
    string AgentDeviceId,
    string OriginalExecutionId,
    JsonElement Winner,
    bool Created);
internal sealed record VNextAgentDeviceRenameReceipt(string DeviceId, string DisplayName, long ManagementRevision);
internal sealed record VNextAgentDeviceRevokeReceipt(string DeviceId, long ManagementRevision, int DisabledRuleCount);

internal sealed partial class VNextDevelopmentClient
{
    private const int MaximumRules = 100;
    // 활성 장치는 서버에서 32대로 제한되지만 폐기 이력은 보존됩니다. 전체 HTTP
    // 응답은 별도의 4 MiB 경계로 먼저 제한하므로, 오래 사용한 workspace가 100대
    // 누적만으로 설정 화면 전체를 잃지 않게 충분히 넓은 이력 상한을 둡니다.
    private const int MaximumDeviceHistory = 10_000;
    private const int MaximumAutomationResponseChars = 4 * 1024 * 1024;
    private static readonly Regex AgentVersionPattern = new(
        "^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex AgentActionPattern = new(
        "^[a-z][a-z0-9_.-]{0,119}$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);
    public async Task<VNextAutomationState> LoadAutomationStateAsync(CancellationToken cancellationToken = default)
    {
        var token = await GetValidAccessTokenAsync(cancellationToken);
        var rulesQuery =
            "/rest/v1/rules?workspace_id=eq." + Uri.EscapeDataString(WorkspaceId) +
            "&superseded_at=is.null" +
            "&select=" + Uri.EscapeDataString("id,name,enabled,priority,match_mode,created_at,version_series_id,version_number,supersedes_rule_id,superseded_at,rule_conditions(position,path,operator,value),rule_actions(position,action_type,params,execution_target,agent_device_id,overlay_asset_id,overlay_duration_ms)") +
            "&order=created_at.desc&limit=" + MaximumRules;
        var rulesTask = SendAutomationRequestAsync(HttpMethod.Get, rulesQuery, null, token, "규칙 목록", cancellationToken);
        var devicesTask = SendAutomationRequestAsync(HttpMethod.Post, "/rest/v1/rpc/list_agent_devices_v1", new
        {
            p_workspace_id = WorkspaceId
        }, token, "등록 PC 목록", cancellationToken);
        var raffleTask = LoadRaffleStateForManagementAsync(token, cancellationToken);

        await Task.WhenAll(rulesTask, devicesTask, raffleTask);
        var rules = await rulesTask;
        var devices = await devicesTask;
        var raffle = await raffleTask;
        RequireArray(rules, "규칙 목록", MaximumRules);
        RequireArray(devices, "등록 PC 목록", MaximumDeviceHistory);
        return new VNextAutomationState(
            rules,
            ParseAgentDevices(devices),
            Array.Empty<VNextAutomationOverlayAssetView>(),
            Array.Empty<VNextAutomationAssetReadinessView>(),
            raffle);
    }

    private async Task<JsonElement> LoadRaffleStateForManagementAsync(
        string token,
        CancellationToken cancellationToken)
    {
        try
        {
            var state = await SendAutomationRequestAsync(
                HttpMethod.Post,
                "/rest/v1/rpc/get_raffle_state_v2",
                new { p_workspace_id = WorkspaceId },
                token,
                "추첨 현황",
                cancellationToken);
            RequireObject(state, "추첨 현황");
            return state;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            // 추첨 부가기능의 일시 장애가 기존 액션·PC 관리 화면 전체를 막지 않게 격리한다.
            return JsonSerializer.SerializeToElement(new
            {
                round = (object?)null,
                activeDraw = (object?)null,
                history = Array.Empty<object>(),
                unavailable = true
            });
        }
    }

    public async Task<VNextAutomationSaveReceipt> SaveAutomationRuleAsync(
        JsonElement payload,
        CancellationToken cancellationToken = default)
    {
        var draft = ParseAutomationRuleDraft(payload);
        var token = await GetValidAccessTokenAsync(cancellationToken);
        var result = await SendAutomationRequestAsync(
            HttpMethod.Post,
            "/rest/v1/rpc/save_guided_rule_v11",
            draft,
            token,
            "규칙 저장",
            cancellationToken);
        var receipt = FirstObject(result, "규칙 저장");
        var ruleId = RequireGuidString(receipt, "rule_id", "규칙 저장");
        var version = RequireInt(receipt, "rule_version", 1, int.MaxValue, "규칙 저장");
        var enabled = receipt.TryGetProperty("created_enabled", out var enabledValue)
            && enabledValue.ValueKind is JsonValueKind.True or JsonValueKind.False
            ? enabledValue.GetBoolean()
            : draft.p_enabled;
        return new VNextAutomationSaveReceipt(ruleId, version, enabled);
    }

    public async Task<JsonElement> LoadRaffleStateAsync(CancellationToken cancellationToken = default)
    {
        var token = await GetValidAccessTokenAsync(cancellationToken);
        var state = await SendAutomationRequestAsync(
            HttpMethod.Post,
            "/rest/v1/rpc/get_raffle_state_v2",
            new { p_workspace_id = WorkspaceId },
            token,
            "추첨 현황",
            cancellationToken);
        RequireObject(state, "추첨 현황");
        return state;
    }

    public async Task<VNextAutomationToggleReceipt> SetAutomationRuleEnabledAsync(
        string ruleId,
        int expectedVersion,
        bool enabled,
        CancellationToken cancellationToken = default)
    {
        if (!Guid.TryParseExact(ruleId?.Trim(), "D", out var parsedRuleId))
            throw new VNextDevelopmentException("규칙 ID가 올바르지 않습니다.", code: "invalid_rule_id");
        if (expectedVersion < 1)
            throw new VNextDevelopmentException("규칙 버전이 올바르지 않습니다.", code: "invalid_rule_version");

        var token = await GetValidAccessTokenAsync(cancellationToken);
        var result = await SendAutomationRequestAsync(
            HttpMethod.Post,
            "/rest/v1/rpc/set_guided_rule_enabled_v1",
            new
            {
                p_workspace_id = WorkspaceId,
                p_rule_id = parsedRuleId.ToString("D"),
                p_expected_version = expectedVersion,
                p_enabled = enabled
            },
            token,
            "규칙 상태 변경",
            cancellationToken);
        var receipt = FirstObject(result, "규칙 상태 변경");
        var returnedRuleId = RequireGuidString(receipt, "rule_id", "규칙 상태 변경");
        if (!receipt.TryGetProperty("current_enabled", out var currentEnabled)
            || currentEnabled.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            throw new VNextDevelopmentException("규칙 상태 변경 결과가 올바르지 않습니다.", code: "invalid_automation_response");
        return new VNextAutomationToggleReceipt(returnedRuleId, currentEnabled.GetBoolean());
    }

    public async Task<VNextAutomationDeleteReceipt> DeleteAutomationRuleAsync(
        string ruleId,
        int expectedVersion,
        CancellationToken cancellationToken = default)
    {
        if (!Guid.TryParseExact(ruleId?.Trim(), "D", out var parsedRuleId))
            throw new VNextDevelopmentException("규칙 ID가 올바르지 않습니다.", code: "invalid_rule_id");
        if (expectedVersion < 1)
            throw new VNextDevelopmentException("규칙 버전이 올바르지 않습니다.", code: "invalid_rule_version");

        var token = await GetValidAccessTokenAsync(cancellationToken);
        var result = await SendAutomationRequestAsync(
            HttpMethod.Post,
            "/rest/v1/rpc/delete_guided_rule_v1",
            new
            {
                p_workspace_id = WorkspaceId,
                p_rule_id = parsedRuleId.ToString("D"),
                p_expected_version = expectedVersion
            },
            token,
            "규칙 삭제",
            cancellationToken);
        var receipt = ExactlyOneObject(result, "규칙 삭제");
        var returnedRuleId = RequireResponseGuidString(receipt, "rule_id", "규칙 삭제");
        if (!string.Equals(returnedRuleId, parsedRuleId.ToString("D"), StringComparison.Ordinal))
            throw new VNextDevelopmentException(
                "규칙 삭제 결과가 요청과 일치하지 않습니다.",
                code: "invalid_automation_response");
        return new VNextAutomationDeleteReceipt(
            returnedRuleId,
            RequireInt(receipt, "deleted_version", 1, int.MaxValue, "규칙 삭제"));
    }

    public async Task<VNextAutomationTestReceipt> DispatchAutomationRuleTestAsync(
        string ruleId,
        int expectedVersion,
        CancellationToken cancellationToken = default)
    {
        if (!Guid.TryParseExact(ruleId?.Trim(), "D", out var parsedRuleId))
            throw new VNextDevelopmentException("액션 규칙 ID가 올바르지 않습니다.", code: "invalid_rule_id");
        if (expectedVersion < 1)
            throw new VNextDevelopmentException("액션 규칙 버전이 올바르지 않습니다.", code: "invalid_rule_version");

        var token = await GetValidAccessTokenAsync(cancellationToken);
        var result = await SendAutomationRequestAsync(
            HttpMethod.Post,
            "/rest/v1/rpc/dispatch_guided_rule_test_v2",
            new
            {
                p_workspace_id = WorkspaceId,
                p_rule_id = parsedRuleId.ToString("D"),
                p_expected_version = expectedVersion
            },
            token,
            "테스트 송출",
            cancellationToken);
        var receipt = ExactlyOneObject(result, "테스트 송출");
        return new VNextAutomationTestReceipt(
            RequireResponseGuidString(receipt, "event_id", "테스트 송출"),
            RequireResponseGuidString(receipt, "execution_id", "테스트 송출"),
            BoundedResponseText(receipt, "action_type", "테스트 송출", 1, 120),
            RequireResponseGuidString(receipt, "agent_device_id", "테스트 송출"));
    }

    public async Task<VNextRaffleStartReceipt> StartRaffleDrawAsync(
        string expectedRoundId,
        int winnerCount,
        bool allowDuplicateWinners,
        CancellationToken cancellationToken = default)
    {
        if (!Guid.TryParseExact(expectedRoundId?.Trim(), "D", out var parsedRoundId))
            throw new VNextDevelopmentException("추첨할 회차가 올바르지 않습니다.", code: "invalid_raffle_draw");
        if (winnerCount is < 1 or > 100)
            throw new VNextDevelopmentException("당첨 개수는 1~100개로 입력해주세요.", code: "invalid_raffle_draw");
        var normalizedRoundId = parsedRoundId.ToString("D");
        var token = await GetValidAccessTokenAsync(cancellationToken);
        var result = await SendAutomationRequestAsync(
            HttpMethod.Post,
            "/rest/v1/rpc/start_raffle_draw_v2",
            new
            {
                p_workspace_id = WorkspaceId,
                p_expected_round_id = normalizedRoundId,
                p_winner_count = winnerCount,
                p_allow_duplicate_winners = allowDuplicateWinners
            },
            token,
            "추첨 시작",
            cancellationToken);
        RequireObject(result, "추첨 시작");
        var returnedRoundId = RequireResponseGuidString(result, "roundId", "추첨 시작");
        if (!string.Equals(returnedRoundId, normalizedRoundId, StringComparison.Ordinal))
            throw new VNextDevelopmentException(
                "추첨 시작 결과가 선택한 회차와 일치하지 않습니다.",
                code: "invalid_automation_response");
        return new VNextRaffleStartReceipt(
            returnedRoundId,
            RequireResponseGuidString(result, "drawId", "추첨 시작"),
            RequireInt(result, "winnerTarget", 1, 100, "추첨 시작"),
            RequireInt(result, "remainingCount", 1, 100, "추첨 시작"));
    }

    public async Task<VNextRaffleNextReceipt> DrawNextRaffleWinnerAsync(
        string expectedDrawId,
        int expectedDrawIndex,
        string expectedAgentDeviceId,
        CancellationToken cancellationToken = default)
    {
        if (!Guid.TryParseExact(expectedDrawId?.Trim(), "D", out var parsedDrawId))
            throw new VNextDevelopmentException("진행 중인 추첨 기록이 올바르지 않습니다.", code: "invalid_raffle_draw");
        if (expectedDrawIndex is < 1 or > 100)
            throw new VNextDevelopmentException("다음 추첨 순서가 올바르지 않습니다.", code: "invalid_raffle_draw");
        if (!Guid.TryParseExact(expectedAgentDeviceId?.Trim(), "D", out var parsedAgentDeviceId))
            throw new VNextDevelopmentException("추첨 화면을 송출할 PC가 올바르지 않습니다.", code: "invalid_raffle_draw");
        var normalizedDrawId = parsedDrawId.ToString("D");
        var normalizedAgentDeviceId = parsedAgentDeviceId.ToString("D");
        var token = await GetValidAccessTokenAsync(cancellationToken);
        var result = await SendAutomationRequestAsync(
            HttpMethod.Post,
            "/rest/v1/rpc/draw_next_raffle_winner_v2",
            new
            {
                p_workspace_id = WorkspaceId,
                p_draw_id = normalizedDrawId,
                p_expected_draw_index = expectedDrawIndex,
                p_expected_agent_device_id = normalizedAgentDeviceId
            },
            token,
            "한 장 추첨",
            cancellationToken);
        RequireObject(result, "한 장 추첨");
        if (!result.TryGetProperty("winner", out var winner) || winner.ValueKind != JsonValueKind.Object)
            throw new VNextDevelopmentException("당첨 결과 형식이 올바르지 않습니다.", code: "invalid_automation_response");
        if (!result.TryGetProperty("completed", out var completed)
            || completed.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            throw new VNextDevelopmentException("추첨 진행 상태 형식이 올바르지 않습니다.", code: "invalid_automation_response");
        var returnedDrawId = RequireResponseGuidString(result, "drawId", "한 장 추첨");
        var returnedAgentDeviceId = RequireResponseGuidString(result, "agentDeviceId", "한 장 추첨");
        var drawnCount = RequireInt(result, "drawnCount", 1, 100, "한 장 추첨");
        var remainingCount = RequireInt(result, "remainingCount", 0, 99, "한 장 추첨");
        if (!string.Equals(returnedDrawId, normalizedDrawId, StringComparison.Ordinal)
            || !string.Equals(returnedAgentDeviceId, normalizedAgentDeviceId, StringComparison.Ordinal)
            || !winner.TryGetProperty("drawIndex", out var winnerDrawIndex)
            || !winnerDrawIndex.TryGetInt32(out var returnedDrawIndex)
            || returnedDrawIndex != expectedDrawIndex
            || drawnCount != expectedDrawIndex
            || completed.GetBoolean() != (remainingCount == 0))
            throw new VNextDevelopmentException(
                "한 장 추첨 결과가 요청한 추첨함·순서·PC와 일치하지 않습니다.",
                code: "invalid_automation_response");
        return new VNextRaffleNextReceipt(
            returnedDrawId,
            RequireResponseGuidString(result, "roundId", "한 장 추첨"),
            RequireResponseGuidString(result, "executionId", "한 장 추첨"),
            returnedAgentDeviceId,
            winner.Clone(),
            drawnCount,
            remainingCount,
            completed.GetBoolean());
    }

    public async Task<VNextRaffleReannounceReceipt> ReannounceRaffleWinnerAsync(
        string drawId,
        int drawIndex,
        int expectedReannounceNumber,
        CancellationToken cancellationToken = default)
    {
        if (!Guid.TryParseExact(drawId?.Trim(), "D", out var parsedDrawId))
            throw new VNextDevelopmentException("재송출할 추첨 기록이 올바르지 않습니다.", code: "invalid_raffle_reannounce");
        if (drawIndex is < 1 or > 100 || expectedReannounceNumber is < 1 or > 10)
            throw new VNextDevelopmentException("당첨 재송출 순서가 올바르지 않습니다.", code: "invalid_raffle_reannounce");

        var normalizedDrawId = parsedDrawId.ToString("D");
        var token = await GetValidAccessTokenAsync(cancellationToken);
        var result = await SendAutomationRequestAsync(
            HttpMethod.Post,
            "/rest/v1/rpc/reannounce_raffle_winner_v1",
            new
            {
                p_workspace_id = WorkspaceId,
                p_draw_id = normalizedDrawId,
                p_draw_index = drawIndex,
                p_expected_reannounce_number = expectedReannounceNumber
            },
            token,
            "동일 당첨 재송출",
            cancellationToken);
        RequireObject(result, "동일 당첨 재송출");

        var returnedDrawId = RequireResponseGuidString(result, "drawId", "동일 당첨 재송출");
        var returnedDrawIndex = RequireInt(result, "drawIndex", 1, 100, "동일 당첨 재송출");
        var returnedReannounceNumber = RequireInt(result, "reannounceNumber", 1, 10, "동일 당첨 재송출");
        if (!string.Equals(returnedDrawId, normalizedDrawId, StringComparison.Ordinal)
            || returnedDrawIndex != drawIndex
            || returnedReannounceNumber != expectedReannounceNumber)
            throw new VNextDevelopmentException(
                "당첨 재송출 결과가 요청과 일치하지 않습니다.",
                code: "invalid_automation_response");
        if (!result.TryGetProperty("winner", out var winner) || winner.ValueKind != JsonValueKind.Object)
            throw new VNextDevelopmentException("재송출 당첨자 형식이 올바르지 않습니다.", code: "invalid_automation_response");
        if (!winner.TryGetProperty("drawIndex", out var winnerIndex)
            || !winnerIndex.TryGetInt32(out var parsedWinnerIndex)
            || parsedWinnerIndex != drawIndex
            || !winner.TryGetProperty("actorName", out var actorName)
            || actorName.ValueKind != JsonValueKind.String
            || string.IsNullOrWhiteSpace(actorName.GetString())
            || actorName.GetString()!.Length > 120)
            throw new VNextDevelopmentException("재송출 당첨자 결과가 요청과 일치하지 않습니다.", code: "invalid_automation_response");
        if (!result.TryGetProperty("created", out var created)
            || created.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            throw new VNextDevelopmentException("당첨 재송출 생성 상태가 올바르지 않습니다.", code: "invalid_automation_response");

        return new VNextRaffleReannounceReceipt(
            returnedDrawId,
            RequireResponseGuidString(result, "roundId", "동일 당첨 재송출"),
            returnedDrawIndex,
            returnedReannounceNumber,
            RequireResponseGuidString(result, "executionId", "동일 당첨 재송출"),
            RequireResponseGuidString(result, "agentDeviceId", "동일 당첨 재송출"),
            RequireResponseGuidString(result, "originalExecutionId", "동일 당첨 재송출"),
            winner.Clone(),
            created.GetBoolean());
    }

    public async Task<VNextAgentDeviceRenameReceipt> RenameAgentDeviceAsync(
        string deviceId,
        long expectedRevision,
        string displayName,
        CancellationToken cancellationToken = default)
    {
        var normalizedDeviceId = NormalizeDeviceId(deviceId);
        if (expectedRevision < 1)
            throw new VNextDevelopmentException("장치 변경 버전이 올바르지 않습니다.", code: "invalid_device_revision");
        var normalizedName = NormalizeDeviceName(displayName);
        var token = await GetValidAccessTokenAsync(cancellationToken);
        var result = await SendAutomationRequestAsync(
            HttpMethod.Post,
            "/rest/v1/rpc/rename_agent_device_v1",
            new
            {
                p_workspace_id = WorkspaceId,
                p_agent_device_id = normalizedDeviceId,
                p_expected_revision = expectedRevision,
                p_display_name = normalizedName
            },
            token,
            "등록 PC 이름 변경",
            cancellationToken);
        var receipt = ExactlyOneObject(result, "등록 PC 이름 변경");
        var returnedDeviceId = RequireResponseGuidString(receipt, "device_id", "등록 PC 이름 변경");
        if (!string.Equals(returnedDeviceId, normalizedDeviceId, StringComparison.Ordinal))
            throw new VNextDevelopmentException(
                "등록 PC 이름 변경 결과의 장치가 요청과 일치하지 않습니다.",
                code: "invalid_automation_response");
        return new VNextAgentDeviceRenameReceipt(
            returnedDeviceId,
            BoundedResponseText(receipt, "display_name", "등록 PC 이름 변경", 1, 60),
            RequireLong(receipt, "management_revision", 1, long.MaxValue, "등록 PC 이름 변경"));
    }

    public async Task<VNextAgentDeviceRevokeReceipt> RevokeAgentDeviceAsync(
        string deviceId,
        long expectedRevision,
        CancellationToken cancellationToken = default)
    {
        var normalizedDeviceId = NormalizeDeviceId(deviceId);
        if (expectedRevision < 1)
            throw new VNextDevelopmentException("장치 변경 버전이 올바르지 않습니다.", code: "invalid_device_revision");
        var token = await GetValidAccessTokenAsync(cancellationToken);
        var result = await SendAutomationRequestAsync(
            HttpMethod.Post,
            "/rest/v1/rpc/revoke_agent_device_v1",
            new
            {
                p_workspace_id = WorkspaceId,
                p_agent_device_id = normalizedDeviceId,
                p_expected_revision = expectedRevision
            },
            token,
            "등록 PC 해제",
            cancellationToken);
        var receipt = ExactlyOneObject(result, "등록 PC 해제");
        var returnedDeviceId = RequireResponseGuidString(receipt, "device_id", "등록 PC 해제");
        if (!string.Equals(returnedDeviceId, normalizedDeviceId, StringComparison.Ordinal))
            throw new VNextDevelopmentException(
                "등록 PC 해제 결과의 장치가 요청과 일치하지 않습니다.",
                code: "invalid_automation_response");
        _ = RequireResponseTimestamp(receipt, "revoked_at", "등록 PC 해제");
        return new VNextAgentDeviceRevokeReceipt(
            returnedDeviceId,
            RequireLong(receipt, "management_revision", 1, long.MaxValue, "등록 PC 해제"),
            RequireInt(receipt, "disabled_rule_count", 0, int.MaxValue, "등록 PC 해제"));
    }

    private async Task<JsonElement> SendAutomationRequestAsync(
        HttpMethod method,
        string path,
        object? body,
        string accessToken,
        string purpose,
        CancellationToken cancellationToken)
    {
        var requestLease = CaptureSessionRequestLease(accessToken);
        using var request = new HttpRequestMessage(method, SupabaseUrl + path);
        request.Headers.TryAddWithoutValidation("apikey", PublishableKey);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        if (body is not null)
            request.Content = new StringContent(
                VNextAutomationRpcSerializer.Serialize(body),
                Encoding.UTF8,
                "application/json");

        using var response = await _http.SendAsync(request, cancellationToken);
        var responseText = await response.Content.ReadAsStringAsync(cancellationToken);
        if (responseText.Length > MaximumAutomationResponseChars)
            throw new VNextDevelopmentException($"{purpose} 응답 크기가 제한을 초과했습니다.", code: "automation_response_too_large");
        if (!response.IsSuccessStatusCode)
        {
            if (response.StatusCode == HttpStatusCode.Unauthorized)
                await InvalidateSessionIfCurrentAsync(requestLease);
            var code = ReadErrorCode(responseText);
            var serverMessage = ReadAutomationErrorMessage(responseText);
            var message = code switch
            {
                "55000" when purpose == "테스트 송출" =>
                    "이미 이 액션의 테스트 송출이 진행 중입니다. 잠시 후 다시 확인해주세요.",
                "40001" when purpose == "테스트 송출" =>
                    "액션 설정이 다른 화면에서 변경되었습니다. 새로고침한 뒤 다시 시도해주세요.",
                "P0002" when purpose == "테스트 송출" =>
                    "테스트할 액션이나 등록 PC를 찾을 수 없습니다. 목록을 새로고침해주세요.",
                "PT409" when purpose == "테스트 송출" =>
                    "선택한 PC가 현재 온라인이 아니거나 이 액션을 지원하지 않습니다. 에이전트 상태를 확인해주세요.",
                "22023" when purpose == "테스트 송출" =>
                    "이 액션은 테스트 송출을 지원하지 않습니다.",
                "P0002" when purpose == "추첨 실행" =>
                    "진행할 추첨 회차가 없습니다. 추첨권이 먼저 지급되어야 합니다.",
                "PT409" when purpose == "추첨 실행" =>
                    "추첨 화면을 송출할 PC가 현재 온라인이 아닙니다.",
                "22023" when purpose == "추첨 실행" =>
                    "당첨 개수가 현재 추첨권 또는 참여자 수보다 많습니다.",
                "P0002" when purpose == "추첨 시작" =>
                    "시작할 추첨함이 없습니다. 추첨권이 먼저 지급되어야 합니다.",
                "PT409" when purpose == "추첨 시작"
                    && serverMessage == "a sealed raffle draw is already active" =>
                    "이미 진행 중인 추첨이 있습니다. 남은 당첨 티켓을 한 장씩 뽑아주세요.",
                "PT409" when purpose == "추첨 시작" =>
                    "추첨 화면을 송출할 PC가 현재 온라인이 아닙니다.",
                "22023" when purpose == "추첨 시작" =>
                    "당첨 개수가 현재 추첨권 또는 참여자 수보다 많습니다.",
                "P0002" when purpose == "한 장 추첨" =>
                    "진행 중인 추첨을 찾을 수 없습니다. 추첨 현황을 새로고침해주세요.",
                "40001" when purpose == "한 장 추첨" =>
                    "다른 화면에서 먼저 추첨했습니다. 최신 결과를 불러왔으니 다시 확인해주세요.",
                "PT409" when purpose == "한 장 추첨"
                    && serverMessage == "raffle draw is already complete" =>
                    "이 추첨은 이미 완료되었습니다.",
                "PT409" when purpose == "한 장 추첨" =>
                    "추첨 화면을 송출할 PC가 현재 온라인이 아닙니다.",
                "22023" when purpose == "한 장 추첨" =>
                    "남은 추첨권 상태를 확인할 수 없습니다. 현황을 새로고침해주세요.",
                "P0002" when purpose == "동일 당첨 재송출" =>
                    "재송출할 당첨 기록이나 원본 송출을 찾을 수 없습니다. 추첨 현황을 새로고침해주세요.",
                "40001" when purpose == "동일 당첨 재송출" =>
                    "다른 화면에서 먼저 재송출했습니다. 최신 추첨 현황을 불러온 뒤 다시 확인해주세요.",
                "PT409" when purpose == "동일 당첨 재송출"
                    && serverMessage == "raffle winner reannounce limit was reached" =>
                    "동일 당첨 재송출은 최대 10회까지 가능합니다.",
                "PT409" when purpose == "동일 당첨 재송출" =>
                    "추첨 화면을 송출할 PC가 현재 온라인이 아닙니다.",
                "22023" when purpose == "동일 당첨 재송출" =>
                    "재송출할 당첨 기록을 다시 선택해주세요.",
                "PT409" when purpose == "규칙 저장"
                    && serverMessage == "only one raffle ticket rule can be active at a time" =>
                    "추첨 액션은 하나만 사용할 수 있습니다. 목록에서 기존 추첨 액션의 수정 버튼을 눌러 변경해주세요.",
                "PT409" when purpose == "규칙 저장"
                    && serverMessage == "an open raffle round must be drawn before changing its rule" =>
                    "현재 추첨권이 모인 회차가 있습니다. 먼저 추첨을 완료한 뒤 설정을 변경해주세요.",
                "PT409" when purpose == "규칙 저장"
                    && serverMessage == "an active raffle round must be completed before changing its rule" =>
                    "현재 접수 또는 추첨 중인 회차가 있습니다. 먼저 추첨을 완료한 뒤 설정을 변경해주세요.",
                "PT409" when purpose == "규칙 저장"
                    && serverMessage == "raffle action agent device is unavailable" =>
                    "선택한 PC에서 추첨 기능을 사용할 수 없습니다. 최신 별록의 PC를 다시 선택해주세요.",
                "42501" when purpose.StartsWith("등록 PC", StringComparison.Ordinal) =>
                    "이 workspace의 등록 PC를 관리할 권한이 없습니다.",
                "42501" when purpose.Contains("이미지", StringComparison.Ordinal) =>
                    "이 workspace의 오버레이 화면 상태를 확인할 권한이 없습니다.",
                "42501" => "이 workspace의 자동화 규칙을 관리할 권한이 없습니다.",
                "40001" when purpose.StartsWith("등록 PC", StringComparison.Ordinal) =>
                    "다른 화면에서 PC 정보가 먼저 변경되었습니다. 목록을 새로고침한 뒤 다시 시도해주세요.",
                "40001" => "다른 화면에서 규칙이 먼저 변경되었습니다. 새로고침 후 다시 시도해주세요.",
                "22023" => "입력한 장치 관리 정보를 확인해주세요.",
                "P0002" => "등록 PC를 찾을 수 없습니다. 목록을 새로고침해주세요.",
                "PGRST202" => "서버 기능 버전이 에이전트와 맞지 않습니다. 최신 서버 배포 상태를 확인해주세요.",
                "23505" => "같은 위치의 규칙 데이터가 이미 있습니다. 목록을 새로고침해주세요.",
                _ => $"{purpose} 요청 실패 (HTTP {(int)response.StatusCode}, {code})"
            };
            throw new VNextDevelopmentException(message, (int)response.StatusCode, code);
        }

        try
        {
            using var document = JsonDocument.Parse(responseText);
            return document.RootElement.Clone();
        }
        catch (JsonException)
        {
            throw new VNextDevelopmentException($"{purpose} 응답 형식이 올바르지 않습니다.", code: "invalid_automation_response");
        }
    }

    private static string ReadAutomationErrorMessage(string responseText)
    {
        try
        {
            using var document = JsonDocument.Parse(responseText);
            if (document.RootElement.TryGetProperty("message", out var value)
                && value.ValueKind == JsonValueKind.String)
                return value.GetString()?.Trim() ?? string.Empty;
        }
        catch { }
        return string.Empty;
    }

    private VNextAutomationRuleRpc ParseAutomationRuleDraft(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object)
            throw new VNextDevelopmentException("규칙 입력 형식이 올바르지 않습니다.", code: "invalid_rule_payload");

        var name = BoundedText(payload, "name", "규칙 이름", 1, 120);
        var source = RequiredChoice(payload, "source", "후원 입력 경로", "weflab", "byeollog");
        var eventType = RequiredChoice(payload, "eventType", "이벤트 종류", "roulette", "donation");
        var actionType = RequiredChoice(
            payload,
            "actionType",
            "실행 동작",
            "upbo.apply",
            "obs.mute_for",
            "windows.mic_mute_for",
            "roulette.reward_multiplier_next",
            "raffle.ticket_grant");
        var subtype = OptionalText(payload, "subtype", "세부 구분", 120);
        var result = eventType == "roulette"
            ? BoundedText(payload, "result", "룰렛 결과", 1, 500)
            : null;
        var minAmount = eventType == "donation"
            ? OptionalLong(payload, "minAmount", "고정 별풍선", 1, long.MaxValue)
            : null;
        if (eventType == "donation" && minAmount is null)
            throw new VNextDevelopmentException("후원 이벤트에는 고정 별풍선을 입력해주세요.", code: "invalid_rule_payload");
        var priority = OptionalInt(payload, "priority", 100, "우선순위", -10_000, 10_000);
        var enabled = OptionalBool(payload, "enabled", true);

        string? eventName = null;
        string[]? outputTypes = null;
        int? quantity = null;
        int? durationSeconds = null;
        string? agentDeviceId = null;
        string? overlayImageKey = null;
        int? overlayPositionX = null;
        int? overlayPositionY = null;
        int? overlayScalePercent = null;
        int? rewardMultiplier = null;
        bool? allowMultiplierStacking = null;
        int? raffleTicketUnit = null;
        bool? raffleAllowMultiples = null;
        int? raffleTicketPositionX = null;
        int? raffleTicketPositionY = null;
        int? raffleTicketScalePercent = null;
        int? raffleTicketVolumePercent = null;
        int? raffleDrawPositionX = null;
        int? raffleDrawPositionY = null;
        int? raffleDrawScalePercent = null;
        int? raffleDrawVolumePercent = null;

        if (actionType == "roulette.reward_multiplier_next")
        {
            if (eventType != "roulette")
                throw new VNextDevelopmentException(
                    "다음 룰렛 보상 증가는 룰렛 결과에만 설정할 수 있습니다.",
                    code: "invalid_rule_payload");
            rewardMultiplier = RequiredInt(payload, "rewardMultiplier", 2, 100, "배수 설정");
            allowMultiplierStacking = OptionalBool(payload, "allowMultiplierStacking", false);
        }
        else if (actionType == "raffle.ticket_grant")
        {
            if (eventType != "donation")
                throw new VNextDevelopmentException(
                    "추첨권 지급은 후원 이벤트에만 설정할 수 있습니다.",
                    code: "invalid_rule_payload");
            raffleTicketUnit = RequiredInt(payload, "raffleTicketUnit", 1, 1_000_000, "추첨권 1장 기준");
            if (minAmount != raffleTicketUnit.Value)
                throw new VNextDevelopmentException(
                    "후원 기준과 추첨권 1장 기준이 일치하지 않습니다.",
                    code: "invalid_rule_payload");
            agentDeviceId = RequireGuidString(payload, "agentDeviceId", "등록 PC");
            raffleAllowMultiples = OptionalBool(payload, "raffleAllowMultiples", false);
            raffleTicketPositionX = RequiredInt(payload, "raffleTicketPositionX", 0, 10_000, "추첨권 지급 화면 가로 위치");
            raffleTicketPositionY = RequiredInt(payload, "raffleTicketPositionY", 0, 10_000, "추첨권 지급 화면 세로 위치");
            raffleTicketScalePercent = RequiredInt(payload, "raffleTicketScalePercent", 25, 200, "추첨권 지급 화면 크기");
            raffleTicketVolumePercent = RequiredInt(payload, "raffleTicketVolumePercent", 0, 100, "추첨권 지급 TTS 음량");
            raffleDrawPositionX = RequiredInt(payload, "raffleDrawPositionX", 0, 10_000, "추첨 화면 가로 위치");
            raffleDrawPositionY = RequiredInt(payload, "raffleDrawPositionY", 0, 10_000, "추첨 화면 세로 위치");
            raffleDrawScalePercent = RequiredInt(payload, "raffleDrawScalePercent", 25, 200, "추첨 화면 크기");
            raffleDrawVolumePercent = RequiredInt(payload, "raffleDrawVolumePercent", 0, 100, "당첨 TTS 음량");
        }
        else if (actionType == "upbo.apply")
        {
            eventName = BoundedText(payload, "eventName", "업보 이벤트 이름", 1, 160);
            outputTypes = StringArray(payload, "outputTypes", "결과물 종류", 1, 20, 160);
            quantity = OptionalInt(payload, "quantity", 1, "종류별 수량", 1, 100);
            if (outputTypes.Length * quantity.Value > 200)
                throw new VNextDevelopmentException("한 번에 만드는 업보 수량은 전체 200개 이하여야 합니다.", code: "invalid_rule_quantity");
        }
        else
        {
            durationSeconds = RequiredInt(payload, "durationSeconds", 1, 240, "음소거 시간");
            agentDeviceId = RequireGuidString(payload, "agentDeviceId", "등록 PC");
            var overlayEnabled = OptionalBool(payload, "overlayEnabled", false);
            if (overlayEnabled)
            {
                overlayImageKey = BoundedText(payload, "overlayImageKey", "오버레이 이미지", 2, 64);
                if (!OverlayAssetCache.IsPackagedImageKey(overlayImageKey))
                    throw new VNextDevelopmentException(
                        "이 버전의 별록에 포함되지 않은 오버레이 이미지입니다.",
                        code: "invalid_rule_payload");
                overlayPositionX = OptionalNullableInt(payload, "overlayPositionX", "오버레이 가로 위치", 0, 10_000);
                overlayPositionY = OptionalNullableInt(payload, "overlayPositionY", "오버레이 세로 위치", 0, 10_000);
                overlayScalePercent = OptionalNullableInt(payload, "overlayScalePercent", "오버레이 크기", 25, 200) ?? 100;
                if (overlayPositionX.HasValue != overlayPositionY.HasValue)
                    throw new VNextDevelopmentException(
                        "오버레이 가로·세로 위치를 함께 지정해주세요.",
                        code: "invalid_rule_payload");
            }
        }

        string? replaceRuleId = null;
        int? expectedVersion = null;
        if (payload.TryGetProperty("replaceRuleId", out var replaceValue)
            && replaceValue.ValueKind != JsonValueKind.Null)
        {
            if (replaceValue.ValueKind != JsonValueKind.String)
                throw new VNextDevelopmentException("교체 규칙 형식이 올바르지 않습니다.", code: "invalid_rule_payload");
            if (!string.IsNullOrWhiteSpace(replaceValue.GetString()))
            {
                replaceRuleId = RequireGuidString(payload, "replaceRuleId", "교체 규칙");
                expectedVersion = RequiredInt(payload, "expectedVersion", 1, int.MaxValue, "교체 규칙 버전");
            }
        }
        if (replaceRuleId is null
            && payload.TryGetProperty("expectedVersion", out var orphanVersion)
            && orphanVersion.ValueKind != JsonValueKind.Null)
            throw new VNextDevelopmentException("교체 규칙과 버전을 함께 입력해주세요.", code: "invalid_rule_payload");

        return new VNextAutomationRuleRpc(
            WorkspaceId,
            name,
            enabled,
            priority,
            source,
            eventType,
            subtype,
            result,
            minAmount,
            actionType,
            eventName,
            outputTypes,
            quantity,
            durationSeconds,
            agentDeviceId,
            overlayImageKey,
            overlayPositionX,
            overlayPositionY,
            overlayScalePercent,
            rewardMultiplier,
            allowMultiplierStacking,
            raffleTicketUnit,
            raffleAllowMultiples,
            raffleTicketPositionX,
            raffleTicketPositionY,
            raffleTicketScalePercent,
            raffleTicketVolumePercent,
            raffleDrawPositionX,
            raffleDrawPositionY,
            raffleDrawScalePercent,
            raffleDrawVolumePercent,
            replaceRuleId,
            expectedVersion);
    }

    private static JsonElement FirstObject(JsonElement value, string purpose)
    {
        if (value.ValueKind == JsonValueKind.Array && value.GetArrayLength() > 0)
            value = value[0];
        if (value.ValueKind != JsonValueKind.Object)
            throw new VNextDevelopmentException($"{purpose} 결과를 확인할 수 없습니다.", code: "invalid_automation_response");
        return value;
    }

    private static JsonElement ExactlyOneObject(JsonElement value, string purpose)
    {
        if (value.ValueKind != JsonValueKind.Array
            || value.GetArrayLength() != 1
            || value[0].ValueKind != JsonValueKind.Object)
            throw new VNextDevelopmentException(
                $"{purpose} 결과 행 수가 올바르지 않습니다.",
                code: "invalid_automation_response");
        return value[0];
    }

    private static void RequireArray(JsonElement value, string purpose, int maximumItems)
    {
        if (value.ValueKind != JsonValueKind.Array || value.GetArrayLength() > maximumItems)
            throw new VNextDevelopmentException($"{purpose} 응답 형식이 올바르지 않습니다.", code: "invalid_automation_response");
    }

    private static void RequireObject(JsonElement value, string purpose)
    {
        if (value.ValueKind != JsonValueKind.Object)
            throw new VNextDevelopmentException($"{purpose} 응답 형식이 올바르지 않습니다.", code: "invalid_automation_response");
    }

    private static IReadOnlyList<VNextAutomationDeviceView> ParseAgentDevices(JsonElement value)
    {
        var rows = new List<VNextAutomationDeviceView>();
        var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var row in value.EnumerateArray())
        {
            if (row.ValueKind != JsonValueKind.Object)
                throw InvalidDeviceResponse();
            var deviceId = RequireGuidString(row, "device_id", "등록 PC 목록");
            if (!ids.Add(deviceId)) throw InvalidDeviceResponse();
            var displayName = BoundedResponseText(row, "display_name", "등록 PC 목록", 1, 60);
            var registeredAt = RequiredTimestamp(row, "registered_at");
            var lastSeenAt = OptionalTimestamp(row, "last_seen_at");
            var lastReportedAt = OptionalTimestamp(row, "last_reported_at");
            var revokedAt = OptionalTimestamp(row, "revoked_at");
            var agentVersion = OptionalResponseText(row, "agent_version", 64);
            if (agentVersion is not null && !AgentVersionPattern.IsMatch(agentVersion))
                throw InvalidDeviceResponse();
            var platform = OptionalResponseText(row, "platform", 16);
            if (platform is not null && platform is not ("windows" or "linux" or "macos" or "unknown"))
                throw InvalidDeviceResponse();
            if (!row.TryGetProperty("supported_action_types", out var actionRows))
                throw InvalidDeviceResponse();
            var actions = actionRows.ValueKind == JsonValueKind.Null
                ? Array.Empty<string>()
                : actionRows.ValueKind == JsonValueKind.Array && actionRows.GetArrayLength() <= 32
                    ? actionRows.EnumerateArray()
                        .Select(item => item.ValueKind == JsonValueKind.String ? item.GetString()?.Trim() ?? "" : "")
                        .ToArray()
                    : throw InvalidDeviceResponse();
            if (actions.Any(action => !AgentActionPattern.IsMatch(action))
                || actions.Distinct(StringComparer.Ordinal).Count() != actions.Length)
                throw InvalidDeviceResponse();
            var overlayReady = OptionalResponseBool(row, "overlay_assets_ready");
            var managedAssets = OptionalResponseInt(row, "managed_overlay_assets", 0, 100);
            var revision = RequireLong(row, "management_revision", 1, long.MaxValue, "등록 PC 목록");
            var connectionState = BoundedResponseText(row, "connection_state", "등록 PC 목록", 1, 32);
            if (connectionState is not ("online" or "idle" or "offline" or "never_reported" or "revoked")
                || (connectionState == "revoked") != revokedAt.HasValue)
                throw InvalidDeviceResponse();
            rows.Add(new VNextAutomationDeviceView(
                deviceId,
                displayName,
                registeredAt,
                lastSeenAt,
                lastReportedAt,
                revokedAt,
                agentVersion,
                platform,
                actions,
                overlayReady,
                managedAssets,
                revision,
                connectionState));
        }
        return rows;
    }

    private static IReadOnlyList<VNextAutomationOverlayAssetView> ParseOverlayAssets(JsonElement value)
    {
        var rows = new List<VNextAutomationOverlayAssetView>();
        var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var revisions = new HashSet<string>(StringComparer.Ordinal);
        foreach (var row in value.EnumerateArray())
        {
            if (row.ValueKind != JsonValueKind.Object) throw InvalidOverlayResponse();
            var assetId = RequireGuidString(row, "id", "오버레이 이미지 목록");
            var assetKey = BoundedResponseText(row, "asset_key", "오버레이 이미지 목록", 2, 64);
            var version = RequireInt(row, "version_number", 1, int.MaxValue, "오버레이 이미지 목록");
            var displayName = BoundedResponseText(row, "display_name", "오버레이 이미지 목록", 1, 120);
            var mimeType = BoundedResponseText(row, "mime_type", "오버레이 이미지 목록", 1, 80);
            var contentSha256 = BoundedResponseText(row, "content_sha256", "오버레이 이미지 목록", 64, 64).ToLowerInvariant();
            var byteSize = RequireInt(row, "byte_size", 1, OverlayAssetValidator.MaximumBytes, "오버레이 이미지 목록");
            var width = RequireInt(row, "width_px", 1, 7_680, "오버레이 이미지 목록");
            var height = RequireInt(row, "height_px", 1, 7_680, "오버레이 이미지 목록");
            var deliveryMode = BoundedResponseText(row, "delivery_mode", "오버레이 이미지 목록", 1, 32);
            if (!OverlayAssetCatalogCompatibility.TryNormalizeExactBuiltIn(
                    assetId,
                    version,
                    mimeType,
                    contentSha256,
                    byteSize,
                    width,
                    height,
                    ref assetKey,
                    ref deliveryMode))
                throw InvalidOverlayResponse();
            if (!ids.Add(assetId) || !revisions.Add(assetKey + "\0" + version))
                throw InvalidOverlayResponse();
            if (row.TryGetProperty("retired_at", out var retired) && retired.ValueKind != JsonValueKind.Null)
                throw InvalidOverlayResponse();
            var descriptor = new VNextOverlayAssetDescriptor(
                assetId,
                assetKey,
                version,
                displayName,
                mimeType,
                contentSha256,
                byteSize,
                width,
                height,
                deliveryMode,
                false,
                null);
            try { OverlayAssetValidator.ValidateDescriptor(descriptor, manifestItem: false); }
            catch (InvalidDataException) { throw InvalidOverlayResponse(); }
            if (!row.TryGetProperty("overlay_asset_durations", out var durationRows)
                || durationRows.ValueKind != JsonValueKind.Array
                || durationRows.GetArrayLength() is < 1 or > 240)
                throw InvalidOverlayResponse();
            var durations = durationRows.EnumerateArray()
                .Select(item => item.ValueKind == JsonValueKind.Object
                    && item.TryGetProperty("duration_ms", out var duration)
                    && duration.TryGetInt32(out var milliseconds)
                    && milliseconds is >= 1_000 and <= 240_000
                    && milliseconds % 1_000 == 0
                        ? milliseconds / 1_000
                        : 0)
                .OrderBy(item => item)
                .ToArray();
            if (durations.Any(item => item == 0)
                || durations.Distinct().Count() != durations.Length)
                throw InvalidOverlayResponse();
            rows.Add(new VNextAutomationOverlayAssetView(
                assetId,
                assetKey,
                version,
                displayName,
                mimeType,
                contentSha256,
                byteSize,
                width,
                height,
                deliveryMode,
                durations));
        }
        return rows;
    }

    private static IReadOnlyList<VNextAutomationAssetReadinessView> ParseAssetReadiness(JsonElement value)
    {
        var rows = new List<VNextAutomationAssetReadinessView>();
        var keys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var row in value.EnumerateArray())
        {
            if (row.ValueKind != JsonValueKind.Object) throw InvalidReadinessResponse();
            var deviceId = RequireGuidString(row, "agent_device_id", "이미지 준비 상태");
            var assetId = RequireGuidString(row, "asset_id", "이미지 준비 상태");
            var hash = BoundedResponseText(row, "content_sha256", "이미지 준비 상태", 64, 64).ToLowerInvariant();
            if (!Sha256Pattern.IsMatch(hash) || !keys.Add(deviceId + "\0" + assetId))
                throw InvalidReadinessResponse();
            var reportedAt = RequiredTimestamp(row, "reported_at");
            if (!row.TryGetProperty("fresh", out var fresh)
                || fresh.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                throw InvalidReadinessResponse();
            rows.Add(new VNextAutomationAssetReadinessView(
                deviceId,
                assetId,
                hash,
                reportedAt,
                fresh.GetBoolean()));
        }
        return rows;
    }

    private static VNextDevelopmentException InvalidDeviceResponse() =>
        new("등록 PC 목록에 안전하지 않은 항목이 있습니다.", code: "invalid_automation_response");

    private static VNextDevelopmentException InvalidOverlayResponse() =>
        new("오버레이 이미지 목록에 안전하지 않은 항목이 있습니다.", code: "invalid_automation_response");

    private static VNextDevelopmentException InvalidReadinessResponse() =>
        new("이미지 준비 상태에 안전하지 않은 항목이 있습니다.", code: "invalid_automation_response");

    private static DateTimeOffset RequiredTimestamp(JsonElement payload, string property) =>
        OptionalTimestamp(payload, property) ?? throw InvalidDeviceResponse();

    private static DateTimeOffset? OptionalTimestamp(JsonElement payload, string property)
    {
        if (!payload.TryGetProperty(property, out var value) || value.ValueKind == JsonValueKind.Null)
            return null;
        if (value.ValueKind != JsonValueKind.String
            || !DateTimeOffset.TryParse(value.GetString(), out var timestamp))
            throw InvalidDeviceResponse();
        return timestamp.ToUniversalTime();
    }

    private static string? OptionalResponseText(JsonElement payload, string property, int maximum)
    {
        if (!payload.TryGetProperty(property, out var value) || value.ValueKind == JsonValueKind.Null)
            return null;
        if (value.ValueKind != JsonValueKind.String) throw InvalidDeviceResponse();
        var text = value.GetString()?.Trim() ?? "";
        if (text.Length < 1 || text.Length > maximum || text.Any(char.IsControl))
            throw InvalidDeviceResponse();
        return text;
    }

    private static bool? OptionalResponseBool(JsonElement payload, string property)
    {
        if (!payload.TryGetProperty(property, out var value) || value.ValueKind == JsonValueKind.Null)
            return null;
        if (value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            throw InvalidDeviceResponse();
        return value.GetBoolean();
    }

    private static int? OptionalResponseInt(JsonElement payload, string property, int minimum, int maximum)
    {
        if (!payload.TryGetProperty(property, out var value) || value.ValueKind == JsonValueKind.Null)
            return null;
        if (!value.TryGetInt32(out var number) || number < minimum || number > maximum)
            throw InvalidDeviceResponse();
        return number;
    }

    private static string BoundedText(JsonElement payload, string property, string label, int minimum, int maximum)
    {
        if (!payload.TryGetProperty(property, out var value) || value.ValueKind != JsonValueKind.String)
            throw new VNextDevelopmentException($"{label}을 입력해주세요.", code: "invalid_rule_payload");
        var text = value.GetString()?.Trim() ?? "";
        if (text.Length < minimum || text.Length > maximum || text.Any(char.IsControl))
            throw new VNextDevelopmentException($"{label}은 {minimum}~{maximum}자로 입력해주세요.", code: "invalid_rule_payload");
        return text;
    }

    private static string NormalizeDeviceId(string value)
    {
        if (!Guid.TryParseExact(value?.Trim(), "D", out var parsed))
            throw new VNextDevelopmentException("장치 ID가 올바르지 않습니다.", code: "invalid_device_id");
        return parsed.ToString("D");
    }

    private static string NormalizeDeviceName(string value)
    {
        var normalized = value?.Trim() ?? "";
        if (normalized.Length is < 1 or > 60 || normalized.Any(char.IsControl))
            throw new VNextDevelopmentException("장치 이름은 1~60자로 입력해주세요.", code: "invalid_device_name");
        return normalized;
    }

    private static string BoundedResponseText(
        JsonElement payload,
        string property,
        string label,
        int minimum,
        int maximum)
    {
        if (!payload.TryGetProperty(property, out var value) || value.ValueKind != JsonValueKind.String)
            throw new VNextDevelopmentException($"{label} 결과가 올바르지 않습니다.", code: "invalid_automation_response");
        var text = value.GetString()?.Trim() ?? "";
        if (text.Length < minimum || text.Length > maximum || text.Any(char.IsControl))
            throw new VNextDevelopmentException($"{label} 결과가 올바르지 않습니다.", code: "invalid_automation_response");
        return text;
    }

    private static string? OptionalText(JsonElement payload, string property, string label, int maximum)
    {
        if (!payload.TryGetProperty(property, out var value) || value.ValueKind == JsonValueKind.Null) return null;
        if (value.ValueKind != JsonValueKind.String)
            throw new VNextDevelopmentException($"{label} 형식이 올바르지 않습니다.", code: "invalid_rule_payload");
        var text = value.GetString()?.Trim() ?? "";
        if (text.Length == 0) return null;
        if (text.Length > maximum || text.Any(char.IsControl))
            throw new VNextDevelopmentException($"{label}은 {maximum}자 이내로 입력해주세요.", code: "invalid_rule_payload");
        return text;
    }

    private static string RequiredChoice(JsonElement payload, string property, string label, params string[] choices)
    {
        var value = BoundedText(payload, property, label, 1, 120);
        if (!choices.Contains(value, StringComparer.Ordinal))
            throw new VNextDevelopmentException($"{label}을 확인해주세요.", code: "invalid_rule_payload");
        return value;
    }

    private static int RequiredInt(JsonElement payload, string property, int minimum, int maximum, string label)
    {
        if (!payload.TryGetProperty(property, out var value) || !value.TryGetInt32(out var number)
            || number < minimum || number > maximum)
            throw new VNextDevelopmentException($"{label}은 {minimum}~{maximum} 사이의 정수여야 합니다.", code: "invalid_rule_payload");
        return number;
    }

    private static int OptionalInt(JsonElement payload, string property, int fallback, string label, int minimum, int maximum)
    {
        if (!payload.TryGetProperty(property, out var value) || value.ValueKind == JsonValueKind.Null) return fallback;
        return RequiredInt(payload, property, minimum, maximum, label);
    }

    private static int? OptionalNullableInt(
        JsonElement payload,
        string property,
        string label,
        int minimum,
        int maximum)
    {
        if (!payload.TryGetProperty(property, out var value) || value.ValueKind == JsonValueKind.Null)
            return null;
        return RequiredInt(payload, property, minimum, maximum, label);
    }

    private static long? OptionalLong(JsonElement payload, string property, string label, long minimum, long maximum)
    {
        if (!payload.TryGetProperty(property, out var value) || value.ValueKind == JsonValueKind.Null) return null;
        if (!value.TryGetInt64(out var number) || number < minimum || number > maximum)
            throw new VNextDevelopmentException($"{label}은 {minimum} 이상의 정수여야 합니다.", code: "invalid_rule_payload");
        return number;
    }

    private static bool OptionalBool(JsonElement payload, string property, bool fallback)
    {
        if (!payload.TryGetProperty(property, out var value) || value.ValueKind == JsonValueKind.Null) return fallback;
        if (value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            throw new VNextDevelopmentException("규칙 사용 상태가 올바르지 않습니다.", code: "invalid_rule_payload");
        return value.GetBoolean();
    }

    private static string RequireGuidString(JsonElement payload, string property, string label)
    {
        if (!payload.TryGetProperty(property, out var value) || value.ValueKind != JsonValueKind.String
            || !Guid.TryParseExact(value.GetString()?.Trim(), "D", out var parsed))
            throw new VNextDevelopmentException($"{label}을 확인해주세요.", code: "invalid_rule_payload");
        return parsed.ToString("D");
    }

    private static int RequireInt(
        JsonElement payload,
        string property,
        int minimum,
        int maximum,
        string label)
    {
        if (!payload.TryGetProperty(property, out var value)
            || !value.TryGetInt32(out var number)
            || number < minimum
            || number > maximum)
            throw new VNextDevelopmentException(
                $"{label} 결과가 올바르지 않습니다.",
                code: "invalid_automation_response");
        return number;
    }

    private static string RequireResponseGuidString(
        JsonElement payload,
        string property,
        string label)
    {
        if (!payload.TryGetProperty(property, out var value)
            || value.ValueKind != JsonValueKind.String
            || !Guid.TryParseExact(value.GetString()?.Trim(), "D", out var parsed))
            throw new VNextDevelopmentException(
                $"{label} 결과가 올바르지 않습니다.",
                code: "invalid_automation_response");
        return parsed.ToString("D");
    }

    private static long RequireLong(
        JsonElement payload,
        string property,
        long minimum,
        long maximum,
        string label)
    {
        if (!payload.TryGetProperty(property, out var value)
            || !value.TryGetInt64(out var number)
            || number < minimum
            || number > maximum)
            throw new VNextDevelopmentException(
                $"{label} 결과가 올바르지 않습니다.",
                code: "invalid_automation_response");
        return number;
    }

    private static DateTimeOffset RequireResponseTimestamp(
        JsonElement payload,
        string property,
        string label)
    {
        if (!payload.TryGetProperty(property, out var value)
            || value.ValueKind != JsonValueKind.String
            || !DateTimeOffset.TryParse(value.GetString(), out var timestamp))
            throw new VNextDevelopmentException(
                $"{label} 결과가 올바르지 않습니다.",
                code: "invalid_automation_response");
        return timestamp.ToUniversalTime();
    }

    private static string[] StringArray(
        JsonElement payload,
        string property,
        string label,
        int minimumItems,
        int maximumItems,
        int maximumLength)
    {
        if (!payload.TryGetProperty(property, out var value) || value.ValueKind != JsonValueKind.Array)
            throw new VNextDevelopmentException($"{label}을 입력해주세요.", code: "invalid_rule_payload");
        var items = value.EnumerateArray().Select(item => item.ValueKind == JsonValueKind.String ? item.GetString()?.Trim() ?? "" : "").ToArray();
        if (items.Length < minimumItems || items.Length > maximumItems || items.Any(item => item.Length < 1 || item.Length > maximumLength || item.Any(char.IsControl)))
            throw new VNextDevelopmentException($"{label}은 항목당 {maximumLength}자 이내, 최대 {maximumItems}개로 입력해주세요.", code: "invalid_rule_payload");
        if (items.Distinct(StringComparer.Ordinal).Count() != items.Length)
            throw new VNextDevelopmentException($"중복된 {label}을 제거해주세요.", code: "invalid_rule_payload");
        return items;
    }

}
