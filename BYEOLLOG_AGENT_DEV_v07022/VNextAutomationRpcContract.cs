using System.Text.Json;
using System.Text.Json.Serialization;

namespace HurogiCollector;

/// <summary>
/// PostgREST의 guided-rule RPC는 nullable 값도 선택 인자가 아닙니다.
/// 모든 named argument를 항상 JSON에 남겨 함수 시그니처가 정확히 해석되게 합니다.
/// </summary>
internal static class VNextAutomationRpcSerializer
{
    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never
    };

    internal static string Serialize(object value) => JsonSerializer.Serialize(value, Options);
}

internal sealed record VNextAutomationRuleRpc(
    [property: JsonPropertyName("p_workspace_id")] string p_workspace_id,
    [property: JsonPropertyName("p_name")] string p_name,
    [property: JsonPropertyName("p_enabled")] bool p_enabled,
    [property: JsonPropertyName("p_priority")] int p_priority,
    [property: JsonPropertyName("p_source")] string p_source,
    [property: JsonPropertyName("p_event_type")] string p_event_type,
    [property: JsonPropertyName("p_subtype")] string? p_subtype,
    [property: JsonPropertyName("p_result")] string? p_result,
    [property: JsonPropertyName("p_min_amount")] long? p_min_amount,
    [property: JsonPropertyName("p_action_type")] string p_action_type,
    [property: JsonPropertyName("p_event_name")] string? p_event_name,
    [property: JsonPropertyName("p_output_types")] string[]? p_output_types,
    [property: JsonPropertyName("p_quantity")] int? p_quantity,
    [property: JsonPropertyName("p_duration_seconds")] int? p_duration_seconds,
    [property: JsonPropertyName("p_agent_device_id")] string? p_agent_device_id,
    [property: JsonPropertyName("p_overlay_image_key")] string? p_overlay_image_key,
    [property: JsonPropertyName("p_overlay_position_x")] int? p_overlay_position_x,
    [property: JsonPropertyName("p_overlay_position_y")] int? p_overlay_position_y,
    [property: JsonPropertyName("p_overlay_scale_percent")] int? p_overlay_scale_percent,
    [property: JsonPropertyName("p_reward_multiplier")] int? p_reward_multiplier,
    [property: JsonPropertyName("p_allow_multiplier_stacking")] bool? p_allow_multiplier_stacking,
    [property: JsonPropertyName("p_raffle_ticket_unit")] int? p_raffle_ticket_unit,
    [property: JsonPropertyName("p_raffle_allow_multiples")] bool? p_raffle_allow_multiples,
    [property: JsonPropertyName("p_raffle_ticket_position_x")] int? p_raffle_ticket_position_x,
    [property: JsonPropertyName("p_raffle_ticket_position_y")] int? p_raffle_ticket_position_y,
    [property: JsonPropertyName("p_raffle_ticket_scale_percent")] int? p_raffle_ticket_scale_percent,
    [property: JsonPropertyName("p_raffle_ticket_volume_percent")] int? p_raffle_ticket_volume_percent,
    [property: JsonPropertyName("p_raffle_draw_position_x")] int? p_raffle_draw_position_x,
    [property: JsonPropertyName("p_raffle_draw_position_y")] int? p_raffle_draw_position_y,
    [property: JsonPropertyName("p_raffle_draw_scale_percent")] int? p_raffle_draw_scale_percent,
    [property: JsonPropertyName("p_raffle_draw_volume_percent")] int? p_raffle_draw_volume_percent,
    [property: JsonPropertyName("p_flashbang_intensity")] string? p_flashbang_intensity,
    [property: JsonPropertyName("p_flashbang_volume_percent")] int? p_flashbang_volume_percent,
    [property: JsonPropertyName("p_replace_rule_id")] string? p_replace_rule_id,
    [property: JsonPropertyName("p_expected_version")] int? p_expected_version);
