export class VerselyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerselyConfigError";
  }
}

/**
 * Refusals the backend returns for ChatGPT-plugin requests from accounts on
 * the free plugin allowance (cross-repo contract 4). Their bodies are
 * `{ success: false, error: <code>, message, plugin: PluginBlock }`.
 */
export type PluginErrorCode =
  | "plugin_free_feature_blocked"
  | "plugin_free_runpod_only"
  | "plugin_allowance_exhausted";

const PLUGIN_ERROR_CODES: ReadonlySet<string> = new Set<PluginErrorCode>([
  "plugin_free_feature_blocked",
  "plugin_free_runpod_only",
  "plugin_allowance_exhausted",
]);

export type ApiErrorCode = PluginErrorCode | "insufficient_credits";

export class VerselyApiError extends Error {
  public readonly status: number;
  public readonly method: string;
  public readonly path: string;
  public readonly body: unknown;
  public readonly requestId?: string;
  /** Set when the refusal was recognised as a credit / plugin-allowance one. */
  public readonly code?: ApiErrorCode;

  constructor(args: {
    status: number;
    method: string;
    path: string;
    body: unknown;
    requestId?: string;
  }) {
    const built = buildApiErrorMessage(args);
    super(built.message);
    this.name = "VerselyApiError";
    this.status = args.status;
    this.method = args.method;
    this.path = args.path;
    this.body = args.body;
    this.requestId = args.requestId;
    this.code = built.code;
  }
}

export class VerselyNetworkError extends Error {
  public override readonly cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "VerselyNetworkError";
    this.cause = cause;
  }
}

export class VerselyTimeoutError extends Error {
  public readonly requestId: string;
  public readonly lastStatus?: string;
  constructor(message: string, requestId: string, lastStatus?: string) {
    super(message);
    this.name = "VerselyTimeoutError";
    this.requestId = requestId;
    this.lastStatus = lastStatus;
  }
}

// --- Credit wording ------------------------------------------------------------
// These texts reach end users verbatim (the model usually relays them), and on
// ChatGPT they are held to OpenAI's plugin rules: no checkout links, no "top
// up", no upgrade nudges. So a credit refusal says what happened and where the
// balance can be read — nothing else. The backend's own wording is NOT
// appended here, because some of it predates those rules ("Add credits to keep
// going"); the plugin codes below are the exception, since contract 4 makes
// their message plain and informational by construction.

export const CREDIT_BALANCE_HINT = "Current balance is available via versely_get_credits.";

export function notEnoughCreditsMessage(needed?: number): string {
  const need = needed !== undefined ? ` (needs ${formatCredits(needed)})` : "";
  return `Not enough Versely credits for this${need}. ${CREDIT_BALANCE_HINT}`;
}

const PLUGIN_FALLBACK_MESSAGE: Record<PluginErrorCode, string> = {
  plugin_free_feature_blocked:
    "This feature is not available with free plugin credits. Free plugin credits cover image, video and voiceover generation with the models listed by versely_find_models. Nothing was charged.",
  plugin_free_runpod_only:
    "Free plugin credits only work with the models listed by versely_find_models. Nothing was charged.",
  plugin_allowance_exhausted:
    "There are not enough free plugin credits left for this request. Nothing was charged.",
};

function buildApiErrorMessage(args: {
  status: number;
  method: string;
  path: string;
  body: unknown;
}): { message: string; code?: ApiErrorCode } {
  const obj = asRecord(args.body);

  if (args.status === 402 || args.status === 403) {
    const pluginCode = pluginCodeOf(obj);
    if (pluginCode) return { message: pluginMessage(pluginCode, obj), code: pluginCode };
    // 402 is always a credit refusal. The credit middleware answers a
    // zero-balance account with 403 "Insufficient credits" — which the old
    // wording blamed on the API key's scopes, sending OAuth users (who have no
    // key) hunting for a setting that doesn't exist.
    if (args.status === 402 || isCreditRefusal(args.body)) {
      return { message: notEnoughCreditsMessage(creditsNeeded(obj)), code: "insufficient_credits" };
    }
  }

  const detail = extractDetail(args.body);
  const tag = `${args.method} ${args.path} -> HTTP ${args.status}`;
  switch (args.status) {
    case 401:
      // Callers are OAuth connectors (claude.ai, ChatGPT) as often as vsk_ key
      // holders, and only the latter have a key to "check".
      return {
        message: `${tag}: authentication failed - Versely did not accept this connection's sign-in. Reconnect Versely (or, with an API key, check it has not been revoked).${suffix(detail)}`,
      };
    case 403:
      return {
        message: `${tag}: not allowed - this Versely account or connection does not have access to that.${suffix(detail)}`,
      };
    case 404:
      return { message: `${tag}: resource not found.${suffix(detail)}` };
    case 422:
      return { message: `${tag}: validation error. Inspect the request body.${suffix(detail)}` };
    case 429:
      return { message: `${tag}: rate limited. Back off before retrying.${suffix(detail)}` };
    default:
      if (args.status >= 500) {
        return { message: `${tag}: server error.${suffix(detail)}` };
      }
      return { message: `${tag}.${suffix(detail)}` };
  }
}

