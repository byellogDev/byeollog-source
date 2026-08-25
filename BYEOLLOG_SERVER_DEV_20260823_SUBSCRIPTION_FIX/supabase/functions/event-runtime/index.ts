import { matchingRules, type RuntimeAction, type RuntimeCondition, type RuntimeRule } from "../_shared/rule-evaluator.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { processExecutionQueue } from "../_shared/execution-worker.ts";
import {
  assertAutomationRuntimeReleaseActive,
  createServerRuntime,
  readOffslRuntimePreflight,
  runtimeRpcContext,
  RuntimeReleaseUnavailableError,
  ServiceRestError
} from "../_shared/server-runtime.ts";

type JsonObject = Record<string, unknown>;

interface IncomingEvent {
  schemaVersion: "1.0";
  id: string;
  workspaceId: string;
  source: string;
  platform: string;
  type: string;
  subtype?: string;
  actor?: JsonObject;
  amount?: number;
  currency?: string;
  payload: JsonObject;
  occurredAt: string;
  receivedAt?: string;
  correlationId?: string;
  raw?: unknown;
}

interface RuleRow {
  id: string;
  workspace_id: string;
  name: string;
  enabled: boolean;
  priority: number;
  match_mode: "all" | "any";
}
interface ConditionRow extends RuntimeCondition { rule_id: string }
interface ActionRow extends RuntimeAction {
  rule_id: string;
  execution_target: "server" | "local_agent";
  agent_device_id: string | null;
}
interface LoadedPlan {
  planToken: string;
  rules: RuleRow[];
  conditions: ConditionRow[];
  actions: ActionRow[];
}
interface CommittedPlan {
  eventId: string;
  duplicate: boolean;
  matchedRuleIds: string[];
  queuedExecutionIds: string[];
}

interface RuntimeDecision {
  eventId: string;
  actionTypes: string[];
  ruleIds: string[];
}

const MAX_BODY_BYTES = 512 * 1024;
const MAX_LIVE_ACTION_AGE_MS = 2 * 60 * 1000;
const RUNTIME_REVISION = "offsl-event-runtime-g3a-v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "content-type": "application/json; charset=utf-8",
      "x-byeollog-runtime-revision": RUNTIME_REVISION
    }
  });
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateEvent(value: unknown): IncomingEvent {
  if (!isObject(value)) throw new Error("Request body must be a JSON object");
  const event = value as unknown as IncomingEvent;
  if (event.schemaVersion !== "1.0") throw new Error("schemaVersion must be 1.0");
  if (typeof event.id !== "string" || event.id.length < 1 || event.id.length > 200) throw new Error("id is invalid");
  if (typeof event.workspaceId !== "string" || !UUID_PATTERN.test(event.workspaceId)) throw new Error("workspaceId must be a UUID");
  for (const key of ["source", "platform", "type"] as const) {
    if (typeof event[key] !== "string" || event[key].length < 1 || event[key].length > 64) throw new Error(`${key} is invalid`);
  }
  if (!isObject(event.payload)) throw new Error("payload must be a JSON object");
  if (event.actor !== undefined && !isObject(event.actor)) throw new Error("actor must be a JSON object");
  if (event.amount !== undefined && (!Number.isFinite(event.amount) || event.amount < 0)) throw new Error("amount is invalid");
  if (event.currency !== undefined && !/^[A-Z]{3}$/.test(event.currency)) throw new Error("currency is invalid");
  if (typeof event.occurredAt !== "string" || !Number.isFinite(Date.parse(event.occurredAt))) throw new Error("occurredAt is invalid");
  if (event.receivedAt !== undefined && !Number.isFinite(Date.parse(event.receivedAt))) throw new Error("receivedAt is invalid");
  return event;
}

function isLedgerOnlyReplay(event: IncomingEvent, nowMs = Date.now()): boolean {
  const occurredAtMs = Date.parse(event.occurredAt);
  return Number.isFinite(occurredAtMs) && nowMs - occurredAtMs > MAX_LIVE_ACTION_AGE_MS;
}

function isRaffleLedgerRule(rule: RuntimeRule): boolean {
  if (rule.actions.length !== 1) return false;
  const action = rule.actions[0] as ActionRow;
  return action.execution_target === "server"
    && action.action_type === "log"
    && action.params?.controlType === "raffle_ticket_grant";
}

