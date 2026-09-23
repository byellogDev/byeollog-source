import { corsHeaders } from "../_shared/cors.ts";
import {
  assertAutomationRuntimeReleaseActive,
  createServerRuntime,
  readOffslRuntimePreflight,
  runtimeRpcContext,
  RuntimeReleaseUnavailableError,
  ServiceRestError
} from "../_shared/server-runtime.ts";
import { buildAgentWallpaperState } from "../_shared/agent-wallpaper.ts";
import {
  normalizeAgentDeviceStatus,
  normalizeCollectionHealth,
  normalizeSupportedActionTypes
} from "../_shared/agent-device-status.ts";

type JsonObject = Record<string, unknown>;

interface ClaimedAgentExecution {
  execution_id: string;
  idempotency_key: string;
  workspace_id: string;
  event_id: string;
  execution_target: "local_agent";
  agent_device_id: string;
  action_type: string;
  action_params: JsonObject;
  timeout_ms: number;
  attempt_no: number;
  max_attempts: number;
  retry_backoff_seconds: number;
  lease_expires_at: string;
}

interface FinishedAgentExecution {
  execution_id: string;
  status: "retry_scheduled" | "succeeded" | "failed" | "cancelled";
  attempt_no: number;
  next_attempt_at: string;
  terminal: boolean;
}

interface RegisteredAgentDevice {
  created: boolean;
  registered_at: string;
}

interface RotatedAgentDeviceSecret {
  secret_revision: number;
  rotated_at: string;
  previous_valid_until: string;
}

interface RaffleActionSpeechContext {
  speech_text: string;
  binding_key: string;
}

// Kept only so already-deployed legacy branches remain type-checkable during
// the rollout. They are rejected by the operation allow-list above.
interface RaffleWinnerSpeechContext {
  actor_name: string;
  voice_key: string;
}
interface RaffleTtsCandidateContext extends RaffleWinnerSpeechContext {
  actor_key: string;
  total_count: number;
}

class RaffleTtsUnavailableError extends Error {}

