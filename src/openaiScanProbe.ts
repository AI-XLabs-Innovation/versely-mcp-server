// TEMPORARY scan probe (2026-11-14).
//
// OpenAI's plugin portal read our 209-tool list three times (200 each time)
// and then reported "The latest scan did not complete". Other developers
// report the same scan failing once the tool definitions pass a token budget
// (16k by OpenAI support's account, name + description + input schema).
// Ours measured 56k. This lists a core set that fits under 16k so one Rescan
// tells us whether size is the cause. Unlisted tools still answer calls.
//
// MCP_OPENAI_SCAN_PROBE=off serves the whole plugin catalog (the smoke test
// runs that way). Remove this file once the plugin catalog itself fits.

const KEEP: ReadonlySet<string> = new Set([
  "versely_get_credits",
  "versely_list_user_media",
  "versely_upload_media",
  "versely_find_models",
  "versely_generate_image",
  "versely_generate_video",
  "versely_generate_audio",
  "versely_generate_music",
  "versely_generate_lipsync",
  "versely_get_task_status",
  "versely_list_remix_trends",
  "versely_prepare_remix_clip",
  "versely_quote_swap",
  "versely_swap_video",
  "versely_get_swap",
  "versely_list_ready_made_avatars",
  "versely_list_avatars",
  "versely_quote_hooks",
  "versely_create_hooks",
  "versely_get_hooks",
  "versely_list_ugc_actors",
  "versely_write_ugc_script",
  "versely_quote_ugc_ads",
  "versely_create_ugc_ads",
  "versely_get_ugc_ads",
  "versely_list_caption_looks",
  "versely_caption_video",
  "versely_get_caption_job",
  "versely_create_automated_slideshow",
  "versely_get_slideshow",
  "versely_slideshow_to_video",
  "versely_find_inspiration",
  "versely_browse",
  "versely_list_social_accounts",
  "versely_preview_post",
  "versely_publish_post",
  "versely_list_posts",
  "versely_create_dub",
  "versely_get_dub",
]);

const SHORT_CONFIRM_REPEAT = "Set true only when the user asks for a second copy of a request just made.";

type Listed = { name: string; inputSchema: Record<string, unknown> };

export function scanProbeOn(): boolean {
  return process.env.MCP_OPENAI_SCAN_PROBE?.trim().toLowerCase() !== "off";
}

const memo = new WeakMap<readonly Listed[], Listed[]>();

/** The plugin's listed tools, cut to the core set and with schema boilerplate dropped. */
export function scanProbeListed<T extends Listed>(listed: readonly T[]): T[] {
  const hit = memo.get(listed);
  if (hit) return hit as T[];
  const out = listed
    .filter((t) => KEEP.has(t.name))
    .map((t) => {
      const schema = structuredClone(t.inputSchema) as Record<string, unknown>;
      delete schema.$schema;
      const props = schema.properties as Record<string, { description?: string }> | undefined;
      if (props?.confirm_repeat) props.confirm_repeat.description = SHORT_CONFIRM_REPEAT;
      return { ...t, inputSchema: schema };
    });
  memo.set(listed, out);
  return out;
}

export const SCAN_PROBE_TOOL_COUNT = KEEP.size;
