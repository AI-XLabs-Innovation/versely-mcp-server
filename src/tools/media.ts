// versely_upload_media: put a photo, video or audio file into the user's own
// Versely library and hand back its URL.
//
// Why it exists (2026-11-14): Swap ("put me in this video"), music videos and
// a few other features only take files that live in the user's Versely
// storage, and every other tool takes a public https URL. An assistant has
// neither for a file the user just attached. In ChatGPT the attachment arrives
// as a file input (`openai/fileParams`: { download_url, file_id, ... }); other
// assistants pass an https link. Either way the bytes are streamed to a temp
// file (bounded), then PUT straight to storage through the backend's presigned
// upload (POST /bucket/presign, POST /bucket/presign/complete), the same path
// the web app uses for large files. Free.

import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { request } from "undici";
import { z } from "zod";
import { defineTool, defineVariant, type Tool, type ToolContext, type ToolResult } from "./_types.js";
import { errorResult } from "./_helpers.js";
import { guardedGet, UnsafeUrlError } from "./_fetchGuard.js";

type Kind = "image" | "video" | "audio";

const MB = 1024 * 1024;
/** Per-kind size limits: what downloads and uploads inside one tool call. */
export const UPLOAD_LIMIT_BYTES: Record<Kind, number> = { image: 30 * MB, video: 200 * MB, audio: 60 * MB };
/** The whole transfer must fit inside one tool call (hosts cut calls at about a minute). */
const TRANSFER_TIMEOUT_MS = 55_000;

/** Extension → [kind, the content type the backend files it under]. */
const BY_EXT: Record<string, [Kind, string]> = {
  jpg: ["image", "image/jpeg"], jpeg: ["image", "image/jpeg"], png: ["image", "image/png"], webp: ["image", "image/webp"],
  gif: ["image", "image/gif"], heic: ["image", "image/heic"], heif: ["image", "image/heif"],
  mp4: ["video", "video/mp4"], mov: ["video", "video/quicktime"], webm: ["video", "video/webm"],
  m4v: ["video", "video/x-m4v"], mkv: ["video", "video/x-matroska"],
  mp3: ["audio", "audio/mpeg"], wav: ["audio", "audio/wav"], m4a: ["audio", "audio/mp4"], ogg: ["audio", "audio/ogg"],
  aac: ["audio", "audio/aac"], flac: ["audio", "audio/flac"],
};

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "image/heic": "heic", "image/heif": "heif",
  "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "video/x-m4v": "m4v", "video/x-matroska": "mkv",
  "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav",
  "audio/vnd.wave": "wav", "audio/mp4": "m4a", "audio/m4a": "m4a", "audio/x-m4a": "m4a", "audio/ogg": "ogg",
  "audio/aac": "aac", "audio/flac": "flac", "audio/x-flac": "flac",
};

const ACCEPTED = "Photos (jpg, png, webp, gif, heic), videos (mp4, mov, webm) and audio (mp3, wav, m4a) can be stored.";

const cleanMime = (v: string | null | undefined) => (v ?? "").split(";")[0]!.trim().toLowerCase();
const extOf = (name: string) => /\.([a-z0-9]{2,5})$/i.exec(name)?.[1]?.toLowerCase() ?? "";

function nameFromUrl(raw: string): string {
  try {
    const last = new URL(raw).pathname.split("/").filter(Boolean).pop() ?? "";
    return decodeURIComponent(last);
  } catch {
    return "";
  }
}

/** A tidy file name: no path, no odd characters, at most 80 characters before the extension. */
function tidyName(name: string, ext: string): string {
  const base = name.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
  return `${base || "upload"}.${ext}`;
}

/**
 * What a file is, from (in order) the server's content type, the type the
 * host declared, and its name. Null when it is none of the kinds we store.
 */
export function describeUpload(args: { headerMime?: string | null; declaredMime?: string | null; name?: string | null }):
  | { kind: Kind; ext: string; contentType: string; fileName: string }
  | null {
  const name = (args.name ?? "").trim();
  const ext =
    EXT_BY_MIME[cleanMime(args.headerMime)] ??
    EXT_BY_MIME[cleanMime(args.declaredMime)] ??
    (BY_EXT[extOf(name)] ? extOf(name) : undefined);
  if (!ext) return null;
  const [kind, contentType] = BY_EXT[ext]!;
  return { kind, ext, contentType, fileName: tidyName(name, ext) };
}

const mb = (bytes: number) => `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)} MB`;

interface Presigned {
  upload_url?: string;
  key?: string;
  bucket?: string;
  url?: string;
  headers?: Record<string, string>;
}

