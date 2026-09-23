// Per-profile shaping of what goes IN to a tool (arguments, advertised input
// schema) and what comes OUT of it (the result). server.ts applies these; the
// tool handlers themselves stay profile-agnostic unless they carry a variant.

import type { ToolResult } from "./_types.js";

type Json = Record<string, unknown>;

// --- Arguments -----------------------------------------------------------------

/**
 * Provider safety switches. No caller — model, user or plugin — gets to turn a
 * provider's content filter down through this server, so these are removed at
 * any depth before a handler (or a .passthrough() schema) can forward them.
 * The backend enforces the same floor independently.
 */
export const SAFETY_KEYS: ReadonlySet<string> = new Set([
  "enable_safety_checker",
  "disable_safety_checker",
  "safety_tolerance",
  "safety_filter_level",
  "moderation",
  "person_generation",
]);

export function stripSafetyKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSafetyKeys);
  if (value && typeof value === "object") {
    const out: Json = {};
    for (const [k, v] of Object.entries(value as Json)) {
      if (SAFETY_KEYS.has(k)) continue;
      out[k] = stripSafetyKeys(v);
    }
    return out;
  }
  return value;
}

export function omitKeys(obj: Json, keys: ReadonlySet<string>): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(obj)) if (!keys.has(k)) out[k] = v;
  return out;
}

/**
 * Inputs the openai profile never advertises and strips from every call:
 * `mode` / `poll_*` (ChatGPT cuts calls at ~60s, so blocking "wait" mode is
 * never offered — every job submits and the card polls) and `user_id` (the
 * account is always the caller's own).
 */
export const OPENAI_STRIPPED_INPUTS: readonly string[] = [
  "mode",
  "poll_timeout_ms",
  "poll_interval_ms",
  "user_id",
];

export const CONFIRM_REPEAT_KEY = "confirm_repeat";

export const CONFIRM_REPEAT_DESCRIPTION =
  "Leave unset. Set true only when the user explicitly asks for another copy of a request made in the " +
  "last few minutes; otherwise an identical request returns the earlier job instead of charging twice.";

// --- Advertised input schema (JSON Schema from zod-to-json-schema) ------------

export function hideProperties(schema: Json, keys: Iterable<string>): void {
  const props = schema.properties as Record<string, unknown> | undefined;
  if (!props) return;
  const drop = new Set(keys);
  for (const k of drop) delete props[k];
  if (Array.isArray(schema.required)) {
    const req = (schema.required as string[]).filter((k) => !drop.has(k));
    if (req.length > 0) schema.required = req;
    else delete schema.required;
  }
}

/**
 * Remove every property whose description starts with "Deprecated" — at any
 * depth — so legacy aliases (kept working for old callers) aren't offered to
 * a model meeting the schema for the first time.
 */
export function dropDeprecatedProperties(node: unknown): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) dropDeprecatedProperties(n);
    return;
  }
  const obj = node as Json;
  const props = obj.properties as Record<string, unknown> | undefined;
  if (props) {
    const deprecated = Object.entries(props)
      .filter(([, v]) => {
        const d = (v as Json | null)?.description;
        return typeof d === "string" && /^deprecated\b/i.test(d.trim());
      })
      .map(([k]) => k);
    hideProperties(obj, deprecated);
    for (const v of Object.values(props)) dropDeprecatedProperties(v);
  }
  for (const key of ["items", "anyOf", "oneOf", "allOf", "additionalProperties"]) {
    const child = obj[key];
    if (child && typeof child === "object") dropDeprecatedProperties(child);
  }
}

/**
 * Replace property descriptions by path: "model", or "scenes[].model" for a
 * property of an array's items. Throws on a path that doesn't exist, so a
 * renamed field can't silently leave a stale description behind — this runs
 * when the per-profile catalog is built, i.e. at startup.
 */
