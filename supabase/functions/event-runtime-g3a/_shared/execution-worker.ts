import type { ServiceRestClient } from "./server-runtime.ts";

type JsonObject = Record<string, unknown>;

const FINISH_RESERVE_MS = 7_000;
const MIN_NEW_JOB_BUDGET_MS = 8_000;

interface ClaimedExecution {
  execution_id: string;
  idempotency_key: string;
  workspace_id: string;
  event_id: string;
  execution_target: "server";
  action_type: string;
  action_params: JsonObject;
  timeout_ms: number;
  attempt_no: number;
  max_attempts: number;
  retry_backoff_seconds: number;
  lease_expires_at: string;
}

interface FinishedExecution {
  execution_id: string;
  status: "retry_scheduled" | "succeeded" | "failed" | "cancelled";
  attempt_no: number;
  next_attempt_at: string;
  terminal: boolean;
}

interface ActionOutcome {
  succeeded: boolean;
  retryable: boolean;
  result: JsonObject | null;
  error: string | null;
}

export interface QueueProcessOptions {
  workerId: string;
  maxJobs?: number;
  leaseSeconds?: number;
  heartbeatIntervalMs?: number;
  maxRunTimeMs?: number;
  executionIds?: string[];
  rpcContext: Record<string, string>;
}

export interface QueueProcessResult {
  executionId: string;
  idempotencyKey: string;
  attemptNo: number;
  status: FinishedExecution["status"];
  nextAttemptAt: string;
  terminal: boolean;
  error?: string;
}

function integerParam(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

class ExecutionTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`execution timed out after ${timeoutMs}ms`);
    this.name = "ExecutionTimeoutError";
  }
}

class LeaseHeartbeatError extends Error {
  constructor(message: string) {
    super(`execution lease heartbeat failed: ${message}`);
    this.name = "LeaseHeartbeatError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("execution aborted");
}

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function executeAction(
  _rest: ServiceRestClient,
  execution: ClaimedExecution,
  signal: AbortSignal
): Promise<ActionOutcome> {
  if (signal.aborted) throw abortReason(signal);

  if (execution.action_type === "log") {
    const result = { message: String(execution.action_params?.label ?? "event matched") };
    console.log("byeollog_log_action", {
      executionId: execution.execution_id,
      idempotencyKey: execution.idempotency_key,
      eventId: execution.event_id,
      attemptNo: execution.attempt_no,
      result
    });
    return { succeeded: true, retryable: false, result, error: null };
  }

  return {
    succeeded: false,
    retryable: false,
    result: null,
    error: `unsupported action type: ${execution.action_type}`
  };
}

function effectiveLeaseSeconds(execution: ClaimedExecution, requestedLeaseSeconds: number): number {
  return Math.min(600, Math.max(requestedLeaseSeconds, Math.ceil(execution.timeout_ms / 1000) + 15));
}

async function executeWithGuards(
  rest: ServiceRestClient,
  execution: ClaimedExecution,
  options: QueueProcessOptions,
  requestedLeaseSeconds: number,
  remainingBudgetMs: number
): Promise<ActionOutcome> {
  const actionController = new AbortController();
  const heartbeatStopController = new AbortController();
  const leaseSeconds = effectiveLeaseSeconds(execution, requestedLeaseSeconds);
  const defaultHeartbeatMs = Math.min(10000, Math.max(1000, Math.floor(leaseSeconds * 1000 / 3)));
  const heartbeatIntervalMs = integerParam(
    options.heartbeatIntervalMs,
    defaultHeartbeatMs,
    10,
    Math.max(10, leaseSeconds * 1000 - 250)
  );
  const actionTimeoutMs = Math.max(1, Math.min(execution.timeout_ms, remainingBudgetMs));
  let timeoutFired = false;
  let rejectHeartbeat!: (error: LeaseHeartbeatError) => void;

  const heartbeatFailure = new Promise<never>((_resolve, reject) => {
    rejectHeartbeat = reject;
  });
  const heartbeatTask = (async () => {
    try {
      while (!heartbeatStopController.signal.aborted) {
        await waitFor(heartbeatIntervalMs, heartbeatStopController.signal);
        if (heartbeatStopController.signal.aborted) return;
        await rest<string>("rpc/g3a_renew_execution_v1", {
          method: "POST",
          body: JSON.stringify({
            p_workspace_id: execution.workspace_id,
            p_execution_id: execution.execution_id,
            p_worker_id: options.workerId,
            p_attempt_no: execution.attempt_no,
            p_lease_seconds: leaseSeconds,
            p_agent_device_id: null,
            p_agent_secret_hash: null,
            ...options.rpcContext
          })
        });
      }
    } catch (error) {
      if (heartbeatStopController.signal.aborted) return;
      const heartbeatError = new LeaseHeartbeatError(errorMessage(error));
      actionController.abort(heartbeatError);
      rejectHeartbeat(heartbeatError);
    }
  })();

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutFailure = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      timeoutFired = true;
      const error = new ExecutionTimeoutError(actionTimeoutMs);
      actionController.abort(error);
      reject(error);
    }, actionTimeoutMs);
  });

  try {
    return await Promise.race([
      executeAction(rest, execution, actionController.signal),
      timeoutFailure,
      heartbeatFailure
    ]);
  } catch (error) {
    if (timeoutFired) {
      return {
        succeeded: false,
        retryable: true,
        result: null,
        error: `execution timed out after ${actionTimeoutMs}ms`
      };
    }
    if (actionController.signal.reason instanceof LeaseHeartbeatError) {
      return {
        succeeded: false,
        retryable: true,
        result: null,
        error: actionController.signal.reason.message
      };
    }
    return {
      succeeded: false,
      retryable: true,
      result: null,
      error: errorMessage(error)
    };
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    heartbeatStopController.abort(new Error("execution finished"));
    await heartbeatTask;
  }
}