function lateSuppressionDecision(
  event: IncomingEvent,
  allMatched: RuntimeRule[],
  admitted: RuntimeRule[],
  eventId: string
): RuntimeDecision | null {
  const admittedIds = new Set(admitted.map((rule) => rule.id));
  const suppressed = allMatched.filter((rule) => !admittedIds.has(rule.id));
  const actionTypes = [...new Set(suppressed.flatMap((rule) => rule.actions.map((action) => action.action_type)))].sort();
  const ruleIds = [...new Set(suppressed.map((rule) => rule.id))].sort();
  return actionTypes.length > 0 && ruleIds.length > 0
    ? { eventId, actionTypes, ruleIds }
    : null;
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method === "GET") {
    try {
      const preflight = readOffslRuntimePreflight();
      return json({ healthy: true, projectRef: preflight.projectRef, revision: RUNTIME_REVISION });
    } catch {
      return json({ error: "runtime_preflight_failed" }, 503);
    }
  }
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);

  try {
    const runtime = await createServerRuntime(request, "event_runtime", RUNTIME_REVISION);
    if (!runtime) return json({ error: "unauthorized" }, 401);
    const { rest } = runtime;

    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);
    const event = validateEvent(JSON.parse(rawBody));

    await assertAutomationRuntimeReleaseActive(
      runtime,
      event.workspaceId,
      "event_runtime",
      RUNTIME_REVISION
    );

    // 늦게 복구된 후원은 원장성 추첨권만 적립한다. 현재 방송의 마이크,
    // 화면 또는 음성을 뒤늦게 바꾸는 local action은 절대 재생하지 않는다.
    const ledgerOnlyReplay = isLedgerOnlyReplay(event);
    const eventInsert = {
      workspace_id: event.workspaceId,
      schema_version: event.schemaVersion,
      external_event_id: event.id,
      source: event.source,
      platform: event.platform,
      event_type: event.type,
      subtype: event.subtype ?? null,
      actor: event.actor ?? null,
      amount: event.amount ?? null,
      currency: event.currency ?? null,
      payload: event.payload,
      raw: event.raw ?? null,
      correlation_id: event.correlationId ?? null,
      occurred_at: event.occurredAt,
      received_at: event.receivedAt ?? new Date().toISOString()
    };

    const rpcContext = runtimeRpcContext(runtime, "event_runtime", RUNTIME_REVISION);
    const plan = await rest<LoadedPlan>("rpc/g3a_load_automation_plan_v1", {
      method: "POST",
      body: JSON.stringify({
        p_workspace_id: event.workspaceId,
        ...rpcContext
      })
    });
    if (!/^[0-9a-f]{64}$/.test(plan.planToken)
      || !Array.isArray(plan.rules)
      || !Array.isArray(plan.conditions)
      || !Array.isArray(plan.actions)) {
      throw new Error("Automation plan response is invalid");
    }
    const ruleRows = plan.rules;
    const conditionRows = plan.conditions;
    const actionRows = plan.actions;
    if (actionRows.some((action) =>
      (action.execution_target === "server" && action.action_type !== "log")
      || (action.execution_target === "local_agent"
        && !["obs.mute_for", "obs.voice_anonymize_for", "windows.mic_mute_for", "obs.scene_switch", "agent.notify", "flashbang.overlay"].includes(action.action_type))
      || (action.execution_target !== "server" && action.execution_target !== "local_agent")
    )) {
      throw new Error("Automation plan contains an unsupported G3A action");
    }
    const rules: RuntimeRule[] = ruleRows.map((rule) => ({
      ...rule,
      conditions: conditionRows.filter((condition) => condition.rule_id === rule.id),
      actions: actionRows.filter((action) => action.rule_id === rule.id)
    }));
    const allMatched = matchingRules(event, rules);
    const matched = ledgerOnlyReplay ? allMatched.filter(isRaffleLedgerRule) : allMatched;

    // The database rechecks the exact evaluated rule universe/action set and
    // commits event identity, matches and execution snapshots atomically.
    // A duplicate resolves only a previously complete plan; it never evaluates
    // the retry body against a newer rule set.
    const committed = await rest<CommittedPlan>("rpc/g3a_commit_event_plan_v1", {
      method: "POST",
      body: JSON.stringify({
        p_workspace_id: event.workspaceId,
        p_event: eventInsert,
        ...rpcContext,
        p_plan_token: plan.planToken,
        p_evaluated_rule_ids: rules.map((rule) => rule.id),
        p_matched_rule_ids: matched.map((rule) => rule.id),
        p_rule_action_ids: matched.flatMap((rule) => rule.actions.map((action) => action.id))
      })
    });

    // The two-minute live-action gate remains unchanged.  When it excludes a
    // side effect, persist the *decision* after the event commit so operators
    // can audit why an otherwise valid historical event did not run an action.
    // The decision RPC is idempotent, so a retry after an Edge timeout cannot
    // create a second record or revive the suppressed action.
    if (ledgerOnlyReplay) {
      const decision = lateSuppressionDecision(event, allMatched, matched, committed.eventId);
      if (decision) {
        await rest<string>("rpc/g3a_record_event_decision_v1", {
          method: "POST",
          body: JSON.stringify({
            p_workspace_id: event.workspaceId,
            p_event_id: decision.eventId,
            p_decision_type: "late_event_suppressed",
            p_decision_reason: "event_age_exceeds_live_action_window",
            p_occurred_at: event.occurredAt,
            p_received_at: event.receivedAt ?? new Date().toISOString(),
            p_suppressed_action_types: decision.actionTypes,
            p_suppressed_rule_ids: decision.ruleIds,
            ...rpcContext
          })
        });
      }
    }

    const workerId = `event-runtime:${crypto.randomUUID()}`;
    const primaryProcessed = committed.queuedExecutionIds.length === 0 ? [] : await processExecutionQueue(rest, event.workspaceId, {
      workerId,
      maxJobs: Math.min(committed.queuedExecutionIds.length, 20),
      maxRunTimeMs: 30000,
      rpcContext,
      executionIds: committed.queuedExecutionIds
    });
    // A bounded traffic-assisted drain recovers jobs that were committed before
    // a previous runtime crashed. The future local Agent remains the autonomous
    // consumer when no event traffic exists.
    const recoveryBudget = Math.min(5, Math.max(0, 20 - primaryProcessed.length));
    const recovered = recoveryBudget === 0 ? [] : await processExecutionQueue(rest, event.workspaceId, {
      workerId,
      maxJobs: recoveryBudget,
      maxRunTimeMs: 25000,
      rpcContext
    });
    const processed = [...primaryProcessed, ...recovered];
    // Do not read raw execution rows with the service key after commit: a
    // membership can be removed between those transactions.  Only report the
    // outcomes completed inside this already-authorized request.
    const completed = processed
      .filter((execution) => execution.status === "succeeded")
      .map((execution) => ({ executionId: execution.executionId, status: execution.status }));

    return json({
      eventId: committed.eventId,
      duplicate: committed.duplicate,
      matchedRuleIds: committed.matchedRuleIds,
      queuedExecutionIds: committed.queuedExecutionIds,
      completed,
      recoveredExecutionIds: recovered.map((execution) => execution.executionId),
      processed
    }, committed.duplicate ? 200 : 202);
  } catch (error) {
    if (error instanceof RuntimeReleaseUnavailableError) {
      return json({ error: "runtime_release_inactive" }, 503);
    }
    if (error instanceof ServiceRestError && error.code === "BLP01") {
      return json({ error: "event_idempotency_conflict" }, 409);
    }
    if (error instanceof ServiceRestError && error.code === "BLP02") {
      return json({ error: "automation_plan_changed_retry" }, 409);
    }
    if (error instanceof ServiceRestError && (error.code === "BLR02" || error.code === "BLR03")) {
      return json({ error: "runtime_release_inactive" }, 503);
    }
    if (error instanceof SyntaxError) return json({ error: "invalid_json" }, 400);
    const message = error instanceof Error ? error.message : String(error);
    if (/invalid|required|must be/i.test(message)) return json({ error: "invalid_event", message }, 400);
    console.error("event_runtime_failed", { message });
    return json({ error: "internal_error" }, 500);
  }
});
