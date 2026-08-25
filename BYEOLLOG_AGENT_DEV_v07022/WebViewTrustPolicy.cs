using System.Text.Json;

namespace HurogiCollector;

/// <summary>
/// Pure, testable trust policy for every embedded WebView2 surface.
/// Keep secrets out of logs: callers must log SafeOriginForLog(raw), never raw URLs.
/// </summary>
internal static class WebViewTrustPolicy
{
    internal const string UiHost = "byeollog.local";
    internal const string AutomationHost = "byeollog-agent.local";
    internal const string AutomationPath = "/agent_automation.html";
    internal const int MaxUiMessageChars = 64 * 1024;
    internal const int MaxWeflabMessageChars = 4 * 1024 * 1024;

    private static readonly HashSet<string> AllowedUiActions = new(StringComparer.Ordinal)
    {
        "windowDrag",
        "minimize",
        "close",
        "exit",
        "theme",
        "startTimeChanged",
        "toggleCollection",
        "openWeflab",
        "dashboard",
        "openAutomationSettings",
        "screen",
        "refreshCollection",
        "upsertRoulette",
        "deleteRoulette",
        "upsertFixed",
        "deleteFixed",
        "saveRules",
        "cancelRules"
    };

    private static readonly HashSet<string> AllowedAutomationActions = new(StringComparer.Ordinal)
    {
        "automationWindowDrag",
        "automationMinimize",
        "automationClose",
        "theme",
        "automationReady",
        "refreshAutomation",
        "refreshReadiness",
        "refreshActivity",
        "refreshRaffle",
        "refreshLocalConnections",
        "saveAutomationRule",
        "toggleAutomationRule",
        "deleteAutomationRule",
        "testAutomationRule",
        "previewRaffleTts",
        "previewFlashbang",
        "startRaffleDraw",
        "drawNextRaffleWinner",
        "reannounceRaffleWinner",
        "renameAgentDevice",
        "revokeAgentDevice",
        "syncOverlayAssets",
        "previewOverlayAsset",
        "copyOverlayUrl",
        "saveObsSettings",
        "testObsSettings",
        "testVoiceAnonymizerFilter",
        "previewVoiceAnonymizer",
        "saveWindowsMicSettings",
        "testWindowsMicSettings",
        "editAutomationRule",
        "cancelAutomationEdit",
        "closeAutomation"
    };

    private static readonly HashSet<string> AutomationActionsRequiringPayload = new(StringComparer.Ordinal)
    {
        "saveAutomationRule",
        "toggleAutomationRule",
        "deleteAutomationRule",
        "testAutomationRule",
        "previewRaffleTts",
        "previewFlashbang",
        "startRaffleDraw",
        "drawNextRaffleWinner",
        "reannounceRaffleWinner",
        "renameAgentDevice",
        "revokeAgentDevice",
        "previewOverlayAsset",
        "saveObsSettings",
        "testObsSettings",
        "testVoiceAnonymizerFilter",
        "saveWindowsMicSettings",
        "testWindowsMicSettings",
        "editAutomationRule",
        "theme"
    };

    private static readonly HashSet<string> AutomationActionsRequiringEmptyPayload = new(StringComparer.Ordinal)
    {
        "automationWindowDrag",
        "automationMinimize",
        "automationClose",
        "refreshReadiness",
        "refreshActivity",
        "refreshRaffle",
        "syncOverlayAssets",
        "copyOverlayUrl",
        "refreshLocalConnections",
        "previewVoiceAnonymizer"
    };

    private static readonly HashSet<string> UiActionsRequiringPayload = new(StringComparer.Ordinal)
    {
        "theme",
        "startTimeChanged",
        "toggleCollection",
        "screen",
        "upsertRoulette",
        "deleteRoulette",
        "upsertFixed",
        "deleteFixed"
    };

    private static readonly HashSet<string> AllowedWeflabKinds = new(StringComparer.Ordinal)
    {
        "probe",
        "probe_error",
        "status",
        "rows"
    };

    private static readonly JsonDocumentOptions StrictJson = new()
    {
        AllowTrailingCommas = false,
        CommentHandling = JsonCommentHandling.Disallow,
        MaxDepth = 48
    };