export async function processExecutionQueue(
  rest: ServiceRestClient,
  workspaceId: string,
  options: QueueProcessOptions
): Promise<QueueProcessResult[]> {
  const maxJobs = integerParam(options.maxJobs, 10, 1, 20);
  const leaseSeconds = integerParam(options.leaseSeconds, 30, 5, 600);
  const maxRunTimeMs = integerParam(options.maxRunTimeMs, 120000, 250, 120000);
  const deadline = Date.now() + maxRunTimeMs;
  const results: QueueProcessResult[] = [];

  for (let index = 0; index < maxJobs; index += 1) {
    if (deadline - Date.now() < MIN_NEW_JOB_BUDGET_MS) break;
    const claimed = await rest<ClaimedExecution[]>("rpc/g3a_claim_execution_v1", {
      method: "POST",
      body: JSON.stringify({
        p_workspace_id: workspaceId,
        p_worker_id: options.workerId,
        p_lease_seconds: leaseSeconds,
        p_execution_ids: options.executionIds?.length ? options.executionIds : null,
        p_execution_target: "server",
        p_agent_device_id: null,
        p_agent_secret_hash: null,
        p_supported_action_types: null,
        ...options.rpcContext
      })
    });
    const execution = claimed[0];
    if (!execution) break;

    // Claim can consume most of the caller's remaining budget. Reserve enough
    // time for the durable finish RPC. A claimed-but-not-started job is
    // finished retryable; G3A server execution supports only a diagnostic log.
    const actionBudgetMs = deadline - Date.now() - FINISH_RESERVE_MS;
    const outcome: ActionOutcome = actionBudgetMs <= 0
      ? {
        succeeded: false,
        retryable: true,
        result: null,
        error: `execution deferred before side effect: insufficient action budget (${Math.max(0, actionBudgetMs)}ms)`
      }
      : await executeWithGuards(
        rest,
        execution,
        options,
        leaseSeconds,
        actionBudgetMs
      );

    const finished = await rest<FinishedExecution[]>("rpc/g3a_finish_execution_v1", {
      method: "POST",
      body: JSON.stringify({
        p_workspace_id: execution.workspace_id,
        p_execution_id: execution.execution_id,
        p_worker_id: options.workerId,
        p_attempt_no: execution.attempt_no,
        p_succeeded: outcome.succeeded,
        p_result: outcome.result,
        p_error: outcome.error,
        p_retryable: outcome.retryable,
        p_agent_device_id: null,
        p_agent_secret_hash: null,
        ...options.rpcContext
      })
    });
    if (!finished[0]) throw new Error("Execution finish result was empty");

    results.push({
      executionId: finished[0].execution_id,
      idempotencyKey: execution.idempotency_key,
      attemptNo: finished[0].attempt_no,
      status: finished[0].status,
      nextAttemptAt: finished[0].next_attempt_at,
      terminal: finished[0].terminal,
      ...(outcome.error ? { error: outcome.error } : {})
    });
  }

  return results;
}