/** Download `url` (bounded) and store it in the caller's Versely library. */
export async function storeFromUrl(
  ctx: ToolContext,
  src: { url: string; fileName?: string; mime?: string },
): Promise<ToolResult> {
  const deadline = AbortSignal.timeout(TRANSFER_TIMEOUT_MS);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, deadline]) : deadline;
  const dir = await mkdtemp(path.join(os.tmpdir(), "versely-upload-"));
  const tmp = path.join(dir, "file");
  try {
    let res;
    try {
      res = await guardedGet(src.url, signal);
    } catch (err) {
      if (err instanceof UnsafeUrlError) return errorResult(`${err.message} Nothing was stored.`);
      if (deadline.aborted) return errorResult("The file took too long to download. Nothing was stored. Try a smaller file.");
      return errorResult("The file could not be downloaded from that link. Nothing was stored.");
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      return errorResult(`The file could not be downloaded (the link answered ${res.status}). Nothing was stored.`);
    }
    const what = describeUpload({
      headerMime: res.headers.get("content-type"),
      declaredMime: src.mime,
      name: src.fileName || nameFromUrl(src.url),
    });
    if (!what) {
      await res.body.cancel().catch(() => undefined);
      return errorResult(`That file type can't be stored. ${ACCEPTED} Nothing was stored.`);
    }
    const limit = UPLOAD_LIMIT_BYTES[what.kind];
    const tooBig = () =>
      errorResult(`That ${what.kind} is over ${mb(limit)}, the most that can be stored from a chat. Nothing was stored. Trim or compress it, or upload it at app.versely.studio.`);
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > limit) {
      await res.body.cancel().catch(() => undefined);
      return tooBig();
    }

    // Stream to disk, counting: a server may lie about (or omit) its length.
    let size = 0;
    let over = false;
    const out = createWriteStream(tmp);
    try {
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength;
        if (size > limit) {
          over = true;
          break;
        }
        if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", resolve));
      }
    } catch {
      out.destroy();
      if (deadline.aborted) return errorResult("The file took too long to download. Nothing was stored. Try a smaller file.");
      return errorResult("The download stopped before the file was complete. Nothing was stored.");
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    if (over) return tooBig();
    if (size === 0) return errorResult("That file is empty. Nothing was stored.");

    const presigned = await ctx.client.post<Presigned>("/api/v1/bucket/presign", {
      file_name: what.fileName,
      content_type: what.contentType,
      size,
    });
    if (!presigned?.upload_url || !presigned.key || !presigned.bucket) {
      return errorResult("Versely could not prepare the upload. Nothing was stored. Try again in a moment.");
    }
    try {
      const put = await request(presigned.upload_url, {
        method: "PUT",
        headers: { ...(presigned.headers ?? {}), "content-type": what.contentType, "content-length": String(size) },
        body: createReadStream(tmp),
        signal,
      });
      await put.body.dump();
      if (put.statusCode < 200 || put.statusCode >= 300) {
        return errorResult("The file could not be saved to Versely storage. Nothing was stored. Try again in a moment.");
      }
    } catch {
      if (deadline.aborted) return errorResult("The file took too long to store. Nothing was stored. Try a smaller file.");
      return errorResult("The file could not be saved to Versely storage. Nothing was stored. Try again in a moment.");
    }
    const done = await ctx.client.post<{ files?: Array<{ url?: string }> }>("/api/v1/bucket/presign/complete", {
      key: presigned.key,
      bucket: presigned.bucket,
      name: what.fileName,
    });
    const url = done?.files?.[0]?.url ?? presigned.url;
    if (!url) return errorResult("The file was sent but Versely did not confirm it. Try again in a moment.");

    const use =
      what.kind === "video"
        ? "Pass it wherever a tool takes a video URL, for example as video_url in versely_prepare_remix_clip."
        : what.kind === "image"
          ? "Pass it wherever a tool takes an image URL, for example as a photo in versely_swap_video or an image input of versely_generate_video."
          : "Pass it wherever a tool takes an audio URL.";
    return {
      content: [
        {
          type: "text",
          text: `Stored in the user's Versely library (${what.kind}, ${mb(size)}): ${url}\n${use} Nothing was charged.`,
        },
      ],
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const BASE_DESCRIPTION =
  "Store a photo, video or audio file in the user's own Versely library and get back its URL, so other Versely " +
  "tools can use it. FREE. Use it first whenever the user gives a file of their own: their clip for " +
  "versely_prepare_remix_clip, their photo for versely_swap_video, a reference image for versely_generate_video. " +
  "Limits: photos 30 MB, videos 200 MB, audio 60 MB (jpg, png, webp, gif, heic, mp4, mov, webm, mp3, wav, m4a). " +
  "The file stays private to the user's account. Only store files the user provided themselves.";

/** ChatGPT's file object (`openai/fileParams`): all four properties declared, two required. */
const OpenAiFile = z.object({
  download_url: z.string().describe("Temporary link to the attached file."),
  file_id: z.string().describe("The attached file's id."),
  mime_type: z.string().optional().describe("The file's type, e.g. video/mp4."),
  file_name: z.string().optional().describe("The file's name."),
});

const versely_upload_media = defineTool({
  name: "versely_upload_media",
  description: `${BASE_DESCRIPTION} Pass a direct https link to the file as \`url\`.`,
  inputSchema: z.object({
    url: z.string().url().describe("A direct https link to the photo, video or audio file."),
    file_name: z.string().max(200).optional().describe("A name for the file, with its extension (e.g. 'my-clip.mp4'). Helps when the link has none."),
  }),
  handler: async (input, ctx) => storeFromUrl(ctx, { url: input.url, fileName: input.file_name }),
  openai: {
    ...defineVariant({
      description: `${BASE_DESCRIPTION} Pass the file the user attached in this chat as \`file\`.`,
      inputSchema: z.object({
        file: OpenAiFile.describe("The photo, video or audio file the user attached in this chat."),
      }),
      handler: async (input, ctx) =>
        storeFromUrl(ctx, { url: input.file.download_url, fileName: input.file.file_name, mime: input.file.mime_type }),
    }),
    meta: { "openai/fileParams": ["file"] },
  },
});

export const mediaTools: Tool[] = [versely_upload_media];