    internal static bool IsTrustedUiMessageSource(string? source)
    {
        return TryCreateHttpsUri(source, out var uri)
            && string.Equals(uri.Host, UiHost, StringComparison.OrdinalIgnoreCase);
    }

    internal static bool IsTrustedWeflabMessageSource(string? source)
    {
        return TryCreateHttpsUri(source, out var uri)
            && IsAllowedWeflabHost(uri.Host);
    }

    internal static bool IsTrustedAutomationMessageSource(string? source)
    {
        return TryCreateHttpsUri(source, out var uri)
            && string.Equals(uri.Host, AutomationHost, StringComparison.OrdinalIgnoreCase);
    }

    internal static bool IsAllowedAutomationNavigation(string? raw, out string reason)
    {
        if (!TryCreateHttpsUri(raw, out var uri, out reason)) return false;
        if (!string.Equals(uri.Host, AutomationHost, StringComparison.OrdinalIgnoreCase))
        {
            reason = "host";
            return false;
        }
        if (!string.Equals(uri.AbsolutePath, AutomationPath, StringComparison.Ordinal))
        {
            reason = "path";
            return false;
        }
        reason = "automation_ui";
        return true;
    }

    internal static bool IsAllowedUiNavigation(string? raw, out string reason)
    {
        if (IsBlankNavigation(raw))
        {
            reason = "blank";
            return true;
        }

        if (!TryCreateHttpsUri(raw, out var uri, out reason)) return false;
        if (!string.Equals(uri.Host, UiHost, StringComparison.OrdinalIgnoreCase))
        {
            reason = "host";
            return false;
        }

        reason = "ui";
        return true;
    }

    internal static bool IsAllowedWeflabNavigation(string? raw, out string reason)
    {
        if (IsBlankNavigation(raw))
        {
            reason = "blank";
            return true;
        }

        if (!TryCreateHttpsUri(raw, out var uri, out reason)) return false;
        if (!IsAllowedNavigationHost(uri.Host))
        {
            reason = "host";
            return false;
        }

        reason = "allowlisted_host";
        return true;
    }

    internal static bool TryParseUiMessage(
        string? raw,
        out JsonElement root,
        out string action,
        out string reason)
    {
        root = default;
        action = "";
        if (!TryParseObject(raw, MaxUiMessageChars, unwrapJsonString: false, out root, out reason))
            return false;

        if (!root.TryGetProperty("action", out var actionElement) ||
            actionElement.ValueKind != JsonValueKind.String ||
            string.IsNullOrWhiteSpace(actionElement.GetString()))
        {
            reason = "action_missing";
            return false;
        }

        action = actionElement.GetString()!;
        if (!AllowedUiActions.Contains(action))
        {
            reason = "action_blocked";
            return false;
        }

        var hasPayload = root.TryGetProperty("payload", out var payload);
        if (hasPayload && payload.ValueKind is not (JsonValueKind.Object or JsonValueKind.Null))
        {
            reason = "payload_shape";
            return false;
        }

        if (UiActionsRequiringPayload.Contains(action) &&
            (!hasPayload || payload.ValueKind != JsonValueKind.Object))
        {
            reason = "payload_required";
            return false;
        }

        reason = "ok";
        return true;
    }

    internal static bool TryParseWeflabMessage(
        string? raw,
        out JsonElement root,
        out string kind,
        out string reason)
    {
        root = default;
        kind = "";
        if (!TryParseObject(raw, MaxWeflabMessageChars, unwrapJsonString: true, out root, out reason))
            return false;

        if (!root.TryGetProperty("kind", out var kindElement) ||
            kindElement.ValueKind != JsonValueKind.String ||
            string.IsNullOrWhiteSpace(kindElement.GetString()))
        {
            reason = "kind_missing";
            return false;
        }

        kind = kindElement.GetString()!;
        if (!AllowedWeflabKinds.Contains(kind))
        {
            reason = "kind_blocked";
            return false;
        }

        switch (kind)
        {
            case "probe":
                if (!HasBoolean(root, "logged") ||
                    !HasString(root, "idx") ||
                    !HasBoolean(root, "hasLoginData") ||
                    !HasBoolean(root, "hasJquery") ||
                    !HasString(root, "href"))
                {
                    reason = "probe_shape";
                    return false;
                }
                break;

            case "probe_error":
                if (root.TryGetProperty("text", out var errorText) &&
                    errorText.ValueKind != JsonValueKind.String)
                {
                    reason = "probe_error_shape";
                    return false;
                }
                break;

            case "status":
                if (!HasString(root, "state") || !HasString(root, "text"))
                {
                    reason = "status_shape";
                    return false;
                }
                break;

            case "rows":
                if (!root.TryGetProperty("payload", out var payload) ||
                    payload.ValueKind is not (JsonValueKind.Object or JsonValueKind.Array))
                {
                    reason = "rows_shape";
                    return false;
                }
                break;
        }

        reason = "ok";
        return true;
    }

