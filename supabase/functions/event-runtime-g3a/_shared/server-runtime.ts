export interface RestRequestInit extends RequestInit {
  prefer?: string;
}

export type ServiceRestClient = <T>(path: string, init?: RestRequestInit) => Promise<T>;

export class ServiceRestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly resource: string;

  constructor(status: number, code: string, resource: string) {
    super(`Database request failed (${status}: ${code})`);
    this.name = "ServiceRestError";
    this.status = status;
    this.code = code;
    this.resource = resource;
  }
}

export class RuntimeReleaseUnavailableError extends Error {
  constructor() {
    super("Automation runtime release is inactive or stale");
    this.name = "RuntimeReleaseUnavailableError";
  }
}

export interface ServerRuntime {
  projectRef: string;
  supabaseUrl: string;
  userId: string;
  sessionId: string;
  sessionIssuedAt: number;
  recentAuthenticationAt: number | null;
  recentAuthenticationMethod: string | null;
  assuranceLevel: "aal1" | "aal2" | null;
  rest: ServiceRestClient;
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing server configuration: ${name}`);
  return value;
}

function looksLikeJwt(value: string): boolean {
  return value.split(".").length === 3;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXPECTED_PROJECT_REF = "offslvwaugvjotkywlus";
const EXPECTED_SUPABASE_ORIGIN = "https://offslvwaugvjotkywlus.supabase.co";
export const EXPECTED_DB_REVISION = "offsl-vnext-g3a-v1";
const MAX_JWT_BYTES = 16 * 1024;
const MAX_JWT_PAYLOAD_BYTES = 8 * 1024;

interface JwtSessionBinding {
  token: string;
  userId: string;
  sessionId: string;
  issuedAt: number;
  recentAuthenticationAt: number | null;
  recentAuthenticationMethod: string | null;
  assuranceLevel: "aal1" | "aal2" | null;
}

interface AuthenticationMethodReference {
  method: string;
  timestamp: number;
}

const MAX_AUTHENTICATION_METHODS = 16;
const MAX_AUTHENTICATION_CLOCK_SKEW_SECONDS = 60;
const INTERACTIVE_AUTHENTICATION_METHODS = new Set([
  "password",
  "otp",
  "totp",
  "magiclink",
  "oauth",
  "sso/saml",
  "oauth_provider/authorization_code"
]);
const AUTHENTICATION_METHOD_PATTERN = /^[a-z][a-z0-9_./-]{0,79}$/;

function decodeBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > MAX_JWT_PAYLOAD_BYTES * 2) return null;
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "=");
  try {
    const decoded = atob(padded);
    if (decoded.length > MAX_JWT_PAYLOAD_BYTES) return null;
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function readAuthenticationMethods(
  value: unknown,
  nowSeconds: number
): AuthenticationMethodReference | null | false {
  if (value === undefined) return null;
  if (!Array.isArray(value)
    || value.length < 1
    || value.length > MAX_AUTHENTICATION_METHODS) return false;

  let latest: AuthenticationMethodReference | null = null;
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return false;
    const reference = item as Record<string, unknown>;
    if (typeof reference.method !== "string"
      || !AUTHENTICATION_METHOD_PATTERN.test(reference.method)
      || typeof reference.timestamp !== "number"
      || !Number.isSafeInteger(reference.timestamp)
      || reference.timestamp < 1
      || reference.timestamp > nowSeconds + MAX_AUTHENTICATION_CLOCK_SKEW_SECONDS) {
      return false;
    }
    if (INTERACTIVE_AUTHENTICATION_METHODS.has(reference.method)
      && (latest === null || reference.timestamp > latest.timestamp)) {
      latest = { method: reference.method, timestamp: reference.timestamp };
    }
  }
  return latest;
}

export function readJwtSessionBinding(
  authorization: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): JwtSessionBinding | null {
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 1) return null;
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
  if (!match || match[1].length > MAX_JWT_BYTES) return null;
  const token = match[1];
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return null;
  const payloadText = decodeBase64Url(parts[1]);
  if (payloadText === null) return null;

  try {
    const payload = JSON.parse(payloadText) as unknown;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
    const claims = payload as Record<string, unknown>;
    if (typeof claims.sub !== "string" || !UUID_PATTERN.test(claims.sub)
      || typeof claims.session_id !== "string" || !UUID_PATTERN.test(claims.session_id)
      || typeof claims.iat !== "number" || !Number.isSafeInteger(claims.iat) || claims.iat < 1) {
      return null;
    }
    const recentAuthentication = readAuthenticationMethods(claims.amr, nowSeconds);
    if (recentAuthentication === false) return null;
    const assuranceLevel = claims.aal === "aal1" || claims.aal === "aal2" ? claims.aal : null;
    return {
      token,
      userId: claims.sub.toLowerCase(),
      sessionId: claims.session_id.toLowerCase(),
      issuedAt: claims.iat,
      recentAuthenticationAt: recentAuthentication?.timestamp ?? null,
      recentAuthenticationMethod: recentAuthentication?.method ?? null,
      assuranceLevel
    };
  } catch {
    return null;
  }
}

function exactOffslSupabaseOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:"
      || url.hostname !== "offslvwaugvjotkywlus.supabase.co"
      || url.port !== ""
      || url.username !== ""
      || url.password !== ""
      || url.pathname !== "/"
      || url.search !== ""
      || url.hash !== ""
      || url.origin !== EXPECTED_SUPABASE_ORIGIN) return null;
    return EXPECTED_SUPABASE_ORIGIN;
  } catch {
    return null;
  }
}

export type RuntimeComponent = "event_runtime" | "execution_worker" | "agent_runtime";

const EXPECTED_RUNTIME_REVISIONS: Readonly<Record<RuntimeComponent, string>> = {
  event_runtime: "offsl-event-runtime-g3a-v1",
  execution_worker: "offsl-execution-worker-g3a-v1",
  agent_runtime: "offsl-agent-runtime-g3a-v1"
};

export function runtimeRpcContext(
  runtime: ServerRuntime,
  runtimeComponent: RuntimeComponent,
  runtimeRevision: string
): Record<string, string> {
  if (runtimeRevision !== EXPECTED_RUNTIME_REVISIONS[runtimeComponent]) {
    throw new RuntimeReleaseUnavailableError();
  }
  return {
    p_authorized_user_id: runtime.userId,
    p_session_id: runtime.sessionId,
    p_runtime_component: runtimeComponent,
    p_runtime_revision: runtimeRevision,
    p_db_revision: EXPECTED_DB_REVISION
  };
}

export function readOffslRuntimePreflight(): { projectRef: string; supabaseUrl: string } {
  const supabaseUrl = exactOffslSupabaseOrigin(requiredEnv("SUPABASE_URL"));
  if (supabaseUrl === null) {
    throw new Error("Server Supabase origin does not match the offsl production boundary");
  }
  return { projectRef: EXPECTED_PROJECT_REF, supabaseUrl };
}

export async function createServerRuntime(
  request: Request,
  runtimeComponent: RuntimeComponent,
  runtimeRevision: string
): Promise<ServerRuntime | null> {
  const authorization = request.headers.get("authorization") ?? "";
  const sessionBinding = readJwtSessionBinding(authorization);
  if (sessionBinding === null) return null;

  if (runtimeRevision !== EXPECTED_RUNTIME_REVISIONS[runtimeComponent]) {
    throw new RuntimeReleaseUnavailableError();
  }

  // Validate the complete origin before reading or sending a service secret.
  // A matching first DNS label (for example, an attacker-controlled suffix) is
  // not project identity.
  const { supabaseUrl, projectRef } = readOffslRuntimePreflight();
  const serviceKey = Deno.env.get("BYEOLLOG_SUPABASE_SECRET_KEY") ?? requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const authResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceKey, authorization }
  });
  if (!authResponse.ok) return null;

  const authUser = await authResponse.json() as { id?: unknown };
  if (typeof authUser.id !== "string"
    || !UUID_PATTERN.test(authUser.id)
    || authUser.id.toLowerCase() !== sessionBinding.userId) return null;

  const rest: ServiceRestClient = async <T>(path: string, init: RestRequestInit = {}): Promise<T> => {
    if (!/^rpc\/g3a_[a-z0-9_]+_v1$/.test(path)) {
      throw new Error("G3A Edge Functions may call only versioned G3A RPCs");
    }
    const { prefer, ...requestInit } = init;
    const headers = new Headers(requestInit.headers);
    headers.set("apikey", serviceKey);
    headers.set("content-type", "application/json");
    if (looksLikeJwt(serviceKey)) headers.set("authorization", `Bearer ${serviceKey}`);
    else headers.delete("authorization");
    if (prefer) headers.set("prefer", prefer);

    const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
      ...requestInit,
      headers
    });
    const body = await response.text();
    if (!response.ok) {
      let code = "unknown_database_error";
      try {
        const parsed = body ? JSON.parse(body) as { code?: unknown } : null;
        if (parsed && typeof parsed.code === "string") code = parsed.code;
      } catch {
        // Keep a stable non-sensitive fallback code for non-JSON responses.
      }
      console.error("database_request_failed", {
        path: path.split("?")[0],
        status: response.status,
        code
      });
      throw new ServiceRestError(response.status, code, path.split("?")[0] ?? "unknown");
    }
    return (body ? JSON.parse(body) : null) as T;
  };

  // Supabase access JWTs remain cryptographically valid until exp. For these
  // sensitive server routes we additionally require the verified session_id
  // to still exist in auth.sessions, so local/global sign-out takes effect on
  // the next request instead of waiting for JWT expiry.
  const activeSession = await rest<boolean>("rpc/g3a_assert_active_auth_session_v1", {
    method: "POST",
    body: JSON.stringify({
      p_user_id: sessionBinding.userId,
      p_session_id: sessionBinding.sessionId
    })
  });
  if (activeSession !== true) return null;

  return {
    projectRef,
    supabaseUrl,
    userId: sessionBinding.userId,
    sessionId: sessionBinding.sessionId,
    sessionIssuedAt: sessionBinding.issuedAt,
    recentAuthenticationAt: sessionBinding.recentAuthenticationAt,
    recentAuthenticationMethod: sessionBinding.recentAuthenticationMethod,
    assuranceLevel: sessionBinding.assuranceLevel,
    rest
  };
}

/**
 * Workspace-scoped release, membership and role assertion. Call only after a
 * POST body has yielded a syntactically valid workspace UUID. The user id is
 * derived from the JWT verified by createServerRuntime, never from the body.
 */
export async function assertAutomationRuntimeReleaseActive(
  runtime: ServerRuntime,
  workspaceId: string,
  runtimeComponent: RuntimeComponent,
  runtimeRevision: string
): Promise<void> {
  if (!UUID_PATTERN.test(workspaceId)
    || runtimeRevision !== EXPECTED_RUNTIME_REVISIONS[runtimeComponent]) {
    throw new RuntimeReleaseUnavailableError();
  }
  try {
    const releaseActive = await runtime.rest<boolean>(
      "rpc/g3a_assert_runtime_active_v1",
      {
        method: "POST",
        body: JSON.stringify({
          p_workspace_id: workspaceId,
          ...runtimeRpcContext(runtime, runtimeComponent, runtimeRevision)
        })
      }
    );
    if (releaseActive !== true) throw new RuntimeReleaseUnavailableError();
  } catch (error) {
    if (error instanceof RuntimeReleaseUnavailableError) throw error;
    // BLR03 intentionally collapses inactive release, non-allowlisted
    // workspace and membership/role failure into the same response.
    throw new RuntimeReleaseUnavailableError();
  }
}

