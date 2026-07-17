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

/**
 * Per-image and whole-response ceilings for inlined previews.
 *
 * These were 5MB/image with no total cap, which let a single tool result carry
 * 4 x 5MB = 20MB raw, ~27MB once base64 expands it. Real generations hit that:
 * a Midjourney result is 4 PNGs of ~1.9MB each = 7.5MB raw -> ~10MB of base64
 * in ONE get_task_status response. Hosts reject a payload that size, and the
 * rejection surfaces to the user as "Unable to reach versely-mcp" — the server
 * looks down when it actually answered, and the generation is already paid for.
 * A single-image result (~250KB) sailed through, which is why this looked
 * random rather than like a size limit.
 *
 * The inline copy is a CONVENIENCE — it lets the model see the pixels and
 * covers hosts where the iframe fails. The URLs are always in the text and in
 * structuredContent, so skipping an oversized image costs nothing that matters.
 * Budgets are deliberately well under any plausible host limit.
 */
const MAX_INLINE_IMAGE_BYTES = 750_000;
const MAX_INLINE_TOTAL_BYTES = 1_500_000;
const INLINE_FETCH_TIMEOUT_MS = 8_000;

async function fetchImageAsBase64(
  url: string,
): Promise<{ data: string; mimeType: string; bytes: number } | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(INLINE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
    if (!contentType.startsWith("image/")) return null;
    // Bail on the declared size before buffering, so an oversized asset doesn't
    // get pulled into memory only to be discarded.
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_INLINE_IMAGE_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_INLINE_IMAGE_BYTES) return null;
    // `bytes` is the base64 length — the thing that actually travels in the
    // response — not the raw byte count.
    const data = buf.toString("base64");
    return { data, mimeType: contentType, bytes: data.length };
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
      // Enforce a budget across the WHOLE response, not just per image. Four
      // images each under the per-image cap still add up to a payload the host
      // will refuse, and a refused response is indistinguishable from an
      // unreachable server.
      let budget = MAX_INLINE_TOTAL_BYTES;
      let skipped = 0;
      for (const img of fetched) {
        if (!img) {
          // fetchImageAsBase64 returned null: over the per-image cap, wrong
          // content-type, or a network failure.
          skipped++;
          continue;
        }
        if (img.bytes > budget) {
          skipped++;
          continue;
        }
        budget -= img.bytes;
        content.push({ type: "image", data: img.data, mimeType: img.mimeType });
      }
      if (skipped > 0) {
        // Say so rather than letting the model believe it saw everything and
        // describe images that were never attached.
        content.push({
          type: "text",
          text:
            `(${skipped} of ${imageUrls.length} image${imageUrls.length === 1 ? "" : "s"} not shown inline — too large to attach. ` +
            `Open the URL${imageUrls.length === 1 ? "" : "s"} above to view ${imageUrls.length === 1 ? "it" : "them"}.)`,
        });
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
  // The polling handle lives in `structuredContent`, which the host's iframe reads
  // but the MODEL never sees. On a host that renders the card, the preview updates
  // itself; on one that doesn't, the model is the only thing that can advance this.
  // So the text has to carry the request_id AND name the tool to poll with —
  // otherwise "is generating" reads as terminal and the caller reports success for
  // a job that has not finished.
  const pollArgKey =
    opts.pollArgs && typeof opts.pollArgs === "object"
      ? Object.keys(opts.pollArgs as Record<string, unknown>)[0]
      : undefined;
  // Points at the SINGLE-CHECK tool, never the blocking one. versely_wait_for_task
  // holds the HTTP request open, and the proxy in front of this server severs
  // anything past ~100s — which the client renders as "Unable to reach
  // versely-mcp", i.e. a slow video makes the whole MCP look down, and each
  // retry costs another 100s. Repeated fast checks never trip that.
  const summary =
    opts.summary ??
    `Submission accepted — task ${opts.taskId} is generating and is NOT finished yet. ` +
      `If an inline preview is shown it will update on its own. Otherwise call ` +
      `${opts.pollTool} with ${pollArgKey ?? "request_id"}="${opts.taskId}" to check on it, ` +
      `and call it again if it is still pending — video can take several minutes. ` +
      `Do not describe this as complete until a poll returns a result URL, and do not ` +
      `resubmit — the job is already running and already charged.`;
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