    internal static bool TryParseAutomationMessage(
        string? raw,
        out JsonElement root,
        out string action,
        out string reason)
    {
        root = default;
        action = "";
        if (!TryParseObject(raw, MaxUiMessageChars, unwrapJsonString: false, out root, out reason))
            return false;
        if (!root.TryGetProperty("action", out var actionElement)
            || actionElement.ValueKind != JsonValueKind.String
            || string.IsNullOrWhiteSpace(actionElement.GetString()))
        {
            reason = "action_missing";
            return false;
        }
        action = actionElement.GetString()!;
        if (!AllowedAutomationActions.Contains(action))
        {
            reason = "action_blocked";
            return false;
        }
        var hasPayload = root.TryGetProperty("payload", out var payload);
        if (hasPayload && payload.ValueKind is not (JsonValueKind.Object or JsonValueKind.Null))
        {
            reason = "payload_shape";
            return false;
        }
        if (AutomationActionsRequiringPayload.Contains(action)
            && (!hasPayload || payload.ValueKind != JsonValueKind.Object))
        {
            reason = "payload_required";
            return false;
        }
        if (AutomationActionsRequiringEmptyPayload.Contains(action)
            && (!hasPayload
                || payload.ValueKind != JsonValueKind.Object
                || payload.EnumerateObject().Any()))
        {
            reason = "payload_shape";
            return false;
        }
        reason = "ok";
        return true;
    }

    internal static string SafeOriginForLog(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return "[empty]";
        if (string.Equals(raw, "about:blank", StringComparison.OrdinalIgnoreCase)) return "about:blank";
        if (!Uri.TryCreate(raw, UriKind.Absolute, out var uri)) return "[invalid]";

        var scheme = uri.Scheme.ToLowerInvariant();
        if (!string.Equals(scheme, Uri.UriSchemeHttps, StringComparison.Ordinal) &&
            !string.Equals(scheme, Uri.UriSchemeHttp, StringComparison.Ordinal))
            return scheme.Length == 0 ? "[invalid]" : scheme + ":[redacted]";

        var host = uri.IdnHost.ToLowerInvariant();
        if (host.Contains(':')) host = "[" + host + "]";
        var port = uri.IsDefaultPort ? "" : ":" + uri.Port;
        return $"{scheme}://{host}{port}";
    }

    internal static bool TryResolveSameOriginExternalUri(
        string? baseRaw,
        string? targetRaw,
        out Uri uri,
        out string reason)
    {
        uri = null!;
        if (!Uri.TryCreate(baseRaw, UriKind.Absolute, out var baseUri) || baseUri is null)
        {
            reason = "base_uri";
            return false;
        }
        if (!IsAllowedExternalHttpUri(baseUri))
        {
            reason = "base_origin";
            return false;
        }
        if (!Uri.TryCreate(baseUri, targetRaw, out var candidate) || candidate is null)
        {
            reason = "target_uri";
            return false;
        }
        if (!IsAllowedExternalHttpUri(candidate))
        {
            reason = "target_origin";
            return false;
        }
        if (!string.Equals(baseUri.Scheme, candidate.Scheme, StringComparison.OrdinalIgnoreCase)
            || !string.Equals(baseUri.IdnHost, candidate.IdnHost, StringComparison.OrdinalIgnoreCase)
            || baseUri.Port != candidate.Port)
        {
            reason = "cross_origin";
            return false;
        }

        uri = candidate;
        reason = "same_origin";
        return true;
    }

