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
  | { kind: "failed"; data: StatusResponse; error: string };

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
 * Poll the unified status endpoint until the request reaches a terminal state.
 * Throws VerselyTimeoutError on timeout. Network/API errors propagate from the client.
 */
export async function pollStatus(
  client: VerselyClient,
  requestId: string,
  opts: PollOptions,
): Promise<PollOutcome> {
  if (!requestId) throw new Error("pollStatus requires a non-empty requestId");
  const deadline = Date.now() + opts.timeoutMs;
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

    const data = await client.get<StatusResponse>(
      `/api/v1/status/${encodeURIComponent(requestId)}`,
      { retry: true, timeoutMs: 30_000 },
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
      throw new VerselyTimeoutError(
        `Timed out after ${opts.timeoutMs}ms waiting on request ${requestId} (last status: "${state ?? "unknown"}"). Re-run with mode: "submit" to fire-and-forget, or call versely_get_task_status later.`,
        requestId,
        state,
      );
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
