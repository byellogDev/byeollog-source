import { corsHeaders } from "../_shared/cors.ts";
import {
  assertAutomationRuntimeReleaseActive,
  createServerRuntime,
  runtimeRpcContext,
  RuntimeReleaseUnavailableError,
  ServiceRestError
} from "../_shared/server-runtime.ts";

type JsonObject = Record<string, unknown>;

const MAX_BODY_BYTES = 64 * 1024;
const RUNTIME_REVISION = "offsl-native-roulette-runtime-v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "x-byeollog-runtime-revision": RUNTIME_REVISION
    }
  });
}

function enabled(): boolean {
  return Deno.env.get("NATIVE_ROULETTE_ENABLED") === "true"
    && Deno.env.get("SOOP_CHAT_SDK_ENABLED") === "true";
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return text.length >= 1 && text.length <= max ? text : null;
}

function isoInstant(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeRelay(body: JsonObject): JsonObject | null {
  const relay = body.relay;
  if (!isObject(relay) || relay.schemaVersion !== 1 || relay.provider !== "soop") return null;
  const eventType = relay.eventType;
  if (eventType !== "donation" && eventType !== "chat") return null;
  const event = relay.event;
  const connection = relay.connection;
  if (!isObject(event) || !isObject(connection)) return null;
  const eventId = boundedText(event.eventId, 200);
  const actor = event.actor;
  const occurredAt = isoInstant(event.occurredAt);
  const receivedAt = isoInstant(relay.receivedAt);
  const connectionId = boundedText(connection.id, 160);
  const sequence = connection.sequence;
  const reconnectCount = connection.reconnectCount ?? 0;
  if (!eventId || !isObject(actor) || !occurredAt || !receivedAt || !connectionId
    || typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0
    || typeof reconnectCount !== "number" || !Number.isSafeInteger(reconnectCount) || reconnectCount < 0
    || typeof relay.rawPayloadSha256 !== "string" || !SHA256_PATTERN.test(relay.rawPayloadSha256)) {
    return null;
  }
  const actorId = boundedText(actor.id, 180)?.toLowerCase() ?? null;
  const actorName = boundedText(actor.name, 120) ?? actorId;
  if (!actorId || !actorName) return null;
  if (eventType === "donation") {
    const amount = event.amount;
    const message = event.message === null || event.message === undefined || event.message === ""
      ? null
      : boundedText(event.message, 1000);
    if (typeof amount !== "number" || !Number.isSafeInteger(amount)
      || amount < 1 || amount > 1_000_000_000_000
      || (event.message !== null && event.message !== undefined && event.message !== "" && !message)) {
      return null;
    }
    return {eventType,eventId,actorId,actorName,amount,message,occurredAt,receivedAt,connectionId,sequence,reconnectCount,rawPayloadSha256:relay.rawPayloadSha256};
  }
  const message = boundedText(event.message, 300);
  if (!message) return null;
  return {eventType,eventId,actorId,actorName,message,occurredAt,receivedAt,connectionId,sequence,reconnectCount,rawPayloadSha256:relay.rawPayloadSha256};
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!enabled()) return json({ error: "not_found" }, 404);
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);

  try {
    const runtime = await createServerRuntime(request, "native_roulette_runtime", RUNTIME_REVISION);
    if (!runtime) return json({ error: "unauthorized" }, 401);
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      return json({ error: "payload_too_large" }, 413);
    }
    const body = JSON.parse(rawBody) as unknown;
    if (!isObject(body)) return json({ error: "invalid_request" }, 400);
    if (body.operation !== "donation" && body.operation !== "chat") {
      return json({ error: "invalid_operation" }, 400);
    }
    if (typeof body.workspaceId !== "string" || !UUID_PATTERN.test(body.workspaceId)
      || typeof body.deviceId !== "string" || !UUID_PATTERN.test(body.deviceId)
      || typeof body.deviceSecret !== "string" || !DEVICE_SECRET_PATTERN.test(body.deviceSecret)) {
      return json({ error: "invalid_device_identity" }, 400);
    }
    const relay = normalizeRelay(body);
    if (!relay || relay.eventType !== body.operation) return json({ error: "invalid_soop_relay" }, 400);

    const workspaceId = body.workspaceId.toLowerCase();
    const deviceId = body.deviceId.toLowerCase();
    const deviceSecretHash = await sha256Hex(body.deviceSecret);
    const rpcContext = runtimeRpcContext(runtime, "native_roulette_runtime", RUNTIME_REVISION);
    await assertAutomationRuntimeReleaseActive(runtime,workspaceId,"native_roulette_runtime",RUNTIME_REVISION);
    const authenticatedAt = await runtime.rest<string>("rpc/g3a_authenticate_agent_device_v1", {
      method: "POST",
      body: JSON.stringify({
        p_workspace_id: workspaceId,
        p_device_id: deviceId,
        p_device_secret_hash: deviceSecretHash,
        ...rpcContext
      })
    });
    if (typeof authenticatedAt !== "string" || !Number.isFinite(Date.parse(authenticatedAt))) {
      throw new Error("Agent authentication result was invalid");
    }

    const result = relay.eventType === "donation"
      ? await runtime.rest<JsonObject>("rpc/ingest_native_roulette_soop_donation_v1", {
        method: "POST",
        body: JSON.stringify({
          p_workspace_id: workspaceId,
          p_event_id: relay.eventId,
          p_actor_id: relay.actorId,
          p_actor_name: relay.actorName,
          p_amount: relay.amount,
          p_message: relay.message,
          p_occurred_at: relay.occurredAt
        })
      })
      : await runtime.rest<JsonObject>("rpc/ingest_native_roulette_soop_chat_v1", {
        method: "POST",
        body: JSON.stringify({
          p_workspace_id: workspaceId,
          p_chat_event_id: relay.eventId,
          p_actor_id: relay.actorId,
          p_actor_name: relay.actorName,
          p_message: relay.message,
          p_occurred_at: relay.occurredAt
        })
      });
    const transportLatencyMs = Math.max(0,Date.parse(relay.receivedAt as string)-Date.parse(relay.occurredAt as string));
    console.info(JSON.stringify({
      level:"info",message:"native roulette SOOP event accepted",eventType:relay.eventType,
      workspaceId,deviceId,transportLatencyMs,sequence:relay.sequence,reconnectCount:relay.reconnectCount,
      rawPayloadSha256:relay.rawPayloadSha256
    }));
    return json({ok:true,result,receivedAt:relay.receivedAt,transportLatencyMs});
  } catch (error) {
    if (error instanceof RuntimeReleaseUnavailableError) return json({ error: "runtime_release_inactive" }, 503);
    if (error instanceof ServiceRestError) {
      if (error.code === "55000") return json({ error: "native_roulette_inactive" }, 409);
      if (error.status === 401 || error.status === 403) return json({ error: "unauthorized" }, 401);
      console.error(JSON.stringify({level:"error",message:"native roulette database request failed",code:error.code,resource:error.resource}));
      return json({ error: "native_roulette_database_unavailable" }, 503);
    }
    console.error(JSON.stringify({level:"error",message:"native roulette runtime failed",name:error instanceof Error?error.name:"Error"}));
    return json({ error: "native_roulette_runtime_failed" }, 500);
  }
});
