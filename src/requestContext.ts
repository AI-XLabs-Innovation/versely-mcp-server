import { AsyncLocalStorage } from "node:async_hooks";
import type { Profile } from "./profiles.js";

/**
 * Per-tools/call context, carried implicitly through every await below the
 * handler so deep helpers (the HTTP client building backend headers,
 * mediaResult deciding whether to inline images) can read it without threading
 * a parameter through ~90 tool handlers.
 *
 * Session-mode servers reuse one VerselyClient across many calls, so anything
 * call-specific (ChatGPT's per-user subject) MUST come from here, never from
 * client state.
 */
export interface CallContext {
  profile: Profile;
  /**
   * ChatGPT's anonymised user id, from the tools/call request's
   * params._meta["openai/subject"]. Forwarded to the backend (signed) as
   * X-Versely-OpenAI-Subject for the plugin allowance's once-per-person rule.
   */
  subject?: string;
}

const storage = new AsyncLocalStorage<CallContext>();

export function runWithCallContext<T>(ctx: CallContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentCallContext(): CallContext | undefined {
  return storage.getStore();
}

/** Longest subject accepted — mirrors the backend verifier's MAX_SUBJECT_LEN. */
export const MAX_SUBJECT_LEN = 256;

/**
 * Pull `openai/subject` out of a request's `_meta`. Only a non-empty string of
 * at most 256 characters counts; anything else is treated as absent (contract 2).
 */
export function subjectFromMeta(meta: unknown): string | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const v = (meta as Record<string, unknown>)["openai/subject"];
  if (typeof v !== "string" || v.length === 0 || v.length > MAX_SUBJECT_LEN) return undefined;
  return v;
}
