import type { ContentBlock, ToolContext, ToolResult } from "./_types.js";
import {
  VerselyApiError,
  VerselyConfigError,
  VerselyNetworkError,
  VerselyTimeoutError,
} from "../errors.js";

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
// Tool results that contain asset URLs (image/video/audio) are augmented with
// MCP-UI `resource` content blocks so MCP Apps-capable hosts (Claude Desktop,
// claude.ai) render the asset inline. Hosts without MCP-UI support still see
// the leading markdown link and the trailing raw-JSON block.

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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

function wrapAssetHtml(asset: MediaAsset): string {
  const url = escapeHtml(asset.url);
  switch (asset.kind) {
    case "image":
      return `<img src="${url}" style="max-width:100%;border-radius:8px" alt="Generated image" />`;
    case "video":
      return `<video src="${url}" controls style="max-width:100%;border-radius:8px"></video>`;
    case "audio":
      return `<audio src="${url}" controls style="width:100%"></audio>`;
  }
}

function wrapGalleryHtml(assets: MediaAsset[]): string {
  const tiles = assets
    .map(
      (a) =>
        `<img src="${escapeHtml(a.url)}" style="width:31%;border-radius:8px" alt="Slide" />`,
    )
    .join("");
  return `<div style="display:flex;flex-wrap:wrap;gap:8px">${tiles}</div>`;
}

function summarizeAssets(assets: MediaAsset[], summary?: string): string {
  if (assets.length === 0) return summary ?? "Done.";
  const links = assets
    .map((a) => `[${filenameOf(a.url)}](${a.url})`)
    .join(", ");
  if (summary) return `${summary}\n${links}`;
  const kinds = new Set(assets.map((a) => a.kind));
  const label =
    kinds.size === 1
      ? `${assets.length} ${[...kinds][0]}${assets.length === 1 ? "" : "s"}`
      : `${assets.length} assets`;
  return `Generated ${label} — ${links}`;
}

export interface MediaResultOpts {
  /** Identifier used in `ui://versely/{idPrefix}/{i}` resource URIs. */
  idPrefix?: string;
  /** Plain-text headline; overrides the auto "Generated N images — …" summary. */
  summary?: string;
  /**
   * If true and every detected asset is an image, fold them into a single
   * gallery resource block. Defaults to false (one block per asset).
   */
  gallery?: boolean;
}

/**
 * Build a multi-block content array: [summary text, ...resource blocks, raw JSON].
 * Falls back to plain JSON if no media URLs are found, so non-media payloads
 * still render usefully.
 */
export function mediaResult(payload: unknown, opts: MediaResultOpts = {}): ToolResult {
  const assets = extractMediaAssets(payload);
  if (assets.length === 0) return jsonResult(payload);

  const idPrefix = opts.idPrefix ?? `asset-${Date.now()}`;
  const content: ContentBlock[] = [
    { type: "text", text: summarizeAssets(assets, opts.summary) },
  ];

  const allImages = assets.every((a) => a.kind === "image");
  if (opts.gallery && allImages && assets.length > 1) {
    content.push({
      type: "resource",
      resource: {
        uri: `ui://versely/${idPrefix}/gallery`,
        mimeType: "text/html",
        text: wrapGalleryHtml(assets),
      },
    });
  } else {
    assets.forEach((asset, i) => {
      content.push({
        type: "resource",
        resource: {
          uri: `ui://versely/${idPrefix}/${i}`,
          mimeType: "text/html",
          text: wrapAssetHtml(asset),
        },
      });
    });
  }

  content.push({ type: "text", text: JSON.stringify(payload, null, 2) });
  return { content };
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