export function applyParamDescriptions(
  schema: Json,
  overrides: Readonly<Record<string, string>> | undefined,
  toolName: string,
): void {
  if (!overrides) return;
  for (const [path, description] of Object.entries(overrides)) {
    let node: Json | undefined = schema;
    for (const rawSeg of path.split(".")) {
      const isArray = rawSeg.endsWith("[]");
      const seg = isArray ? rawSeg.slice(0, -2) : rawSeg;
      const props = node?.properties as Record<string, Json> | undefined;
      node = props?.[seg];
      if (node && isArray) node = node.items as Json | undefined;
    }
    if (!node) {
      throw new Error(`${toolName}: description override for unknown input "${path}"`);
    }
    node.description = description;
  }
}

export function injectConfirmRepeat(schema: Json): void {
  const props = (schema.properties ?? (schema.properties = {})) as Json;
  props[CONFIRM_REPEAT_KEY] = { type: "boolean", description: CONFIRM_REPEAT_DESCRIPTION };
}

// --- Results -----------------------------------------------------------------

/** Result `_meta` key the media card merges under structuredContent. */
export const CARD_META_KEY = "studio.versely/card";

/**
 * What stays in structuredContent for the openai profile. ChatGPT shows
 * structuredContent to the MODEL as well as the card, so it carries only what
 * the model needs to talk about the job; everything else the card uses (raw
 * provider payloads, echoed tool args, per-scene counters) moves to result
 * `_meta`, which only the card sees.
 */
const MODEL_VISIBLE_CARD_KEYS: ReadonlySet<string> = new Set([
  "kind",
  "assets",
  "status",
  "poll",
  "task_id",
  "model",
  "prompt",
  "aspect_ratio",
  "duration_seconds",
  // Small and user-facing: the card's failed/info text and progress bar.
  "error",
  "message",
  "progress",
]);

const INLINE_PREVIEW_NOTE = /^\(\d+ of \d+ images? not shown inline/;

export function shapeResultForOpenai(result: ToolResult): ToolResult {
  // No inline base64 previews: the card shows the media, and multi-MB image
  // blocks are exactly what makes a host reject a response.
  const content = result.content.filter(
    (b) => b.type !== "image" && !(b.type === "text" && INLINE_PREVIEW_NOTE.test(b.text)),
  );
  const out: ToolResult = {
    ...result,
    content: content.length > 0 ? content : [{ type: "text", text: "Done." }],
  };
  if (result.structuredContent) {
    const visible: Json = {};
    const cardOnly: Json = {};
    for (const [k, v] of Object.entries(result.structuredContent)) {
      (MODEL_VISIBLE_CARD_KEYS.has(k) ? visible : cardOnly)[k] = v;
    }
    out.structuredContent = visible;
    if (Object.keys(cardOnly).length > 0) {
      out._meta = { ...(result._meta ?? {}), [CARD_META_KEY]: cardOnly };
    }
  }
  return out;
}

/**
 * A tool that declares the media card MUST hand it some state: a result with
 * no structuredContent leaves the card on its "Preparing preview…" placeholder
 * forever (the host renders the card for every result of such a tool, errors
 * included). Give it a terminal state instead — the error, or a plain
 * informational line pointing at the reply text.
 */
export function applyCardSafetyNet(result: ToolResult): ToolResult {
  if (result.structuredContent) return result;
  const firstText = result.content.find((b) => b.type === "text");
  const text = firstText && firstText.type === "text" ? firstText.text.trim() : "";
  if (result.isError) {
    const message = truncate(text || "The request failed.", 500);
    return {
      ...result,
      structuredContent: { kind: "gallery", assets: [], status: "failed", error: message, message },
    };
  }
  const message = !text || looksLikeJson(text)
    ? "Done. The details are in the reply."
    : truncate(text, 500);
  return {
    ...result,
    structuredContent: { kind: "gallery", assets: [], status: "info", message },
  };
}

function looksLikeJson(s: string): boolean {
  const t = s.trimStart();
  return t.startsWith("{") || t.startsWith("[");
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
