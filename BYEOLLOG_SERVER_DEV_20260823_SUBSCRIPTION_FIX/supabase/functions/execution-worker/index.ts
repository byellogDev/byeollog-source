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

const MAX_BODY_BYTES = 64 * 1024;
const MAX_JOBS = 20;
const RUNTIME_REVISION = "offsl-execution-worker-g3a-v1";
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
    const runtime = await createServerRuntime(request, "execution_worker", RUNTIME_REVISION);
    if (!runtime) return json({ error: "unauthorized" }, 401);

    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      return json({ error: "payload_too_large" }, 413);
    }
    const body = JSON.parse(rawBody) as unknown;
    if (!isObject(body)) return json({ error: "invalid_request" }, 400);

    const workspaceId = body.workspaceId;
    if (typeof workspaceId !== "string" || !UUID_PATTERN.test(workspaceId)) {
      return json({ error: "invalid_workspace" }, 400);
    }
    await assertAutomationRuntimeReleaseActive(
      runtime,
      workspaceId,
      "execution_worker",
      RUNTIME_REVISION
    );

    const maxJobs = typeof body.maxJobs === "number" && Number.isInteger(body.maxJobs)
      ? Math.min(MAX_JOBS, Math.max(1, body.maxJobs))
      : 10;
    const executionIds = body.executionIds === undefined
      ? undefined
      : Array.isArray(body.executionIds) && body.executionIds.length <= MAX_JOBS && body.executionIds.every(
        (value) => typeof value === "string" && UUID_PATTERN.test(value)
      )
      ? body.executionIds as string[]
      : null;
    if (executionIds === null) return json({ error: "invalid_execution_ids" }, 400);

    const processed = await processExecutionQueue(runtime.rest, workspaceId, {
      workerId: `execution-worker:${runtime.userId.slice(0, 8)}:${crypto.randomUUID()}`,
      maxJobs,
      maxRunTimeMs: 120000,
      rpcContext: runtimeRpcContext(runtime, "execution_worker", RUNTIME_REVISION),
      executionIds
    });

    return json({
      claimed: processed.length,
      completed: processed.filter((item) => item.status === "succeeded").length,
      retryScheduled: processed.filter((item) => item.status === "retry_scheduled").length,
      failed: processed.filter((item) => item.status === "failed").length,
      results: processed
    });
  } catch (error) {
    if (error instanceof RuntimeReleaseUnavailableError) {
      return json({ error: "runtime_release_inactive" }, 503);
    }
    if (error instanceof ServiceRestError && (error.code === "BLR02" || error.code === "BLR03")) {
      return json({ error: "runtime_release_inactive" }, 503);
    }
    if (error instanceof SyntaxError) return json({ error: "invalid_json" }, 400);
    const message = error instanceof Error ? error.message : String(error);
    console.error("execution_worker_failed", { message });
    return json({ error: "internal_error" }, 500);
  }
});
