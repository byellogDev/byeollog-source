type JsonObject = Record<string, unknown>;

export interface NormalizedAgentDeviceStatus {
  agentVersion: string;
  platform: "windows" | "linux" | "macos" | "unknown";
  supportedActionTypes: string[];
}

export interface NormalizedCollectionHealth {
  collectionState: "active" | "idle" | "recovering" | "error";
  sessionStartedAt: string | null;
  lastObservedAt: string | null;
  lastUploadAt: string | null;
}

const ACTION_TYPE_PATTERN = /^[a-z][a-z0-9_.-]{0,119}$/;
const AGENT_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const AGENT_PLATFORMS = new Set(["windows", "linux", "macos", "unknown"]);
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

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function instant(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value === null ? null : undefined;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

export function normalizeCollectionHealth(body: unknown): NormalizedCollectionHealth | null {
  if (!isObject(body)) return null;
  const collectionState = body.collectionState;
  // The Windows Agent intentionally reports nullable timestamps while idle.
  // Its shared JSON options omit null properties, so an absent timestamp has
  // the same wire meaning as an explicit null.  Invalid provided values still
  // return undefined and remain fail-closed.
  const sessionStartedAt = body.sessionStartedAt === undefined
    ? null : instant(body.sessionStartedAt);
  const lastObservedAt = body.lastObservedAt === undefined
    ? null : instant(body.lastObservedAt);
  const lastUploadAt = body.lastUploadAt === undefined
    ? null : instant(body.lastUploadAt);
  if (collectionState !== "active" && collectionState !== "idle"
    && collectionState !== "recovering" && collectionState !== "error"
    || sessionStartedAt === undefined || lastObservedAt === undefined || lastUploadAt === undefined) return null;
  return { collectionState, sessionStartedAt, lastObservedAt, lastUploadAt };
}

export function normalizeSupportedActionTypes(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) return null;
  const unique = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string"
      || !ACTION_TYPE_PATTERN.test(item)
      || !G3A_AGENT_ACTIONS.has(item)
      || unique.has(item)) return null;
    unique.add(item);
  }
  return [...unique].sort();
}

export function normalizeAgentDeviceStatus(body: unknown): NormalizedAgentDeviceStatus | null {
  if (!isObject(body)) return null;
  const agentVersion = body.agentVersion;
  const platform = body.platform;
  const supportedActionTypes = normalizeSupportedActionTypes(body.supportedActionTypes);
  if (typeof agentVersion !== "string" || !AGENT_VERSION_PATTERN.test(agentVersion)
    || typeof platform !== "string" || !AGENT_PLATFORMS.has(platform)
    || supportedActionTypes === null) return null;
  return {
    agentVersion,
    platform: platform as NormalizedAgentDeviceStatus["platform"],
    supportedActionTypes
  };
}