const MAX_BODY_BYTES = 64 * 1024;
const RUNTIME_REVISION = "offsl-agent-runtime-g3a-v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_RAFFLE_TTS_BYTES = 2 * 1024 * 1024;
const G3A_AGENT_ACTIONS = new Set([
  "obs.mute_for",
  "obs.voice_anonymize_for",
  "obs.voice_anonymize_for_v2",
  "windows.mic_mute_for",
  "raffle.overlay",
  "flashbang.overlay",
  "obs.screen_flip_for",
  "obs.screen_shake_for",
  "water_splash.overlay",
  "fireworks.overlay",
  "obs.scene_switch",
  "agent.notify"
]);
const BUILT_IN_OVERLAY_ASSETS = [
  {
    assetId: "27ace87d-7ffa-5cfc-9c76-36c30cc1e2bc",
    assetKey: "mic_off",
    versionNumber: 1,
    displayName: "별록 마이크 OFF · 기존 화면(호환용)",
    mimeType: "image/svg+xml",
    contentSha256: "e1bcc594283f8307b9b681794618666bc9927b5efc1a2922523629c2c352873b",
    byteSize: 1926,
    widthPx: 1200,
    heightPx: 360,
    deliveryMode: "agent_builtin",
    required: true,
    downloadPath: null
  },
  {
    assetId: "f7ae3370-5e3c-5061-958b-c7c402c590c6",
    assetKey: "mic_off_center",
    versionNumber: 1,
    displayName: "마이크 OFF · 중앙 출력형",
    mimeType: "image/png",
    contentSha256: "70b19130e6807a364172eb129bfce03f5cae598cfde8242b762de7274476c464",
    byteSize: 335254,
    widthPx: 1254,
    heightPx: 1254,
    deliveryMode: "agent_builtin",
    required: false,
    downloadPath: null
  },
  {
    assetId: "f831caee-6953-51f9-9eee-9cfb66e96fc4",
    assetKey: "mic_off_top_left",
    versionNumber: 1,
    displayName: "마이크 OFF · 좌측 상단형",
    mimeType: "image/png",
    contentSha256: "70b19130e6807a364172eb129bfce03f5cae598cfde8242b762de7274476c464",
    byteSize: 335254,
    widthPx: 1254,
    heightPx: 1254,
    deliveryMode: "agent_builtin",
    required: false,
    downloadPath: null
  },
  {
    assetId: "e745492e-4420-52e8-9a2b-36f53144c1c8",
    assetKey: "mic_off_top_right",
    versionNumber: 1,
    displayName: "마이크 OFF · 우측 상단형",
    mimeType: "image/png",
    contentSha256: "70b19130e6807a364172eb129bfce03f5cae598cfde8242b762de7274476c464",
    byteSize: 335254,
    widthPx: 1254,
    heightPx: 1254,
    deliveryMode: "agent_builtin",
    required: false,
    downloadPath: null
  }
] as const;

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

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function validDeviceSecret(value: unknown): value is string {
  return typeof value === "string" && DEVICE_SECRET_PATTERN.test(value);
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number | null {
  if (value === undefined) return fallback;
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256BytesHex(value: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function raffleTtsConfig(): { endpoint: URL; secret: string } {
  const rawOrigin = Deno.env.get("BYEOLLOG_MANAGED_TTS_BRIDGE_ORIGIN")?.trim() ?? "";
  const secret = Deno.env.get("BYEOLLOG_MANAGED_TTS_BRIDGE_SECRET")?.trim() ?? "";
  let origin: URL;
  try {
    origin = new URL(rawOrigin);
  } catch {
    throw new RaffleTtsUnavailableError("raffle TTS origin is invalid");
  }
  if (origin.protocol !== "https:"
    || origin.username !== "" || origin.password !== ""
    || origin.search !== "" || origin.hash !== ""
    || secret.length < 43 || secret.length > 200
    || !/^[A-Za-z0-9._~-]+$/.test(secret)) {
    throw new RaffleTtsUnavailableError("raffle TTS configuration is unavailable");
  }
  return { endpoint: new URL("/api/auth/internal/raffle-tts", origin), secret };
}

async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function synthesizeRaffleActionSpeech(
  workspaceId: string,
  executionId: string,
  attemptNo: number,
  speechKind: "ticket" | "winner",
  speechText: string,
  bindingKey: string
): Promise<{ audio: ArrayBuffer; sha256: string; voiceVersion: string }> {
  const config = raffleTtsConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const textHash = await sha256Hex(speechText);
    const canonical = [
      timestamp, workspaceId, executionId, String(attemptNo), speechKind, bindingKey, textHash
    ].join(".");
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "audio/wav",
        "x-byeollog-timestamp": timestamp,
        "x-byeollog-signature": await hmacSha256Hex(config.secret, canonical)
      },
      body: JSON.stringify({
        workspaceId, executionId, attemptNo, speechKind, text: speechText, bindingKey
      }),
      signal: controller.signal
    });
    const contentType = response.headers.get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (!response.ok || contentType !== "audio/wav") {
      throw new RaffleTtsUnavailableError("raffle TTS synthesis failed");
    }
    const returnedVoiceKey = response.headers.get("x-byeollog-voice-key")?.trim() ?? "";
    const voiceVersion = response.headers.get("x-byeollog-voice-version")?.trim() ?? "";
    const serviceAudioHash = response.headers.get("x-byeollog-audio-sha256")?.trim() ?? "";
    if (returnedVoiceKey !== bindingKey
      || voiceVersion.length < 1 || voiceVersion.length > 80
      || !/^[A-Za-z0-9._-]+$/.test(voiceVersion)
      || !SHA256_PATTERN.test(serviceAudioHash)) {
      throw new RaffleTtsUnavailableError("raffle TTS identity response is invalid");
    }
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (!Number.isFinite(declaredLength) || declaredLength < 0
      || declaredLength > MAX_RAFFLE_TTS_BYTES) {
      throw new RaffleTtsUnavailableError("raffle TTS response is too large");
    }
    if (!response.body) {
      throw new RaffleTtsUnavailableError("raffle TTS response is invalid");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RAFFLE_TTS_BYTES) {
          await reader.cancel();
          throw new RaffleTtsUnavailableError("raffle TTS response is too large");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const audioBuffer = new ArrayBuffer(total);
    const audio = new Uint8Array(audioBuffer);
    let offset = 0;
    for (const chunk of chunks) {
      audio.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (audio.byteLength < 44 || audio.byteLength > MAX_RAFFLE_TTS_BYTES
      || audio[0] !== 0x52 || audio[1] !== 0x49 || audio[2] !== 0x46 || audio[3] !== 0x46
      || audio[8] !== 0x57 || audio[9] !== 0x41 || audio[10] !== 0x56 || audio[11] !== 0x45) {
      throw new RaffleTtsUnavailableError("raffle TTS response is invalid");
    }
    const sha256 = await sha256BytesHex(audioBuffer);
    if (sha256 !== serviceAudioHash) {
      throw new RaffleTtsUnavailableError("raffle TTS audio identity did not match");
    }
    return { audio: audioBuffer, sha256, voiceVersion };
  } catch (error) {
    if (error instanceof RaffleTtsUnavailableError) throw error;
    throw new RaffleTtsUnavailableError("raffle TTS service is unavailable");
  } finally {
    clearTimeout(timeout);
  }
}

async function synthesizeRaffleWinnerSpeech(
  _actorName: string,
  _voiceKey: string
): Promise<{ audio: ArrayBuffer; sha256: string; voiceVersion: string }> {
  throw new RaffleTtsUnavailableError("legacy raffle TTS path is retired");
}

function agentWorkerId(userId: string, deviceId: string): string {
  return `agent:${userId}:${deviceId}`;
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
    const runtime = await createServerRuntime(request, "agent_runtime", RUNTIME_REVISION);
    if (!runtime) return json({ error: "unauthorized" }, 401);

    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      return json({ error: "payload_too_large" }, 413);
    }
    const body = JSON.parse(rawBody) as unknown;
    if (!isObject(body)) return json({ error: "invalid_request" }, 400);

    const operation = body.operation;
    const workspaceId = body.workspaceId;
    const deviceId = body.deviceId;
    if (operation !== "register" && operation !== "rotate_secret"
      && operation !== "overlay_manifest"
      && operation !== "device_status" && operation !== "collection_health"
      && operation !== "wallpaper" && operation !== "claim"
      && operation !== "heartbeat" && operation !== "ack"
      && operation !== "raffle_action_tts") {
      return json({ error: "invalid_operation" }, 400);
    }
    if (!validUuid(workspaceId)) return json({ error: "invalid_workspace" }, 400);
    if (!validUuid(deviceId)) return json({ error: "invalid_device" }, 400);
    if (!validDeviceSecret(body.deviceSecret)) return json({ error: "invalid_device_secret" }, 400);

    const normalizedWorkspaceId = workspaceId.toLowerCase();
    const normalizedDeviceId = deviceId.toLowerCase();
    const deviceSecretHash = await sha256Hex(body.deviceSecret);
    const rpcContext = runtimeRpcContext(runtime, "agent_runtime", RUNTIME_REVISION);

    await assertAutomationRuntimeReleaseActive(
      runtime,
      normalizedWorkspaceId,
      "agent_runtime",
      RUNTIME_REVISION
    );

    if (operation === "overlay_manifest") {
      const authenticatedAt = await runtime.rest<string>("rpc/g3a_authenticate_agent_device_v1", {
        method: "POST",
        body: JSON.stringify({
          p_workspace_id: normalizedWorkspaceId,
          p_device_id: normalizedDeviceId,
          p_device_secret_hash: deviceSecretHash,
          ...rpcContext
        })
      });
      if (typeof authenticatedAt !== "string" || !Number.isFinite(Date.parse(authenticatedAt))) {
        throw new Error("Agent manifest authentication result was invalid");
      }
      return json({
        schemaVersion: 1,
        generatedAt: authenticatedAt,
        assets: BUILT_IN_OVERLAY_ASSETS
      });
    }

    if (operation === "register") {
      const deviceName = body.deviceName === undefined ? "Automation Agent" : body.deviceName;
      if (typeof deviceName !== "string" || deviceName.trim().length < 1 || deviceName.length > 120) {
        return json({ error: "invalid_device_name" }, 400);
      }
      const rows = await runtime.rest<RegisteredAgentDevice[]>("rpc/g3a_register_agent_device_v1", {
        method: "POST",
        body: JSON.stringify({
          p_workspace_id: normalizedWorkspaceId,
          p_device_id: normalizedDeviceId,
          p_device_name: deviceName.trim(),
          p_device_secret_hash: deviceSecretHash,
          p_authenticated_at: runtime.recentAuthenticationAt,
          p_authentication_method: runtime.recentAuthenticationMethod,
          ...rpcContext
        })
      });
      const item = rows[0];
      if (rows.length !== 1 || !item || typeof item.created !== "boolean"
        || typeof item.registered_at !== "string" || !Number.isFinite(Date.parse(item.registered_at))) {
        throw new Error("Agent registration result was invalid");
      }
      return json({
        deviceId: normalizedDeviceId,
        registered: true,
        created: item.created,
        registeredAt: item.registered_at
      });
    }

    if (operation === "rotate_secret") {
      if (!validDeviceSecret(body.newDeviceSecret) || body.newDeviceSecret === body.deviceSecret) {
        return json({ error: "invalid_new_device_secret" }, 400);
      }
      const rows = await runtime.rest<RotatedAgentDeviceSecret[]>(
        "rpc/g3a_rotate_agent_device_secret_v1",
        {
          method: "POST",
          body: JSON.stringify({
            p_workspace_id: normalizedWorkspaceId,
            p_device_id: normalizedDeviceId,
            p_current_secret_hash: deviceSecretHash,
            p_new_secret_hash: await sha256Hex(body.newDeviceSecret),
            ...rpcContext
          })
        }
      );
      const item = rows[0];
      if (rows.length !== 1 || !item
        || !Number.isSafeInteger(item.secret_revision) || item.secret_revision < 1
        || typeof item.rotated_at !== "string" || !Number.isFinite(Date.parse(item.rotated_at))
        || typeof item.previous_valid_until !== "string"
        || !Number.isFinite(Date.parse(item.previous_valid_until))) {
        throw new Error("Agent secret rotation result was invalid");
      }
      return json({
        deviceId: normalizedDeviceId,
        secretRevision: item.secret_revision,
        rotatedAt: item.rotated_at,
        previousValidUntil: item.previous_valid_until
      });
    }

    if (operation === "device_status") {
      const status = normalizeAgentDeviceStatus(body);
      if (status === null) return json({ error: "invalid_device_status" }, 400);
      const health = body.collectionState === undefined
        ? null
        : normalizeCollectionHealth(body);
      if (body.collectionState !== undefined && health === null) {
        return json({ error: "invalid_collection_health" }, 400);
      }
      const reportedAt = await runtime.rest<string>("rpc/g3a_report_agent_status_v1", {
        method: "POST",
        body: JSON.stringify({
          p_workspace_id: normalizedWorkspaceId,
          p_device_id: normalizedDeviceId,
          p_device_secret_hash: deviceSecretHash,
          p_agent_version: status.agentVersion,
          p_platform: status.platform,
          p_supported_action_types: status.supportedActionTypes,
          ...rpcContext
        })
      });
      if (typeof reportedAt !== "string" || !Number.isFinite(Date.parse(reportedAt))) {
        throw new Error("Agent status result was invalid");
      }
      if (health !== null) {
        const collectionReportedAt = await runtime.rest<string>("rpc/g3a_report_collection_health_v1", {
          method: "POST",
          body: JSON.stringify({
            p_workspace_id: normalizedWorkspaceId,
            p_device_id: normalizedDeviceId,
            p_device_secret_hash: deviceSecretHash,
            p_collection_state: health.collectionState,
            p_session_started_at: health.sessionStartedAt,
            p_last_observed_at: health.lastObservedAt,
            p_last_upload_at: health.lastUploadAt,
            ...rpcContext
          })
        });
        if (typeof collectionReportedAt !== "string"
          || !Number.isFinite(Date.parse(collectionReportedAt))) {
          throw new Error("Collection health result was invalid");
        }
      }
      return json({ deviceId: normalizedDeviceId, reportedAt });
    }

    if (operation === "collection_health") {
      const health = normalizeCollectionHealth(body);
      if (health === null) return json({ error: "invalid_collection_health" }, 400);
      const reportedAt = await runtime.rest<string>("rpc/g3a_report_collection_health_v1", {
        method: "POST",
        body: JSON.stringify({
          p_workspace_id: normalizedWorkspaceId,
          p_device_id: normalizedDeviceId,
          p_device_secret_hash: deviceSecretHash,
          p_collection_state: health.collectionState,
          p_session_started_at: health.sessionStartedAt,
          p_last_observed_at: health.lastObservedAt,
          p_last_upload_at: health.lastUploadAt,
          ...rpcContext
        })
      });
      if (typeof reportedAt !== "string" || !Number.isFinite(Date.parse(reportedAt))) {
        throw new Error("Collection health result was invalid");
      }
      return json({ deviceId: normalizedDeviceId, reportedAt });
    }

    const workerId = agentWorkerId(runtime.userId, normalizedDeviceId);

    if (operation === "raffle_tts_candidates") {
      const drawId = body.drawId;
      const afterActorKey = body.afterActorKey ?? null;
      const limit = boundedInteger(body.limit, 25, 1, 25);
      if (!validUuid(drawId)
        || limit === null
        || (afterActorKey !== null
          && (typeof afterActorKey !== "string"
            || afterActorKey.length < 1 || afterActorKey.length > 180))) {
        return json({ error: "invalid_raffle_tts_candidate_request" }, 400);
      }
      const rows = await runtime.rest<RaffleTtsCandidateContext[]>(
        "rpc/g3a_list_raffle_tts_candidates_v1",
        {
          method: "POST",
          body: JSON.stringify({
            p_workspace_id: normalizedWorkspaceId,
            p_draw_id: drawId.toLowerCase(),
            p_after_actor_key: afterActorKey,
            p_limit: limit,
            p_agent_device_id: normalizedDeviceId,
            p_agent_secret_hash: deviceSecretHash,
            ...rpcContext
          })
        }
      );
      let totalCount = 0;
      const candidates = rows.map((row) => {
        if (typeof row.actor_key !== "string"
          || row.actor_key.length < 1 || row.actor_key.length > 180
          || typeof row.actor_name !== "string"
          || row.actor_name.trim().length < 1 || row.actor_name.length > 120
          || typeof row.voice_key !== "string" || !SHA256_PATTERN.test(row.voice_key)
          || !Number.isSafeInteger(row.total_count)
          || row.total_count < 1 || row.total_count > 100_000) {
          throw new Error("Raffle TTS candidate manifest was invalid");
        }
        if (totalCount !== 0 && totalCount !== row.total_count) {
          throw new Error("Raffle TTS candidate count changed");
        }
        totalCount = row.total_count;
        return {
          actorKey: row.actor_key,
          actorName: row.actor_name,
          voiceKey: row.voice_key
        };
      });
      return json({
        drawId: drawId.toLowerCase(),
        totalCount,
        candidates,
        nextCursor: candidates.length === limit
          ? candidates[candidates.length - 1]?.actorKey ?? null
          : null
      });
    }

    if (operation === "raffle_candidate_tts") {
      const drawId = body.drawId;
      const actorKey = body.actorKey;
      const expectedVoiceKey = body.expectedVoiceKey;
      if (!validUuid(drawId)
        || typeof actorKey !== "string" || actorKey.length < 1 || actorKey.length > 180
        || typeof expectedVoiceKey !== "string" || !SHA256_PATTERN.test(expectedVoiceKey)) {
        return json({ error: "invalid_raffle_tts_candidate_request" }, 400);
      }
      const rows = await runtime.rest<RaffleWinnerSpeechContext[]>(
        "rpc/g3a_prepare_raffle_candidate_tts_v1",
        {
          method: "POST",
          body: JSON.stringify({
            p_workspace_id: normalizedWorkspaceId,
            p_draw_id: drawId.toLowerCase(),
            p_actor_key: actorKey,
            p_expected_voice_key: expectedVoiceKey,
            p_agent_device_id: normalizedDeviceId,
            p_agent_secret_hash: deviceSecretHash,
            ...rpcContext
          })
        }
      );
      const speechContext = rows[0];
      if (rows.length !== 1 || !speechContext
        || typeof speechContext.actor_name !== "string"
        || speechContext.actor_name.trim().length < 1
        || speechContext.actor_name.length > 120
        || speechContext.voice_key !== expectedVoiceKey) {
        throw new Error("Raffle candidate speech context was invalid");
      }
      const synthesized = await synthesizeRaffleWinnerSpeech(
        speechContext.actor_name,
        speechContext.voice_key
      );
      return new Response(synthesized.audio, {
        status: 200,
        headers: {
          ...corsHeaders,
          "content-type": "audio/wav",
          "content-length": String(synthesized.audio.byteLength),
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
          "x-byeollog-audio-sha256": synthesized.sha256,
          "x-byeollog-voice-key": speechContext.voice_key,
          "x-byeollog-voice-version": synthesized.voiceVersion,
          "x-byeollog-runtime-revision": RUNTIME_REVISION
        }
      });
    }

    if (operation === "wallpaper") {
      const wallpaperSchemaVersion = boundedInteger(body.wallpaperSchemaVersion, 1, 1, 2);
      const knownWallpaperRevision = boundedInteger(
        body.knownWallpaperRevision,
        -1,
        -1,
        Number.MAX_SAFE_INTEGER
      );
      if (knownWallpaperRevision === null || wallpaperSchemaVersion === null) {
        return json({ error: "invalid_wallpaper_parameters" }, 400);
      }
      try {
        const rawWallpaper = await runtime.rest<unknown>("rpc/g3a_get_wallpaper_snapshot_v1", {
          method: "POST",
          body: JSON.stringify({
            p_workspace_id: normalizedWorkspaceId,
            p_known_revision: knownWallpaperRevision,
            p_device_id: normalizedDeviceId,
            p_device_secret_hash: deviceSecretHash,
            ...rpcContext
          })
        });
        const wallpaper = await buildAgentWallpaperState(
          rawWallpaper,
          normalizedWorkspaceId,
          runtime.supabaseUrl,
          wallpaperSchemaVersion
        );
        return json({ wallpaper });
      } catch (error) {
        console.error("agent_wallpaper_direct_sync_failed", {
          name: error instanceof Error ? error.name : "UnknownError"
        });
        return json({
          wallpaper: {
            changed: false,
            revision: knownWallpaperRevision,
            unavailable: true
          }
        });
      }
    }

    if (operation === "claim") {
      const wallpaperSchemaVersion = boundedInteger(body.wallpaperSchemaVersion, 1, 1, 2);
      const leaseSeconds = boundedInteger(body.leaseSeconds, 45, 5, 600);
      const supportedActionTypes = normalizeSupportedActionTypes(body.supportedActionTypes);
      const knownWallpaperRevision = body.knownWallpaperRevision === undefined
        ? null
        : boundedInteger(body.knownWallpaperRevision, -1, -1, Number.MAX_SAFE_INTEGER);
      if (leaseSeconds === null || supportedActionTypes === null || wallpaperSchemaVersion === null
        || (body.knownWallpaperRevision !== undefined && knownWallpaperRevision === null)) {
        return json({ error: "invalid_claim_parameters" }, 400);
      }
      const claimed = await runtime.rest<ClaimedAgentExecution[]>("rpc/g3a_claim_execution_v1", {
        method: "POST",
        body: JSON.stringify({
          p_workspace_id: normalizedWorkspaceId,
          p_worker_id: workerId,
          p_lease_seconds: leaseSeconds,
          p_execution_ids: null,
          p_execution_target: "local_agent",
          p_agent_device_id: normalizedDeviceId,
          p_agent_secret_hash: deviceSecretHash,
          p_supported_action_types: supportedActionTypes,
          ...rpcContext
        })
      });
      const item = claimed[0];
      let wallpaper: JsonObject | null = null;
      // 액션 claim은 방송 반응시간의 임계 경로다. 실행할 작업이 있으면 풍벽지
      // 스냅샷 RPC/이미지 서명 작업을 전혀 기다리지 않고 즉시 Agent로 돌려준다.
      // 풍벽지는 대기 poll에서만 갱신되므로 액션과 데이터 경로도 분리된다.
      if (!item && knownWallpaperRevision !== null) {
        try {
          const rawWallpaper = await runtime.rest<unknown>("rpc/g3a_get_wallpaper_snapshot_v1", {
            method: "POST",
            body: JSON.stringify({
              p_workspace_id: normalizedWorkspaceId,
              p_known_revision: knownWallpaperRevision,
              p_device_id: normalizedDeviceId,
              p_device_secret_hash: deviceSecretHash,
              ...rpcContext
            })
          });
          wallpaper = await buildAgentWallpaperState(
            rawWallpaper,
            normalizedWorkspaceId,
            runtime.supabaseUrl,
            wallpaperSchemaVersion
          );
        } catch (error) {
          console.error("agent_wallpaper_sync_failed", {
            name: error instanceof Error ? error.name : "UnknownError"
          });
          wallpaper = { changed: false, revision: knownWallpaperRevision, unavailable: true };
        }
      }
      if (!item) return json({ job: null, ...(wallpaper === null ? {} : { wallpaper }) });
      if (item.workspace_id.toLowerCase() !== normalizedWorkspaceId
        || item.execution_target !== "local_agent"
        || item.agent_device_id.toLowerCase() !== normalizedDeviceId
        || !G3A_AGENT_ACTIONS.has(item.action_type)
        || !supportedActionTypes.includes(item.action_type)) {
        throw new Error("Claimed Agent execution violated the G3A boundary");
      }
      return json({
        job: {
          executionId: item.execution_id,
          idempotencyKey: item.idempotency_key,
          workspaceId: item.workspace_id,
          eventId: item.event_id,
          executionTarget: item.execution_target,
          agentDeviceId: item.agent_device_id,
          actionType: item.action_type,
          actionParams: item.action_params,
          timeoutMs: item.timeout_ms,
          attemptNo: item.attempt_no,
          maxAttempts: item.max_attempts,
          retryBackoffSeconds: item.retry_backoff_seconds,
          leaseExpiresAt: item.lease_expires_at
        },
        ...(wallpaper === null ? {} : { wallpaper })
      });
    }

    const executionId = body.executionId;
    const attemptNo = body.attemptNo;
    if (!validUuid(executionId) || typeof attemptNo !== "number"
      || !Number.isInteger(attemptNo) || attemptNo < 1 || attemptNo > 10) {
      return json({ error: "invalid_execution_identity" }, 400);
    }

    if (operation === "heartbeat") {
      const leaseSeconds = boundedInteger(body.leaseSeconds, 45, 5, 600);
      if (leaseSeconds === null) return json({ error: "invalid_lease_seconds" }, 400);
      const leaseExpiresAt = await runtime.rest<string>("rpc/g3a_renew_execution_v1", {
        method: "POST",
        body: JSON.stringify({
          p_workspace_id: normalizedWorkspaceId,
          p_execution_id: executionId.toLowerCase(),
          p_worker_id: workerId,
          p_attempt_no: attemptNo,
          p_lease_seconds: leaseSeconds,
          p_agent_device_id: normalizedDeviceId,
          p_agent_secret_hash: deviceSecretHash,
          ...rpcContext
        })
      });
      if (typeof leaseExpiresAt !== "string" || !Number.isFinite(Date.parse(leaseExpiresAt))) {
        throw new Error("Agent heartbeat result was invalid");
      }
      return json({ executionId: executionId.toLowerCase(), leaseExpiresAt });
    }

    if (operation === "raffle_action_tts") {
      const speechKind = body.speechKind;
      const winnerOrdinal = body.winnerOrdinal;
      const expectedBindingKey = body.expectedBindingKey;
      if ((speechKind !== "ticket" && speechKind !== "winner")
        || typeof winnerOrdinal !== "number" || !Number.isInteger(winnerOrdinal)
        || winnerOrdinal < 0 || winnerOrdinal > 99
        || typeof expectedBindingKey !== "string"
        || !SHA256_PATTERN.test(expectedBindingKey)) {
        return json({ error: "invalid_raffle_speech_request" }, 400);
      }
      const rows = await runtime.rest<RaffleActionSpeechContext[]>(
        "rpc/g3a_prepare_raffle_action_tts_v1",
        {
          method: "POST",
          body: JSON.stringify({
            p_workspace_id: normalizedWorkspaceId,
            p_execution_id: executionId.toLowerCase(),
            p_worker_id: workerId,
            p_attempt_no: attemptNo,
            p_speech_kind: speechKind,
            p_winner_ordinal: winnerOrdinal,
            p_expected_binding_key: expectedBindingKey,
            p_agent_device_id: normalizedDeviceId,
            p_agent_secret_hash: deviceSecretHash,
            ...rpcContext
          })
        }
      );
      const speechContext = rows[0];
      if (rows.length !== 1 || !speechContext
        || typeof speechContext.speech_text !== "string"
        || speechContext.speech_text.trim().length < 1
        || speechContext.speech_text.length > 240
        || typeof speechContext.binding_key !== "string"
        || speechContext.binding_key !== expectedBindingKey) {
        throw new Error("Raffle action speech context was invalid");
      }
      const synthesized = await synthesizeRaffleActionSpeech(
        normalizedWorkspaceId,
        executionId.toLowerCase(),
        attemptNo,
        speechKind,
        speechContext.speech_text,
        speechContext.binding_key
      );
      return new Response(synthesized.audio, {
        status: 200,
        headers: {
          ...corsHeaders,
          "content-type": "audio/wav",
          "content-length": String(synthesized.audio.byteLength),
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
          "x-byeollog-audio-sha256": synthesized.sha256,
          "x-byeollog-voice-key": speechContext.binding_key,
          "x-byeollog-voice-version": synthesized.voiceVersion,
          "x-byeollog-runtime-revision": RUNTIME_REVISION
        }
      });
    }

    const succeeded = body.succeeded;
    const retryable = body.retryable ?? false;
    const result = body.result ?? null;
    const errorText = body.error ?? null;
    if (typeof succeeded !== "boolean" || typeof retryable !== "boolean"
      || (succeeded && retryable)
      || (succeeded && errorText !== null)
      || (!succeeded && result !== null)
      || (result !== null && !isObject(result))
      || (errorText !== null && (typeof errorText !== "string" || errorText.length > 2000))) {
      return json({ error: "invalid_ack_payload" }, 400);
    }
    const rows = await runtime.rest<FinishedAgentExecution[]>("rpc/g3a_finish_execution_v1", {
      method: "POST",
      body: JSON.stringify({
        p_workspace_id: normalizedWorkspaceId,
        p_execution_id: executionId.toLowerCase(),
        p_worker_id: workerId,
        p_attempt_no: attemptNo,
        p_succeeded: succeeded,
        p_result: result,
        p_error: errorText,
        p_retryable: retryable,
        p_agent_device_id: normalizedDeviceId,
        p_agent_secret_hash: deviceSecretHash,
        ...rpcContext
      })
    });
    const item = rows[0];
    if (rows.length !== 1 || !item) throw new Error("Agent acknowledgement result was invalid");
    return json({
      executionId: item.execution_id,
      status: item.status,
      attemptNo: item.attempt_no,
      nextAttemptAt: item.next_attempt_at,
      terminal: item.terminal
    });
  } catch (error) {
    if (error instanceof RuntimeReleaseUnavailableError) {
      return json({ error: "runtime_release_inactive" }, 503);
    }
    if (error instanceof RaffleTtsUnavailableError) {
      return json({ error: "raffle_tts_unavailable" }, 503);
    }
    if (error instanceof ServiceRestError) {
      if (error.code === "BLR03") return json({ error: "runtime_release_inactive" }, 503);
      if (error.code === "BL101") return json({ error: "recent_authentication_required" }, 403);
      if (error.code === "BL102") return json({ error: "device_session_already_used" }, 409);
      if (error.code === "BL103") return json({ error: "device_limit_reached" }, 409);
      if (error.code === "28000") return json({ error: "device_auth_failed" }, 403);
      if (error.code === "55000" || error.code === "P0002") {
        return json({ error: "execution_state_conflict" }, 409);
      }
    }
    if (error instanceof SyntaxError) return json({ error: "invalid_json" }, 400);
    const message = error instanceof Error ? error.message : String(error);
    console.error("agent_runtime_failed", { message });
    return json({ error: "internal_error" }, 500);
  }
});