function pluginCodeOf(obj: Record<string, unknown> | null): PluginErrorCode | undefined {
  if (!obj) return undefined;
  for (const key of ["error", "code"]) {
    const v = obj[key];
    if (typeof v === "string" && PLUGIN_ERROR_CODES.has(v)) return v as PluginErrorCode;
  }
  return undefined;
}

function pluginMessage(code: PluginErrorCode, obj: Record<string, unknown> | null): string {
  const raw = obj && typeof obj.message === "string" ? stripUrls(obj.message) : "";
  let text = raw ? ensureSentence(raw) : PLUGIN_FALLBACK_MESSAGE[code];
  const plugin = obj ? asRecord(obj.plugin) : null;
  const remaining = plugin?.free_credits_remaining;
  if (typeof remaining === "number" && Number.isFinite(remaining)) {
    text += ` Free plugin credits remaining: ${formatCredits(remaining)}.`;
  }
  if (code === "plugin_free_runpod_only" && raw && !/versely_find_models/.test(text)) {
    text += " Use a model listed by versely_find_models.";
  }
  return text;
}

function isCreditRefusal(body: unknown): boolean {
  const texts: string[] = [];
  if (typeof body === "string") texts.push(body);
  const obj = asRecord(body);
  if (obj) {
    for (const key of ["error", "message", "code", "details"]) {
      const v = obj[key];
      if (typeof v === "string") texts.push(v);
    }
    // "Your free planning preview has been used. Add credits to keep going."
    if (obj.code === "free_plan_used") return true;
  }
  return texts.some((t) => /insufficient credits|not enough credits/i.test(t));
}

/** How many credits the refused request needed, when the backend said. */
function creditsNeeded(obj: Record<string, unknown> | null): number | undefined {
  if (!obj) return undefined;
  const sources = [obj, asRecord(obj.data), asRecord(obj.details)];
  for (const src of sources) {
    if (!src) continue;
    for (const key of ["credits_required", "required_credits", "credits_needed", "creditsRequired", "required", "needed"]) {
      const v = src[key];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
    }
  }
  return undefined;
}

function formatCredits(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
}

/**
 * Drop every sentence that carries a link. Belt and braces: contract 4 says
 * these messages hold no URLs, but a link that did slip through would be a
 * checkout pointer in front of a ChatGPT user, and removing just the URL
 * leaves a dangling "See for details." behind.
 */
function stripUrls(s: string): string {
  const URL_RX = /\bhttps?:\/\/\S+|\bwww\.\S+/i;
  return s
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !URL_RX.test(sentence))
    .join(" ")
    .trim();
}

function ensureSentence(s: string): string {
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function suffix(detail: string | undefined): string {
  return detail ? ` Detail: ${detail}` : "";
}

function extractDetail(body: unknown): string | undefined {
  if (!body) return undefined;
  if (typeof body === "string") {
    const trimmed = body.trim();
    return trimmed ? truncate(trimmed) : undefined;
  }
  if (typeof body !== "object") return undefined;
  const obj = body as Record<string, unknown>;
  for (const key of ["message", "error", "detail", "details", "msg"]) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return truncate(v.trim());
    if (v && typeof v === "object") {
      const inner = (v as Record<string, unknown>)["message"];
      if (typeof inner === "string" && inner.trim()) return truncate(inner.trim());
    }
  }
  return undefined;
}

function truncate(s: string, max = 400): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
