import type { VerselyClient } from "./client.js";
import { VerselyTimeoutError } from "./errors.js";

export interface StatusResponse {
  status?: string;
  state?: string;
  result?: unknown;
  result_url?: string;
  output?: unknown;
  output_url?: string;
  error?: unknown;
  message?: string;
  [key: string]: unknown;
}

export interface PollOptions {
  /** Hard cap for total poll wait. */
  timeoutMs: number;
  /** Initial delay between polls. Backoff scales it up to 2x. */
  intervalMs: number;
  /** Cancel the poll cooperatively. */
  signal?: AbortSignal;
}

export type PollOutcome =
  | { kind: "completed"; data: StatusResponse }
  | { kind: "failed"; data: StatusResponse; error: string }
  /**
   * Ran out of blocking budget while the job was still going. NOT an error —
   * the job is fine, we just stopped waiting. Callers should surface it as
   * "still running, check again".
   */
  | { kind: "timeout"; lastState?: string; waitedMs: number };

/**
 * Cloudflare fronts mcp.versely.studio and severs any proxied request at ~100s
 * with a 524. That failure is invisible to us and lands in the client as
 * "Unable to reach versely-mcp" — i.e. a single slow poll makes the entire MCP
 * server look down, and the model retries, and every retry burns another 100s
 * the same way.
 *
 * So a blocking poll must finish comfortably under the proxy's ceiling and
 * hand back a "still running" result the model can act on. Anything longer has
 * to go through repeated versely_get_task_status calls instead — each one a
 * fast round-trip that the proxy never sees as slow.
 */
export const PROXY_HARD_LIMIT_MS = 100_000;

/** Blocking budget. Leaves room for the in-flight status GET plus the response. */
export const MAX_BLOCKING_POLL_MS = 70_000;

const TERMINAL_OK = new Set([
  "completed",
  "complete",
  "succeeded",
  "success",
  "done",
  "ready",
  "finished",
]);

const TERMINAL_FAIL = new Set([
  "failed",
  "failure",
  "error",
  "errored",
  "cancelled",
  "canceled",
  "rejected",
]);

/**
 * Poll the unified status endpoint until the request reaches a terminal state
 * or the blocking budget runs out. Returns `timeout` rather than throwing —
 * see PollOutcome. Network/API errors propagate from the client.
 *
 * The caller's timeoutMs is CLAMPED to MAX_BLOCKING_POLL_MS. Honouring a larger
 * value would just hand the request to Cloudflare's 524 instead, which loses
 * the request_id and tells the user the server is unreachable.
 */
export async function pollStatus(
  client: VerselyClient,
  requestId: string,
  opts: PollOptions,
): Promise<PollOutcome> {
  if (!requestId) throw new Error("pollStatus requires a non-empty requestId");
  const start = Date.now();
  const budgetMs = Math.min(opts.timeoutMs, MAX_BLOCKING_POLL_MS);
  const deadline = start + budgetMs;
  let interval = opts.intervalMs;
  let lastState: string | undefined;

  while (true) {
    if (opts.signal?.aborted) {
      throw new VerselyTimeoutError(
        `Polling for request ${requestId} was aborted (last status: "${lastState ?? "unknown"}").`,
        requestId,
        lastState,
      );
    }

    // Bound each status GET by what's left of the budget. A flat 30s here could
    // start at t=69s and land at t=99s, overshooting the proxy limit the budget
    // exists to stay under.
    const perRequestMs = Math.max(5_000, Math.min(20_000, deadline - Date.now()));
    const data = await client.get<StatusResponse>(
      `/api/v1/status/${encodeURIComponent(requestId)}`,
      { retry: true, timeoutMs: perRequestMs },
    );

    const state = readState(data);
    lastState = state;

    if (state && TERMINAL_OK.has(state)) {
      return { kind: "completed", data };
    }
    if (state && TERMINAL_FAIL.has(state)) {
      return {
        kind: "failed",
        data,
        error: pickErrorMessage(data) ?? `Generation failed with status "${state}"`,
      };
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      // Deliberately not an error: the generation is still running and still
      // paid for. Throwing here used to surface as a failed tool call, which
      // reads as "the generation broke" when nothing broke at all.
      return { kind: "timeout", lastState: state, waitedMs: Date.now() - start };
    }

    await sleep(Math.min(interval, remaining), opts.signal);
    interval = Math.min(interval * 1.5, opts.intervalMs * 4);
  }
}

function readState(data: StatusResponse): string | undefined {
  const raw = data.status ?? data.state;
  if (typeof raw !== "string") return undefined;
  return raw.trim().toLowerCase();
}

function pickErrorMessage(data: StatusResponse): string | undefined {
  if (typeof data.error === "string" && data.error.trim()) return data.error.trim();
  if (data.error && typeof data.error === "object") {
    const msg = (data.error as Record<string, unknown>)["message"];
    if (typeof msg === "string" && msg.trim()) return msg.trim();
  }
  if (typeof data.message === "string" && data.message.trim()) return data.message.trim();
  return undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new Error("Aborted"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