    internal static bool IsAllowedNavigationHost(string? host)
    {
        if (string.IsNullOrWhiteSpace(host)) return false;
        host = host.Trim().ToLowerInvariant();

        static bool Match(string candidate, string root) =>
            candidate == root || candidate.EndsWith("." + root, StringComparison.Ordinal);

        return Match(host, "weflab.com") ||
            Match(host, "sooplive.com") ||
            Match(host, "sooplive.co.kr") ||
            Match(host, "afreecatv.com") ||
            Match(host, "afreeca.com") ||
            Match(host, "naver.com") ||
            Match(host, "navercorp.com") ||
            Match(host, "google.com") ||
            Match(host, "google.co.kr") ||
            Match(host, "googleapis.com") ||
            Match(host, "gstatic.com") ||
            Match(host, "youtube.com") ||
            Match(host, "ytimg.com") ||
            Match(host, "gmail.com") ||
            Match(host, "twitch.tv") ||
            Match(host, "twitch.com") ||
            Match(host, "ttvnw.net") ||
            Match(host, "kakao.com") ||
            Match(host, "kakao.co.kr") ||
            Match(host, "kakaocdn.net");
    }

    internal static bool IsAllowedWeflabHost(string? host)
    {
        if (string.IsNullOrWhiteSpace(host)) return false;
        host = host.Trim().ToLowerInvariant();
        return host == "weflab.com" || host.EndsWith(".weflab.com", StringComparison.Ordinal);
    }

    private static bool TryParseObject(
        string? raw,
        int maxChars,
        bool unwrapJsonString,
        out JsonElement root,
        out string reason)
    {
        root = default;
        if (string.IsNullOrWhiteSpace(raw))
        {
            reason = "empty";
            return false;
        }

        if (raw.Length > maxChars)
        {
            reason = "too_large";
            return false;
        }

        try
        {
            using var outer = JsonDocument.Parse(raw, StrictJson);
            if (unwrapJsonString && outer.RootElement.ValueKind == JsonValueKind.String)
            {
                var inner = outer.RootElement.GetString();
                if (string.IsNullOrWhiteSpace(inner))
                {
                    reason = "inner_empty";
                    return false;
                }

                if (inner.Length > maxChars)
                {
                    reason = "too_large";
                    return false;
                }

                using var innerDocument = JsonDocument.Parse(inner, StrictJson);
                if (innerDocument.RootElement.ValueKind != JsonValueKind.Object)
                {
                    reason = "object_required";
                    return false;
                }
                root = innerDocument.RootElement.Clone();
            }
            else
            {
                if (outer.RootElement.ValueKind != JsonValueKind.Object)
                {
                    reason = "object_required";
                    return false;
                }
                root = outer.RootElement.Clone();
            }

            reason = "ok";
            return true;
        }
        catch (JsonException)
        {
            reason = "invalid_json";
            return false;
        }
    }

    private static bool TryCreateHttpsUri(string? raw, out Uri uri)
    {
        return TryCreateHttpsUri(raw, out uri, out _);
    }

    private static bool TryCreateHttpsUri(string? raw, out Uri uri, out string reason)
    {
        uri = null!;
        if (!Uri.TryCreate(raw, UriKind.Absolute, out var parsed) || parsed is null)
        {
            reason = "invalid_uri";
            return false;
        }

        uri = parsed;

        if (!string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
        {
            reason = "scheme";
            return false;
        }

        if (!string.IsNullOrEmpty(uri.UserInfo))
        {
            reason = "userinfo";
            return false;
        }

        if (!uri.IsDefaultPort)
        {
            reason = "port";
            return false;
        }

        reason = "https";
        return true;
    }

    private static bool IsBlankNavigation(string? raw)
    {
        return string.IsNullOrWhiteSpace(raw) ||
            string.Equals(raw, "about:blank", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsAllowedExternalHttpUri(Uri uri)
    {
        if (!string.IsNullOrEmpty(uri.UserInfo)) return false;
        if (string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
            return uri.IsDefaultPort;
        return string.Equals(uri.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase)
            && uri.IsLoopback;
    }

    private static bool HasBoolean(JsonElement root, string property)
    {
        return root.TryGetProperty(property, out var value) &&
            value.ValueKind is JsonValueKind.True or JsonValueKind.False;
    }

    private static bool HasString(JsonElement root, string property)
    {
        return root.TryGetProperty(property, out var value) &&
            value.ValueKind == JsonValueKind.String;
    }
}
