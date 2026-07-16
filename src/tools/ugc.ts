import { z } from "zod";
import { defineTool, type Tool } from "./_types.js";
import { AsyncFields, handleAsync, type AsyncMode } from "./_async.js";
import { jsonResult, mediaResult } from "./_helpers.js";
import { metaForMediaCard } from "../ui/templates.js";

const CaptionPosition = z.enum(["top", "middle", "bottom"]);

const versely_add_video_overlay = defineTool({
  name: "versely_add_video_overlay",
  description:
    "Overlay a foreground video (e.g. talking head) on top of a base video, positioned in a corner.",
  meta: metaForMediaCard(),
  inputSchema: z
    .object({
      slideshow_video_url: z
        .string()
        .url()
        .optional()
        .describe("The BASE video the overlay is composited onto. Required (or pass legacy base_video_url)."),
      base_video_url: z
        .string()
        .url()
        .optional()
        .describe("Deprecated alias for slideshow_video_url — prefer slideshow_video_url."),
      overlay_video_url: z.string().url().describe("The video laid on top (e.g. a talking head)."),
      position: z
        .enum(["top-left", "top-right", "bottom-left", "bottom-right", "center"])
        .optional()
        .describe("Corner placement. Either this or overlay_x + overlay_y is required."),
      overlay_x: z.number().min(0).max(1).optional().describe("Free-form X, 0.0–1.0. Use WITH overlay_y."),
      overlay_y: z.number().min(0).max(1).optional().describe("Free-form Y, 0.0–1.0. Use WITH overlay_x."),
      overlay_size: z
        .enum(["small", "medium", "large"])
        .optional()
        .describe("Preset overlay size (default 'medium'). Ignored if overlay_scale is set."),
      overlay_scale: z
        .number()
        .min(20)
        .max(200)
        .optional()
        .describe("Overlay size as a PERCENTAGE, 20–200 (not a 0–1 fraction). Takes priority over overlay_size."),
      scale: z
        .number()
        .positive()
        .max(1)
        .optional()
        .describe("Deprecated: 0–1 fraction. Converted to overlay_scale percent (0.5 → 50)."),
      remove_background: z
        .boolean()
        .optional()
        .describe("AI-remove the overlay's background (VEED VP9 alpha) before compositing."),
      background_image_url: z.string().url().optional(),
      ...AsyncFields,
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { mode, poll_timeout_ms, poll_interval_ms, base_video_url, scale, ...rest } = input;
    const body: Record<string, unknown> = { ...rest };
    // Backend reads slideshow_video_url — a bare base_video_url never arrived, so
    // every call 400'd on the URL validator.
    if (body.slideshow_video_url === undefined && base_video_url !== undefined) {
      body.slideshow_video_url = base_video_url;
    }
    // `scale` was read nowhere. The real field is overlay_scale, expressed as a
    // PERCENT (20–200) — so a 0–1 fraction has to be converted, not just renamed.
    if (body.overlay_scale === undefined && typeof scale === "number") {
      body.overlay_scale = Math.min(200, Math.max(20, Math.round(scale * 100)));
    }
    if (typeof body.slideshow_video_url !== "string") {
      throw new Error(
        "`slideshow_video_url` is required (the legacy `base_video_url` is accepted as an alias).",
      );
    }
    const submission = await ctx.client.post("/api/v1/ugc/add-video-overlay", body);
    return handleAsync({
      ctx,
      submitResponse: submission,
      mode: mode as AsyncMode,
      pollTimeoutMs: poll_timeout_ms,
      pollIntervalMs: poll_interval_ms,
      kind: "video",
      toolName: "versely_add_video_overlay",
      toolArgs: body,
    });
  },
});

const versely_add_captions = defineTool({
  name: "versely_add_captions",
  description: "Add a single static caption to a video at top / middle / bottom.",
  meta: metaForMediaCard(),
  inputSchema: z
    .object({
      video_url: z.string().url(),
      caption_text: z.string(),
      position: CaptionPosition.describe(
        "Caption placement. Required — the backend 400s without it.",
      ),
      font_family: z.string().optional().describe("Font family (default 'Arial')."),
      font_size: z.number().int().positive().optional().describe("Default 48."),
      font_color: z.string().optional().describe("Font colour (default 'white')."),
      font: z.string().optional().describe("Deprecated alias for font_family."),
      color: z.string().optional().describe("Deprecated alias for font_color."),
      background: z.string().optional().describe("Caption backdrop (default 'solid')."),
      outline_width: z.number().nonnegative().optional(),
      outline_color: z.string().optional(),
      ...AsyncFields,
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { mode, poll_timeout_ms, poll_interval_ms, font, color, ...rest } = input;
    const body: Record<string, unknown> = { ...rest };
    // Backend reads font_family / font_color; the old font / color names were read
    // nowhere, so every caption silently rendered in the default Arial/white.
    if (body.font_family === undefined && font !== undefined) body.font_family = font;
    if (body.font_color === undefined && color !== undefined) body.font_color = color;
    const submission = await ctx.client.post("/api/v1/ugc/add-captions", body);
    return handleAsync({
      ctx,
      submitResponse: submission,
      mode: mode as AsyncMode,
      pollTimeoutMs: poll_timeout_ms,
      pollIntervalMs: poll_interval_ms,
      kind: "video",
      toolName: "versely_add_captions",
      toolArgs: body,
      extra: { prompt: input.caption_text },
    });
  },
});

const versely_add_timestamped_captions = defineTool({
  name: "versely_add_timestamped_captions",
  description:
    "Burn CALLER-SUPPLIED timestamped captions onto a video (Reels-style). " +
    "**This does NOT transcribe** — you must provide the `captions` array yourself, with explicit " +
    "start/end times. To transcribe the video's audio automatically instead, use " +
    "versely_add_auto_captions (Caption Studio), which also offers 30 designed presets.",
  meta: metaForMediaCard(),
  inputSchema: z
    .object({
      video_url: z.string().url(),
      captions: z
        .array(
          z
            .object({
              start_sec: z.number().nonnegative().describe("When the line appears."),
              end_sec: z.number().positive().describe("When it disappears. Must be > start_sec."),
              text: z.string().describe("The caption line."),
            })
            .passthrough(),
        )
        .min(1)
        .describe("Required, non-empty. Each entry needs start_sec, end_sec and text."),
      caption_size: z
        .enum(["small", "medium", "large", "xl"])
        .optional()
        .describe("Default 'medium'."),
      position: CaptionPosition.optional().describe("Default 'bottom'."),
      font_family: z.string().optional().describe("Default 'Arial'."),
      font_color: z.string().optional().describe("Default 'white'."),
      outline_width: z.number().nonnegative().optional(),
      outline_color: z.string().optional(),
      ...AsyncFields,
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { mode, poll_timeout_ms, poll_interval_ms, ...body } = input;
    const submission = await ctx.client.post(
      "/api/v1/ugc/add-timestamped-captions",
      body,
    );
    return handleAsync({
      ctx,
      submitResponse: submission,
      mode: mode as AsyncMode,
      pollTimeoutMs: poll_timeout_ms,
      pollIntervalMs: poll_interval_ms,
      kind: "video",
      toolName: "versely_add_timestamped_captions",
      toolArgs: body,
    });
  },
});

const versely_compose_with_overlay = defineTool({
  name: "versely_compose_with_overlay",
  description:
    "Stitch a sequence of images/videos into a base composition and optionally overlay another video on top.\n\n" +
    "`base_media` is an ordered array of objects, NOT plain URLs: `{ kind: 'image'|'video', url, duration_sec?, start_sec?, end_sec? }`. " +
    "`duration_sec` is REQUIRED on every image item (how long it holds). Video items may be trimmed with start_sec/end_sec. " +
    "There is no background-audio parameter on this endpoint — mux audio separately afterwards.",
  meta: metaForMediaCard(),
  inputSchema: z
    .object({
      base_media: z
        .array(
          z
            .object({
              kind: z.enum(["image", "video"]),
              url: z.string().url(),
              duration_sec: z
                .number()
                .positive()
                .optional()
                .describe("Seconds to hold. REQUIRED for kind:'image'."),
              start_sec: z.number().nonnegative().optional().describe("Trim in-point (video only)."),
              end_sec: z.number().positive().optional().describe("Trim out-point (video only)."),
            })
            .passthrough(),
        )
        .min(1)
        .optional()
        .describe("Ordered base timeline. Required (or pass the legacy media_urls)."),
      media_urls: z
        .array(z.string().url())
        .min(1)
        .optional()
        .describe(
          "Deprecated: plain URLs. Converted to base_media by guessing kind from the extension and applying duration_per_item_seconds to images. Prefer base_media.",
        ),
      duration_per_item_seconds: z
        .number()
        .positive()
        .optional()
        .describe("Only used with the deprecated media_urls form (default 3s per image)."),
      overlay_video_url: z.string().url().optional(),
      position: z
        .enum(["top-left", "top-right", "bottom-left", "bottom-right", "center"])
        .optional()
        .describe("Overlay placement (default 'bottom-right')."),
      overlay_position: z
        .enum(["top-left", "top-right", "bottom-left", "bottom-right", "center"])
        .optional()
        .describe("Deprecated alias for position — prefer position."),
      overlay_size: z.enum(["small", "medium", "large"]).optional().describe("Default 'medium'."),
      overlay_scale: z
        .number()
        .min(20)
        .max(200)
        .optional()
        .describe("Overlay size as a PERCENT, 20–200. Takes priority over overlay_size."),
      output_aspect: z.string().optional().describe("Output framing (default '9:16')."),
      remove_background: z
        .boolean()
        .optional()
        .describe("AI-remove the overlay's background (VEED VP9 alpha) before compositing."),
      background_image_url: z.string().url().optional(),
      ...AsyncFields,
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const {
      mode,
      poll_timeout_ms,
      poll_interval_ms,
      media_urls,
      duration_per_item_seconds,
      overlay_position,
      ...rest
    } = input;
    const body: Record<string, unknown> = { ...rest };

    // The backend requires base_media: [{kind,url,duration_sec?}] and 400s on a flat
    // URL array. It also reads `position`, not `overlay_position`, and has no
    // audio_url parameter at all.
    if (!Array.isArray(body.base_media) && Array.isArray(media_urls)) {
      const hold = duration_per_item_seconds ?? 3;
      body.base_media = (media_urls as string[]).map((url) => {
        const isVideo = /\.(mp4|mov|webm|m4v|avi|mkv)(\?|#|$)/i.test(url);
        return isVideo
          ? { kind: "video", url }
          : { kind: "image", url, duration_sec: hold };
      });
    }
    if (body.position === undefined && overlay_position !== undefined) {
      body.position = overlay_position;
    }
    const media = body.base_media as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(media) || media.length === 0) {
      throw new Error(
        "`base_media` is required — an ordered array of { kind, url, duration_sec? } (the legacy `media_urls` is accepted as an alias).",
      );
    }
    // Fail fast client-side rather than round-tripping the backend's per-item 400.
    const badImage = media.findIndex(
      (m) => m?.kind === "image" && !(typeof m.duration_sec === "number" && m.duration_sec > 0),
    );
    if (badImage !== -1) {
      throw new Error(
        `base_media[${badImage}] is an image and needs a positive duration_sec (seconds to hold on screen).`,
      );
    }

    const submission = await ctx.client.post(
      "/api/v1/ugc/compose-with-overlay",
      body,
    );
    return handleAsync({
      ctx,
      submitResponse: submission,
      mode: mode as AsyncMode,
      pollTimeoutMs: poll_timeout_ms,
      pollIntervalMs: poll_interval_ms,
      kind: "video",
      toolName: "versely_compose_with_overlay",
      toolArgs: body,
    });
  },
});

const versely_get_ugc = defineTool({
  name: "versely_get_ugc",
  description: "Get a UGC video by ID.",
  meta: metaForMediaCard(),
  inputSchema: z.object({
    ugc_id: z.string(),
  }),
  handler: async (input, ctx) => {
    const data = await ctx.client.get(
      `/api/v1/ugc/${encodeURIComponent(input.ugc_id)}`,
    );
    // Read-only fetch — no Recreate.
    return mediaResult(data, { kind: "video" });
  },
});

export const ugcTools: Tool[] = [
  versely_add_video_overlay,
  versely_add_captions,
  versely_add_timestamped_captions,
  versely_compose_with_overlay,
  versely_get_ugc,
];
