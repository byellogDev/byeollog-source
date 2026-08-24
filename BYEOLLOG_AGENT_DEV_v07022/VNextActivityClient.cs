using System.Text.Json;
using System.Text.RegularExpressions;

namespace HurogiCollector;

internal sealed record VNextWorkspaceAccess(string Role, bool CanManage);

internal sealed record VNextActivityItem(
    string Id,
    string Status,
    int AttemptCount,
    int MaxAttempts,
    DateTimeOffset? NextAttemptAt,
    DateTimeOffset? LeaseExpiresAt,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    string ActionType,
    string ExecutionTarget,
    string? ErrorDisposition,
    string? ErrorCode,
    string EventSource,
    string EventType,
    string? EventSubtype,
    DateTimeOffset EventOccurredAt,
    string? ActorName,
    string? ActorId,
    string RuleName);

internal sealed record VNextActivityPage(
    IReadOnlyList<VNextActivityItem> Items,
    bool Saturated,
    DateTimeOffset LoadedAtUtc);

internal sealed record VNextReadinessRequirement(
    string RuleId,
    string ActionType,
    string ExecutionTarget,
    string? AgentDeviceId,
    string? OverlayAssetId);

internal sealed record VNextApprovedAssetReference(string AssetId, string ContentSha256);

internal sealed partial class VNextDevelopmentClient
{
    private static readonly Regex ActivityCodePattern = new(
        "^[a-z0-9_]{1,80}$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex ActivitySymbolPattern = new(
        "^[a-z][a-z0-9_.-]{0,119}$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly HashSet<string> ActivityStatuses = new(StringComparer.Ordinal)
    {
        "pending", "running", "retry_scheduled", "succeeded", "failed", "cancelled"
    };
    private static readonly HashSet<string> ActivityDispositions = new(StringComparer.Ordinal)
    {
        "blocked", "needs_review", "retrying"
    };
    private static readonly HashSet<string> WorkspaceRoles = new(StringComparer.Ordinal)
    {
        "owner", "admin", "member", "viewer"
    };

    public async Task<VNextWorkspaceAccess> GetWorkspaceAccessAsync(
        CancellationToken cancellationToken = default)
    {
        var authenticatedUserId = _authenticatedUserId;
        if (authenticatedUserId == Guid.Empty)
            throw new VNextDevelopmentException(
                "별록 계정 연결 정보를 확인할 수 없습니다.",
                code: "invalid_workspace_access");
        var token = await GetValidAccessTokenAsync(cancellationToken);
        var query =
            "/rest/v1/workspace_members?workspace_id=eq." + Uri.EscapeDataString(WorkspaceId) +
            "&user_id=eq." + Uri.EscapeDataString(authenticatedUserId.ToString("D")) +
            "&select=role,user_id&limit=2";
        var result = await SendAutomationRequestAsync(
            HttpMethod.Get,
            query,
            null,
            token,
            "workspace 접근 권한",
            cancellationToken);
        if (result.ValueKind != JsonValueKind.Array
            || result.GetArrayLength() != 1
            || result[0].ValueKind != JsonValueKind.Object
            || !result[0].TryGetProperty("user_id", out var userIdValue)
            || userIdValue.ValueKind != JsonValueKind.String
            || !Guid.TryParseExact(userIdValue.GetString(), "D", out var returnedUserId)
            || returnedUserId != authenticatedUserId
            || !result[0].TryGetProperty("role", out var roleValue)
            || roleValue.ValueKind != JsonValueKind.String)
            throw new VNextDevelopmentException("workspace 접근 권한을 확인할 수 없습니다.", code: "invalid_workspace_access");
        var role = roleValue.GetString() ?? "";
        if (!WorkspaceRoles.Contains(role))
            throw new VNextDevelopmentException("workspace 역할이 올바르지 않습니다.", code: "invalid_workspace_role");
        // Every normally approved Byeollog streamer owns their own workspace and
        // therefore receives the complete product surface. Invited read-only
        // members remain protected from rule and device mutations.
        return new VNextWorkspaceAccess(role, role is "owner" or "admin");
    }

    public async Task<VNextActivityPage> LoadActivityAsync(
        int limit = 100,
        CancellationToken cancellationToken = default)
    {
        if (limit is < 1 or > 100)
            throw new VNextDevelopmentException("활동 조회 범위가 올바르지 않습니다.", code: "invalid_activity_limit");
        var token = await GetValidAccessTokenAsync(cancellationToken);
        var result = await SendAutomationRequestAsync(
            HttpMethod.Post,
            "/rest/v1/rpc/list_automation_activity_v1",
            new { p_workspace_id = WorkspaceId, p_limit = limit },
            token,
            "자동화 활동",
            cancellationToken);
        if (result.ValueKind != JsonValueKind.Array || result.GetArrayLength() > limit)
            throw InvalidActivityResponse();

        var rows = new List<VNextActivityItem>(result.GetArrayLength());
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var row in result.EnumerateArray())
        {
            if (row.ValueKind != JsonValueKind.Object) throw InvalidActivityResponse();
            var id = ActivityGuid(row, "id");
            if (!ids.Add(id)) throw InvalidActivityResponse();
            var status = ActivityText(row, "status", 1, 32, required: true)!;
            if (!ActivityStatuses.Contains(status)) throw InvalidActivityResponse();
            var attemptCount = ActivityInt(row, "attempt_count", 0, 20);
            var maxAttempts = ActivityInt(row, "max_attempts", 1, 20);
            if (attemptCount > maxAttempts) throw InvalidActivityResponse();
            var actionType = ActivityText(row, "action_type", 1, 120, required: true)!;
            var executionTarget = ActivityText(row, "execution_target", 1, 120, required: true)!;
            var eventSource = ActivityText(row, "event_source", 1, 120, required: true)!;
            var eventType = ActivityText(row, "event_type", 1, 120, required: true)!;
            if (!ActivitySymbolPattern.IsMatch(actionType)
                || !ActivitySymbolPattern.IsMatch(executionTarget)
                || !ActivitySymbolPattern.IsMatch(eventSource)
                || !ActivitySymbolPattern.IsMatch(eventType))
                throw InvalidActivityResponse();
            var disposition = ActivityText(row, "error_disposition", 1, 32, required: false);
            if (disposition is not null && !ActivityDispositions.Contains(disposition))
                throw InvalidActivityResponse();
            var nextAttemptAt = ActivityTimestamp(row, "next_attempt_at", required: false);
            var leaseExpiresAt = ActivityTimestamp(row, "lease_expires_at", required: false);
            var errorCode = ActivityText(row, "error_code", 1, 80, required: false);
            if (errorCode is not null && !ActivityCodePattern.IsMatch(errorCode))
                throw InvalidActivityResponse();
            NormalizeActivityOutcome(
                status,
                nextAttemptAt,
                leaseExpiresAt,
                ref disposition,
                ref errorCode);

            rows.Add(new VNextActivityItem(
                id,
                status,
                attemptCount,
                maxAttempts,
                nextAttemptAt,
                leaseExpiresAt,
                ActivityTimestamp(row, "created_at", required: true)!.Value,
                ActivityTimestamp(row, "updated_at", required: true)!.Value,
                actionType,
                executionTarget,
                disposition,
                errorCode,
                eventSource,
                eventType,
                ActivityText(row, "event_subtype", 1, 120, required: false),
                ActivityTimestamp(row, "event_occurred_at", required: true)!.Value,
                ActivityText(row, "actor_name", 1, 160, required: false),
                ActivityText(row, "actor_id", 1, 160, required: false),
                ActivityText(row, "rule_name", 1, 120, required: true)!));
        }
        return new VNextActivityPage(rows.AsReadOnly(), rows.Count == limit, DateTimeOffset.UtcNow);
    }

