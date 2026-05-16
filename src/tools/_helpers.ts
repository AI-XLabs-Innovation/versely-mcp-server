import { fetch } from "undici";
import type { ContentBlock, ToolContext, ToolResult } from "./_types.js";
import {
  VerselyApiError,
  VerselyConfigError,
  VerselyNetworkError,
  VerselyTimeoutError,
} from "../errors.js";
import {
  buildMediaCardPayload,
  type MediaKind as UiMediaKind,
  type UiAsset,
} from "../ui/templates.js";

export function jsonResult(value: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function errorResult(message: string): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

// --- Media preview helpers ---------------------------------------------------
// Tool results that contain asset URLs (image/video/audio) emit
// `structuredContent` shaped to the linked MCP Apps (SEP-1865) UI template.
// MCP Apps-capable hosts render the bound `ui://` iframe and hydrate it with
// that payload. Non-MCP-Apps clients fall back to the plain-text `content`
// summary, which includes asset URLs so the conversation still reads well.

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "svg",
  "bmp",
  "avif",
]);
const VIDEO_EXTS = new Set(["mp4", "mov", "webm", "m4v", "mkv"]);
// `mpeg` is what the backend's downloadAndUploadToStorage derives from the
// `audio/mpeg` Content-Type when re-hosting Minimax/RunPod MP3 outputs.
// Without it in the set, completed TTS jobs return URLs that don't get
// recognized as audio assets and the iframe stays in pending forever even
// though the file is fully generated and uploaded.
const AUDIO_EXTS = new Set([
  "mp3", "wav", "m4a", "ogg", "oga", "flac", "aac", "mpeg", "mpga", "opus", "weba",
]);

export type MediaKind = "image" | "video" | "audio";

interface MediaAsset {
  url: string;
  kind: MediaKind;
}

export function inferMediaKind(url: string): MediaKind | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const ext = pathname.match(/\.([a-zA-Z0-9]+)$/)?.[1]?.toLowerCase();
  if (!ext) return null;
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  return null;
}

function filenameOf(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] || u.hostname;
  } catch {
    return url;
  }
}

