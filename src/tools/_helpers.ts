import type { ToolContext, ToolResult } from "./_types.js";
import {
  VerselyApiError,
  VerselyConfigError,
  VerselyNetworkError,
  VerselyTimeoutError,
} from "../errors.js";
import { buildUiPayload, type UiAsset, type UiTemplate } from "../ui/templates.js";

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
const AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "ogg", "flac", "aac"]);

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

// Pick the appropriate template when one isn't passed explicitly. Single-kind
// asset lists map to their dedicated viewer; multi-kind or multi-video lists
// fall through to the gallery (which auto-detects videos by extension).
function inferTemplate(assets: MediaAsset[]): UiTemplate {
  const kinds = new Set(assets.map((a) => a.kind));
  if (kinds.size > 1) return "gallery";
  const [only] = kinds;
  if (only === "image") return "image-viewer";
  if (only === "audio") return "audio-player";
  return assets.length === 1 ? "video-player" : "gallery";
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
   * MCP Apps UI template to bind. If omitted, inferred from the asset kinds:
   * all images → image-viewer, single video → video-player, all audio →
   * audio-player, mixed → gallery.
   */
  template?: UiTemplate;
  /** Plain-text headline; overrides the auto "Generated N images." summary. */
  summary?: string;
}

/**
 * Build a tool result whose `structuredContent` hydrates an MCP Apps iframe,
 * with a plain-text `content` block for hosts that don't render inline.
 * Falls back to a JSON result when no asset URLs are detected.
 */
export function mediaResult(payload: unknown, opts: MediaResultOpts = {}): ToolResult {
  const assets = extractMediaAssets(payload);
  if (assets.length === 0) return jsonResult(payload);

  const template = opts.template ?? inferTemplate(assets);
  const uiAssets: UiAsset[] = assets.map((a) => ({
    url: a.url,
    label: filenameOf(a.url),
  }));
  const structuredContent = buildUiPayload(template, uiAssets);

  return {
    content: [{ type: "text", text: summarizeAssets(assets, opts.summary) }],
    ...(structuredContent ? { structuredContent } : {}),
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