    private static void NormalizeActivityOutcome(
        string status,
        DateTimeOffset? nextAttemptAt,
        DateTimeOffset? leaseExpiresAt,
        ref string? disposition,
        ref string? errorCode)
    {
        if (status is "pending" or "running" or "retry_scheduled")
        {
            disposition = "retrying";
            if (status == "running" && leaseExpiresAt.HasValue && leaseExpiresAt.Value <= DateTimeOffset.UtcNow)
                errorCode = "expired_execution_lease";
            else if (status == "retry_scheduled" && nextAttemptAt.HasValue && nextAttemptAt.Value <= DateTimeOffset.UtcNow)
                errorCode = "overdue_retry";
            return;
        }
        if (status == "succeeded")
        {
            disposition = null;
            errorCode = null;
            return;
        }
        if (status == "cancelled")
        {
            disposition = "blocked";
            errorCode ??= "execution_cancelled";
            return;
        }
        if (status == "failed" && disposition is null)
        {
            disposition = "needs_review";
            errorCode ??= "unclassified_failure";
        }
    }

    public async Task<IReadOnlyList<VNextReadinessRequirement>> LoadBroadcastReadinessRequirementsAsync(
        CancellationToken cancellationToken = default)
    {
        var token = await GetValidAccessTokenAsync(cancellationToken);
        var query =
            "/rest/v1/rules?workspace_id=eq." + Uri.EscapeDataString(WorkspaceId) +
            "&enabled=eq.true&superseded_at=is.null" +
            "&select=" + Uri.EscapeDataString("id,rule_actions(action_type,execution_target,agent_device_id,overlay_asset_id)") +
            "&order=created_at.desc&limit=101";
        var result = await SendAutomationRequestAsync(
            HttpMethod.Get,
            query,
            null,
            token,
            "방송 준비 규칙 범위",
            cancellationToken);
        if (result.ValueKind != JsonValueKind.Array || result.GetArrayLength() > 100)
            throw new VNextDevelopmentException(
                "활성 규칙이 100개를 넘어 방송 준비 범위를 안전하게 확정할 수 없습니다.",
                code: "readiness_rule_scope_saturated");

        var requirements = new List<VNextReadinessRequirement>();
        foreach (var rule in result.EnumerateArray())
        {
            if (rule.ValueKind != JsonValueKind.Object) throw InvalidActivityReadinessResponse();
            var ruleId = ActivityGuid(rule, "id");
            if (!rule.TryGetProperty("rule_actions", out var actions) || actions.ValueKind != JsonValueKind.Array)
                throw InvalidActivityReadinessResponse();
            foreach (var action in actions.EnumerateArray())
            {
                if (action.ValueKind != JsonValueKind.Object) throw InvalidActivityReadinessResponse();
                var actionType = ActivityText(action, "action_type", 1, 120, required: true)!;
                var target = ActivityText(action, "execution_target", 1, 120, required: true)!;
                if (!ActivitySymbolPattern.IsMatch(actionType) || !ActivitySymbolPattern.IsMatch(target))
                    throw InvalidActivityReadinessResponse();
                requirements.Add(new VNextReadinessRequirement(
                    ruleId,
                    actionType,
                    target,
                    ActivityOptionalGuid(action, "agent_device_id"),
                    ActivityOptionalGuid(action, "overlay_asset_id")));
            }
        }
        return requirements.AsReadOnly();
    }