// Recursively walk an arbitrary payload collecting media asset URLs in
// traversal order. Deduplicates by URL so the same asset surfacing under
// multiple keys (e.g. `result_url` + `output[0].url`) only renders once.
export function extractMediaAssets(payload: unknown): MediaAsset[] {
  const seen = new Set<string>();
  const out: MediaAsset[] = [];
  const walk = (v: unknown): void => {
    if (v == null) return;
    if (typeof v === "string") {
      const kind = inferMediaKind(v);
      if (kind && !seen.has(v)) {
        seen.add(v);
        out.push({ url: v, kind });
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    if (typeof v === "object") {
      for (const value of Object.values(v as Record<string, unknown>)) walk(value);
    }
  };
  walk(payload);
  return out;
}

// Pick the asset-kind discriminator for the media card when one isn't passed
// explicitly. Single-kind lists map directly; multi-kind or multi-video lists
// fall through to "gallery" (the card auto-detects video vs image by URL).
function inferKind(assets: MediaAsset[]): UiMediaKind {
  const kinds = new Set(assets.map((a) => a.kind));
  if (kinds.size > 1) return "gallery";
  const [only] = kinds;
  if (only === "image") return assets.length === 1 ? "image" : "gallery";
  if (only === "audio") return "audio";
  return assets.length === 1 ? "video" : "gallery";
}

function summarizeAssets(assets: MediaAsset[], summary?: string): string {
  if (assets.length === 0) return summary ?? "Done.";
  const kinds = new Set(assets.map((a) => a.kind));
  const headline =
    summary ??
    (kinds.size === 1
      ? `Generated ${assets.length} ${[...kinds][0]}${assets.length === 1 ? "" : "s"}.`
      : `Generated ${assets.length} assets.`);
  // Include URLs in plain text so non-MCP-Apps hosts (Cursor, mobile claude.ai
  // when the iframe fails, older Desktop) still surface the asset usefully.
  const urls = assets.map((a) => a.url).join("\n");
  return `${headline}\n${urls}`;
}

export interface MediaResultOpts {
  /**
   * Asset-kind discriminator the media card uses to pick its render path.
   * Inferred from the asset URLs if omitted.
   */
  kind?: UiMediaKind;
  /** Plain-text headline; overrides the auto "Generated N images." summary. */
  summary?: string;
  /**
   * Name of the tool that produced this result. Surfaced as
   * `structuredContent.toolName` so the card's Recreate button can call
   * back via `tools/call` with the same args.
   */
  toolName?: string;
  /**
   * Arguments to pass to the Recreate call. Should match the original
   * tool input so "Recreate" produces a parallel generation.
   */
  toolArgs?: Record<string, unknown>;
  /**
   * Extra fields merged into `structuredContent` (echoed `model` / `prompt`
   * / `seed` / `request_id`). Used by the card's chips and prompt header,
   * and by non-MCP-Apps clients that consume structuredContent directly.
   */
  extra?: Record<string, unknown>;
}

// --- Inline image previews ---------------------------------------------------
// MCP `type: "image"` content blocks let the LLM actually see the generated
// pixels (vs. just reading the URL). claude.ai shows these inside the tool
// accordion, so they're a redundancy layer when the MCP Apps iframe fails
// (mobile bug, CSP block, non-Apps host) and a real reasoning input when the
// next turn asks the model to compare or describe the result.
//
// Costs: each base64-image expands ~33% over raw bytes and bills as image
// tokens (~1.6K per image at default detail). Capped + bounded + opt-out-able.

const INLINE_PREVIEW_ENABLED =
  (process.env.VERSELY_INLINE_IMAGE_PREVIEW ?? "true").toLowerCase() !== "false";
const MAX_INLINE_IMAGES = 4;
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
const INLINE_FETCH_TIMEOUT_MS = 8_000;

async function fetchImageAsBase64(
  url: string,
): Promise<{ data: string; mimeType: string } | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(INLINE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
    if (!contentType.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_INLINE_IMAGE_BYTES) return null;
    return { data: buf.toString("base64"), mimeType: contentType };
  } catch {
    // Network error, timeout, CSP, signed-URL expiry — degrade gracefully.
    return null;
  }
}

/**
 * Build a tool result whose `structuredContent` hydrates an MCP Apps iframe,
 * with a plain-text `content` block for hosts that don't render inline.
 * When the result contains images and inline previews are enabled, also
 * fetches up to `MAX_INLINE_IMAGES` and emits MCP `type: "image"` blocks.
 * Falls back to a JSON result when no asset URLs are detected.
 */
export async function mediaResult(
  payload: unknown,
  opts: MediaResultOpts = {},
): Promise<ToolResult> {
  const assets = extractMediaAssets(payload);
  if (assets.length === 0) return jsonResult(payload);

  const kind = opts.kind ?? inferKind(assets);
  const uiAssets: UiAsset[] = assets.map((a) => ({
    url: a.url,
    label: filenameOf(a.url),
  }));
  const structuredContent = buildMediaCardPayload(kind, uiAssets, {
    ...(opts.extra ?? {}),
    ...(opts.toolName ? { toolName: opts.toolName } : {}),
    ...(opts.toolArgs ? { toolArgs: opts.toolArgs } : {}),
  });

  const content: ContentBlock[] = [
    { type: "text", text: summarizeAssets(assets, opts.summary) },
  ];

  if (INLINE_PREVIEW_ENABLED) {
    const imageUrls = assets
      .filter((a) => a.kind === "image")
      .slice(0, MAX_INLINE_IMAGES)
      .map((a) => a.url);
    if (imageUrls.length > 0) {
      const fetched = await Promise.all(imageUrls.map(fetchImageAsBase64));
      for (const img of fetched) {
        if (img) content.push({ type: "image", data: img.data, mimeType: img.mimeType });
      }
    }
  }

  return {
    content,
    ...(structuredContent ? { structuredContent } : {}),
  };
}

// --- Pending mediaResult (iframe self-polls) -------------------------------
// Long-running async tools (video gen, lipsync, etc.) can't complete inside
// claude.ai's per-tool execution budget. Instead of blocking, we submit the
// job and return a "pending" MediaCardPayload that tells the iframe to
// self-poll a status tool via tools/call. Each poll call is sub-second so
// the host-side timeout never trips. When the poll returns a completed
// payload, the iframe swaps in the assets and re-renders in place.

export interface PendingMediaOpts {
  kind: UiMediaKind;
  /** request_id / task_id from the submit response. */
  taskId: string;
  /** Tool name the iframe will call to check progress. */
  pollTool: string;
  /** Args the iframe will pass to pollTool. */
  pollArgs: Record<string, unknown>;
  /** ms between polls; defaults to 5000. */
  intervalMs?: number;
  /** absolute give-up after this many ms; defaults to 10 min. */
  timeoutMs?: number;
  /** original tool name (powers Recreate on the rendered card). */
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  /** Plain-text headline for non-MCP-Apps clients. */
  summary?: string;
  /** Echoed display fields (model, prompt, aspect_ratio, ...). */
  extra?: Record<string, unknown>;
}

export function pendingMediaResult(opts: PendingMediaOpts): ToolResult {
  const summary =
    opts.summary ??
    `Submission accepted. Task ${opts.taskId} is generating; the inline preview will update when it's ready.`;
  const structuredContent = {
    kind: opts.kind,
    assets: [],
    status: "pending" as const,
    task_id: opts.taskId,
    poll: {
      tool_name: opts.pollTool,
      args: opts.pollArgs,
      interval_ms: opts.intervalMs ?? 5000,
      timeout_ms: opts.timeoutMs ?? 600_000,
    },
    ...(opts.toolName ? { toolName: opts.toolName } : {}),
    ...(opts.toolArgs ? { toolArgs: opts.toolArgs } : {}),
    ...(opts.extra ?? {}),
  };
  return {
    content: [{ type: "text", text: summary }],
    structuredContent,
  };
}

export function formatErr(err: unknown): string {
  if (
    err instanceof VerselyApiError ||
    err instanceof VerselyTimeoutError ||
    err instanceof VerselyNetworkError ||
    err instanceof VerselyConfigError
  ) {
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export async function resolveUserId(
  ctx: ToolContext,
  provided?: string,
): Promise<string> {
  if (provided) return provided;
  return ctx.client.getCurrentUserId();
}