    public async Task<IReadOnlyList<VNextApprovedAssetReference>> LoadApprovedAssetReferencesAsync(
        CancellationToken cancellationToken = default)
    {
        var token = await GetValidAccessTokenAsync(cancellationToken);
        var query =
            "/rest/v1/overlay_assets?retired_at=is.null" +
            "&select=" + Uri.EscapeDataString("id,content_sha256") +
            "&order=id.asc&limit=101";
        var result = await SendAutomationRequestAsync(
            HttpMethod.Get,
            query,
            null,
            token,
            "오버레이 이미지 정확 버전",
            cancellationToken);
        if (result.ValueKind != JsonValueKind.Array || result.GetArrayLength() > 100)
            throw new VNextDevelopmentException(
                "오버레이 이미지 범위를 안전하게 확정할 수 없습니다.",
                code: "approved_asset_scope_saturated");
        var rows = new List<VNextApprovedAssetReference>();
        foreach (var row in result.EnumerateArray())
        {
            if (row.ValueKind != JsonValueKind.Object) throw InvalidActivityReadinessResponse();
            var id = ActivityGuid(row, "id");
            var sha = ActivityText(row, "content_sha256", 64, 64, required: true)!;
            if (!Sha256Pattern.IsMatch(sha)) throw InvalidActivityReadinessResponse();
            rows.Add(new VNextApprovedAssetReference(id, sha));
        }
        return rows.AsReadOnly();
    }

    private static VNextDevelopmentException InvalidActivityResponse() =>
        new("자동화 활동 응답 형식이 올바르지 않습니다.", code: "invalid_activity_response");

    private static VNextDevelopmentException InvalidActivityReadinessResponse() =>
        new("방송 준비 규칙 응답 형식이 올바르지 않습니다.", code: "invalid_readiness_response");

    private static string ActivityGuid(JsonElement row, string property)
    {
        var text = ActivityText(row, property, 36, 36, required: true);
        if (!Guid.TryParseExact(text, "D", out var parsed)) throw InvalidActivityResponse();
        return parsed.ToString("D");
    }

    private static string? ActivityOptionalGuid(JsonElement row, string property)
    {
        var text = ActivityText(row, property, 36, 36, required: false);
        if (text is null) return null;
        if (!Guid.TryParseExact(text, "D", out var parsed)) throw InvalidActivityReadinessResponse();
        return parsed.ToString("D");
    }

    private static string? ActivityText(
        JsonElement row,
        string property,
        int minimum,
        int maximum,
        bool required)
    {
        if (!row.TryGetProperty(property, out var value) || value.ValueKind == JsonValueKind.Null)
        {
            if (required) throw InvalidActivityResponse();
            return null;
        }
        if (value.ValueKind != JsonValueKind.String) throw InvalidActivityResponse();
        var text = value.GetString() ?? "";
        if (text.Length < minimum || text.Length > maximum || text.Any(char.IsControl))
            throw InvalidActivityResponse();
        return text;
    }

    private static int ActivityInt(JsonElement row, string property, int minimum, int maximum)
    {
        if (!row.TryGetProperty(property, out var value)
            || !value.TryGetInt32(out var parsed)
            || parsed < minimum
            || parsed > maximum)
            throw InvalidActivityResponse();
        return parsed;
    }

    private static DateTimeOffset? ActivityTimestamp(JsonElement row, string property, bool required)
    {
        if (!row.TryGetProperty(property, out var value) || value.ValueKind == JsonValueKind.Null)
        {
            if (required) throw InvalidActivityResponse();
            return null;
        }
        if (value.ValueKind != JsonValueKind.String
            || !DateTimeOffset.TryParse(value.GetString(), out var parsed))
            throw InvalidActivityResponse();
        return parsed.ToUniversalTime();
    }
}
