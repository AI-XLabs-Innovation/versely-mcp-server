// Tool policy table: one row per tool, and the server refuses to start if a
// registered tool has none (assertPolicyCoverage, called from server.ts).
//
// Each row decides:
//   - title        human-readable name, emitted in tools/list for every profile
//   - class        read | create | edit | delete | publish, which fixes the MCP
//                  annotations (readOnly / destructive / openWorld / idempotent)
//   - profiles     which tool profiles list it (see profiles.ts). "full" lists
//                  everything; "openai" is the curated ChatGPT-plugin set
//   - inv          ChatGPT's "invoking… / invoked" status strings (<= 64 chars,
//                  openai only)
//   - why          the plain-text justification for each hint. OpenAI's plugin
//                  portal requires one per hint; scripts/annotations-report.ts
//                  prints them for pasting.
//
// Class → annotations:
//   read    readOnly, never destructive, closed world, idempotent
//   create  adds a new item to the user's private library (usually charged)
//   edit    overwrites part of something that already exists
//   delete  removes or cancels (idempotent: doing it twice changes nothing more)
//   publish reaches third-party platforms (open world)
// A row can override single hints (e.g. social connect/disconnect are open-world).
//
// The openai set is deliberately: generation + editing that lands in the
// user's own library, the reads needed to drive it, and nothing that posts
// anywhere. Adding a tool to the plugin later is a one-word change here, but it
// goes out without re-review, so check its description and schema against the
// RunPod-only rule first (see server.ts, openai profile shaping).

import type { Profile } from "../profiles.js";

export type ToolClass = "read" | "create" | "edit" | "delete" | "publish";

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
  idempotentHint: boolean;
}

export interface HintJustifications {
  readOnly: string;
  destructive: string;
  openWorld: string;
}

export interface ToolPolicy {
  name: string;
  title: string;
  class: ToolClass;
  profiles: readonly Profile[];
  annotations: ToolAnnotations;
  justifications: HintJustifications;
  /** ChatGPT status line while the tool runs (openai profile only). */
  invoking?: string;
  /** ChatGPT status line once it has run (openai profile only). */
  invoked?: string;
}

/** OpenAI's limit for openai/toolInvocation/* strings. */
export const MAX_INVOCATION_CHARS = 64;

const CLASS_HINTS: Record<ToolClass, ToolAnnotations> = {
  read: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  create: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
  edit: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false },
  delete: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
  publish: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
};

interface Row {
  title: string;
  cls: ToolClass;
  /**
   * Noun phrase for the generated justifications. read: what is read
   * ("the user's credit balance"); others: the thing made or changed
   * ("image generation", "slideshow").
   */
  what: string;
  /** Listed in the openai (ChatGPT plugin) profile too. */
  openai?: boolean;
  /** Spends credits. Defaults: create true, everything else false. */
  spends?: boolean;
  /** [invoking, invoked] — required for openai rows. */
  inv?: readonly [string, string];
  hints?: Partial<ToolAnnotations>;
  why?: Partial<HintJustifications>;
}

const PRIVATE = "Results stay private in the user's Versely library; nothing is posted or shared.";
const VERSELY_ONLY = "Talks only to the Versely API; nothing is posted or shared outside Versely.";
const OWN_LIBRARY = "Only affects the user's own Versely library; nothing outside Versely is touched.";

function defaultWhy(r: Row): HintJustifications {
  const spends = r.spends ?? r.cls === "create";
  switch (r.cls) {
    case "read":
      return {
        readOnly: `Only reads ${r.what}; nothing is created, changed or charged.`,
        destructive: "Makes no changes, so nothing can be overwritten or deleted.",
        openWorld: VERSELY_ONLY,
      };
    case "create":
      return {
        readOnly: spends
          ? `Starts a new ${r.what} saved to the user's private Versely library and spends the user's Versely credits.`
          : `Creates a new ${r.what} in the user's private Versely library; it does not spend credits.`,
        destructive: "Only adds a new item; never edits or deletes existing media.",
        openWorld: PRIVATE,
      };
    case "edit":
      return {
        readOnly: `Changes the user's existing ${r.what} in their Versely library${spends ? " and spends the user's Versely credits" : ""}.`,
        destructive: `Overwrites the fields it is given on the ${r.what}; the earlier values are not kept.`,
        openWorld: "Only changes the user's private Versely library; nothing is posted or shared.",
      };
    case "delete":
      return {
        readOnly: `Deletes the user's ${r.what} from their Versely library.`,
        destructive: `Permanently removes the ${r.what}; this cannot be undone.`,
        openWorld: OWN_LIBRARY,
      };
    case "publish":
      return {
        readOnly: `Publishes ${r.what} from the user's Versely account to the social accounts they connected.`,
        destructive: "Only creates new posts; never edits or deletes existing content.",
        openWorld:
          "Posts to third-party social platforms (such as Instagram, TikTok or YouTube) on the user's behalf.",
      };
  }
}

const ROWS: Record<string, Row> = {
  // ── Account & library ───────────────────────────────────────────────────
  versely_get_me: { title: "Get account profile", cls: "read", what: "the user's Versely profile and credit balance" },
  versely_get_credits: {
    title: "Get credit balance", cls: "read", what: "the user's Versely credit balance", openai: true,
    inv: ["Checking your Versely credits", "Checked your credits"],
  },
  versely_list_api_key_scopes: { title: "List API key scopes", cls: "read", what: "the catalog of API-key scopes" },
  versely_list_purchases: { title: "List credit purchases", cls: "read", what: "the user's credit purchase history" },
  versely_list_user_media: {
    title: "List my media", cls: "read", what: "the user's generated media", openai: true,
    inv: ["Loading your media", "Loaded your media"],
  },
  versely_delete_generation: {
    title: "Delete a generation", cls: "delete", what: "generation (image, video, audio or music item)", openai: true,
    inv: ["Deleting the item", "Deleted the item"],
  },

  // ── Models & generation ─────────────────────────────────────────────────
  versely_find_models: {
    title: "Find models", cls: "read", what: "Versely's model catalog", openai: true,
    inv: ["Looking up models", "Found models"],
  },
  versely_get_model_inputs: {
    title: "Get model inputs", cls: "read", what: "the input list of one model in Versely's catalog", openai: true,
    inv: ["Reading the model's inputs", "Read the model's inputs"],
  },
  versely_list_models: { title: "List all models", cls: "read", what: "Versely's full model catalog" },
  versely_generate_image: {
    title: "Generate image", cls: "create", what: "image generation", openai: true,
    inv: ["Starting your image", "Image started"],
  },
  versely_generate_video: {
    title: "Generate video", cls: "create", what: "video generation", openai: true,
    inv: ["Starting your video", "Video started"],
  },
  versely_generate_audio: {
    title: "Generate voiceover", cls: "create", what: "voiceover (text to speech)", openai: true,
    inv: ["Starting your voiceover", "Voiceover started"],
  },
  versely_generate_music: {
    title: "Generate music", cls: "create", what: "music track", openai: true,
    inv: ["Starting your music track", "Music track started"],
  },
  versely_extend_music: {
    title: "Extend music track", cls: "create", what: "extended version of a music track", openai: true,
    inv: ["Extending your track", "Track extension started"],
  },
  // On in the plugin for paying accounts (owner, 2026-09-24: ChatGPT knows every
  // model). No lip-sync model is RunPod-served, so the free trial refuses it.
  versely_generate_lipsync: {
    title: "Generate lip-sync video", cls: "create", what: "lip-sync video", openai: true,
    inv: ["Starting your lip-sync video", "Lip-sync video started"],
  },
  versely_remove_background: {
    title: "Remove video background", cls: "create", what: "background-removed copy of a video", openai: true,
    inv: ["Removing the background", "Background removal started"],
  },
  versely_upscale_image: {
    title: "Upscale image", cls: "create", what: "upscaled copy of an image", openai: true,
    inv: ["Upscaling your image", "Image upscale started"],
  },
  versely_upscale_video: {
    title: "Upscale video", cls: "create", what: "upscaled copy of a video", openai: true,
    inv: ["Upscaling your video", "Video upscale started"],
  },

  // ── Slideshows ──────────────────────────────────────────────────────────
  versely_create_slideshow: {
    title: "Create slideshow", cls: "create", what: "slideshow", openai: true,
    inv: ["Creating your slideshow", "Slideshow created"],
  },
  versely_create_automated_slideshow: {
    title: "Create captioned slideshow", cls: "create", what: "captioned slideshow", openai: true,
    inv: ["Building your slideshow", "Slideshow built"],
  },
  versely_get_slideshow: {
    title: "Get slideshow", cls: "read", what: "one of the user's slideshows", openai: true,
    inv: ["Loading the slideshow", "Loaded the slideshow"],
  },
  versely_list_slideshows: {
    title: "List slideshows", cls: "read", what: "the user's slideshows", openai: true,
    inv: ["Loading your slideshows", "Loaded your slideshows"],
  },
  versely_delete_slideshow: {
    title: "Delete slideshow", cls: "delete", what: "slideshow and its images", openai: true,
    inv: ["Deleting the slideshow", "Deleted the slideshow"],
  },
  versely_add_slideshow_images: {
    title: "Add slideshow images", cls: "create", what: "set of slideshow images", openai: true,
    inv: ["Adding images to your slideshow", "Images added"],
    why: {
      readOnly:
        "Generates new images and appends them to one of the user's slideshows in their private Versely library; spends the user's Versely credits.",
      destructive: "Only appends new images; the slideshow's existing images are kept.",
    },
  },
  versely_add_text_overlay: {
    title: "Add text to slides", cls: "edit", what: "slideshow", openai: true,
    inv: ["Adding text to your slides", "Text added"],
    why: {
      readOnly: "Burns text onto images of one of the user's slideshows in their Versely library.",
      destructive: "Replaces any earlier text version of the edited slides; the original images are kept.",
    },
  },
  versely_slideshow_to_video: {
    title: "Turn slideshow into video", cls: "create", what: "video rendered from a slideshow", openai: true,
    inv: ["Rendering your slideshow video", "Slideshow video rendered"],
  },

  // ── Movies ──────────────────────────────────────────────────────────────
  versely_create_movie: {
    title: "Plan a movie", cls: "create", what: "movie plan", openai: true, spends: false,
    inv: ["Planning your movie", "Movie planned"],
    why: {
      readOnly:
        "Creates a new movie plan (title and scenes) in the user's private Versely library. It does not spend credits; nothing is generated until scene generation is started.",
    },
  },
  versely_list_movies: {
    title: "List movies", cls: "read", what: "the user's movies", openai: true,
    inv: ["Loading your movies", "Loaded your movies"],
  },
  versely_get_movie: {
    title: "Get movie", cls: "read", what: "one of the user's movies and its scenes", openai: true,
    inv: ["Loading the movie", "Loaded the movie"],
  },
  versely_delete_movie: {
    title: "Delete movie", cls: "delete", what: "movie and its scenes", openai: true,
    inv: ["Deleting the movie", "Deleted the movie"],
  },
  versely_get_movie_status: {
    title: "Check movie progress", cls: "read", what: "the generation progress of one of the user's movies", openai: true,
    inv: ["Checking the movie", "Checked the movie"],
  },
  versely_generate_movie_scenes: {
    title: "Generate movie", cls: "create", what: "movie generation (one video per scene)", openai: true,
    inv: ["Starting your movie", "Movie started"],
  },
  versely_combine_movie: {
    title: "Recombine movie", cls: "edit", what: "movie", openai: true,
    inv: ["Combining your movie", "Movie combined"],
    why: {
      readOnly: "Re-renders the final video of one of the user's movies from its finished scenes.",
      destructive: "Replaces the movie's final combined video; the scene videos are kept.",
    },
  },
  versely_add_movie_scene: {
    title: "Add movie scene", cls: "create", what: "movie scene", openai: true, spends: false,
    inv: ["Adding the scene", "Scene added"],
    why: {
      readOnly:
        "Adds a new, not-yet-generated scene to one of the user's movies. It does not spend credits until the scene is generated.",
    },
  },
  versely_update_movie_scene: {
    title: "Edit movie scene", cls: "edit", what: "movie scene", openai: true,
    inv: ["Updating the scene", "Scene updated"],
  },
  versely_regenerate_scene: {
    title: "Regenerate movie scene", cls: "edit", what: "movie scene", openai: true, spends: true,
    inv: ["Regenerating the scene", "Scene regeneration started"],
    why: { destructive: "Replaces that scene's video with the new render; the earlier render is not kept." },
  },
  versely_cancel_movie: {
    title: "Cancel movie", cls: "delete", what: "movie", openai: true,
    inv: ["Cancelling the movie", "Movie cancelled"],
    why: {
      readOnly: "Cancels one of the user's movies that is still generating.",
      destructive:
        "Stops the scenes that have not finished; a cancelled movie cannot be resumed. Scenes that already finished are kept.",
    },
  },

  // ── UGC editing ─────────────────────────────────────────────────────────
  versely_add_video_overlay: {
    title: "Overlay video", cls: "create", what: "composited video", openai: true,
    inv: ["Compositing your video", "Video composited"],
  },
  versely_add_captions: {
    title: "Add caption", cls: "create", what: "captioned copy of a video", openai: true,
    inv: ["Adding the caption", "Caption added"],
  },
  versely_add_timestamped_captions: {
    title: "Add timed captions", cls: "create", what: "captioned copy of a video", openai: true,
    inv: ["Adding the captions", "Captions added"],
  },
  versely_compose_with_overlay: {
    title: "Compose video", cls: "create", what: "composed video", openai: true,
    inv: ["Composing your video", "Video composed"],
  },
  versely_get_ugc: {
    title: "Get UGC video", cls: "read", what: "one of the user's UGC videos", openai: true,
    inv: ["Loading the video", "Loaded the video"],
  },

  // ── Social (full profile only — no posting from the plugin) ─────────────
  versely_get_social_auth_url: {
    title: "Connect social account", cls: "create", what: "social-account connection link", spends: false,
    hints: { openWorldHint: true },
    why: {
      readOnly: "Creates a sign-in link for connecting one of the user's social accounts to Versely.",
      destructive: "Only creates a link; nothing existing is changed or removed.",
      openWorld: "The link leads to a third-party social platform's sign-in page.",
    },
  },
  versely_list_social_accounts: { title: "List social accounts", cls: "read", what: "the social accounts the user connected" },
  versely_refresh_social_accounts: {
    title: "Refresh social accounts", cls: "edit", what: "connected social accounts",
    hints: { destructiveHint: false, openWorldHint: true, idempotentHint: true },
    why: {
      readOnly: "Refreshes the sign-in tokens and account details Versely stores for the user's connected social accounts.",
      destructive: "Only updates stored account details; nothing is posted or deleted.",
      openWorld: "Contacts the connected social platforms to refresh tokens and account details.",
    },
  },
  versely_disconnect_social_account: {
    title: "Disconnect social account", cls: "delete", what: "social account connection",
    hints: { openWorldHint: true },
    why: {
      readOnly: "Disconnects one of the user's social accounts from Versely.",
      destructive: "Removes the connection; the user must reconnect before Versely can post there again.",
      openWorld: "Revokes Versely's access at the third-party social platform.",
    },
  },
  versely_preview_post: {
    title: "Preview social post", cls: "read", what: "a preview of a social post",
    why: {
      readOnly: "Only renders a preview of a post; nothing is published, saved or charged.",
      openWorld: "Nothing is posted; the preview is returned only to the user.",
    },
  },
  versely_publish_post: { title: "Publish social post", cls: "publish", what: "a post (caption and media)" },
  versely_list_posts: { title: "List social posts", cls: "read", what: "the user's social posts" },
  versely_get_post: { title: "Get social post", cls: "read", what: "one of the user's social posts and its links" },

  // ── Job status ──────────────────────────────────────────────────────────
  versely_get_task_status: {
    title: "Check job progress", cls: "read", what: "the status of one of the user's generation jobs", openai: true,
    inv: ["Checking progress", "Checked progress"],
  },
  versely_wait_for_task: { title: "Wait for job", cls: "read", what: "the status of one of the user's generation jobs" },

  // ── Utilities ───────────────────────────────────────────────────────────
  versely_extract_frames: {
    title: "Extract video frames", cls: "create", what: "frame extraction from a video", openai: true,
    inv: ["Extracting frames", "Frames extracted"],
  },
  versely_merge_videos: {
    title: "Merge videos", cls: "create", what: "merged video", openai: true,
    inv: ["Merging your videos", "Videos merged"],
  },
  versely_generate_prompt: {
    title: "Improve a prompt", cls: "create", what: "prompt suggestion",
    why: {
      readOnly: "Uses Versely's prompt helper, which spends 1 Versely credit; nothing is saved to the library.",
      openWorld: "The suggestion is returned only to the user; nothing is posted or shared.",
    },
  },
  versely_colorize_photo: {
    title: "Colorize photo", cls: "create", what: "colorized copy of a photo", openai: true,
    inv: ["Colorizing your photo", "Colorizing started"],
  },
  versely_audio_isolation: {
    title: "Isolate voice", cls: "create", what: "cleaned-up copy of an audio clip", openai: true,
    inv: ["Isolating the voice", "Voice isolation started"],
  },
  versely_add_auto_captions: {
    title: "Auto-caption video", cls: "create", what: "captioned copy of a video", openai: true,
    inv: ["Captioning your video", "Captioning started"],
  },

  // ── Workflows (full profile only) ───────────────────────────────────────
  versely_create_workflow: { title: "Create workflow", cls: "create", what: "workflow", spends: false },
  versely_list_workflows: { title: "List workflows", cls: "read", what: "the user's workflows" },
  versely_get_workflow: { title: "Get workflow", cls: "read", what: "one of the user's workflows" },
  versely_update_workflow: { title: "Edit workflow", cls: "edit", what: "workflow" },
  versely_delete_workflow: { title: "Delete workflow", cls: "delete", what: "workflow" },
  versely_duplicate_workflow: { title: "Duplicate workflow", cls: "create", what: "copy of a workflow", spends: false },
  versely_export_workflow: { title: "Export workflow", cls: "read", what: "one of the user's workflows as portable JSON" },
  versely_update_workflow_mode: {
    title: "Set workflow mode", cls: "edit", what: "workflow schedule and auto-post settings",
    hints: { openWorldHint: true },
    why: {
      openWorld:
        "Can switch on automatic posting, after which future scheduled runs publish to the user's connected social platforms.",
    },
  },
  versely_update_workflow_schedule: { title: "Set workflow schedule", cls: "edit", what: "workflow schedule" },
  versely_update_workflow_dates: { title: "Set workflow run dates", cls: "edit", what: "workflow run dates" },
  versely_update_workflow_assets: { title: "Set workflow media", cls: "edit", what: "workflow media list" },
  versely_run_workflow: {
    title: "Run workflow", cls: "publish", what: "workflow results",
    why: {
      readOnly: "Runs one of the user's saved workflows, which generates media and spends the user's Versely credits.",
      destructive: "Only creates new media (and posts, when the workflow auto-posts); never edits or deletes existing content.",
      openWorld: "When the workflow is set to auto-post, its results are published to the user's connected social platforms.",
    },
  },
  versely_list_workflow_runs: { title: "List workflow runs", cls: "read", what: "the run history of one of the user's workflows" },
  versely_get_workflow_run: { title: "Check workflow run", cls: "read", what: "the progress of one of the user's workflow runs" },
  versely_list_active_workflow_runs: { title: "List running workflows", cls: "read", what: "the user's workflow runs still in progress" },
  versely_list_failed_workflow_runs: { title: "List failed workflow runs", cls: "read", what: "the user's failed or cancelled workflow runs" },
  versely_summarize_workflow: { title: "Summarize workflow", cls: "read", what: "run statistics for one of the user's workflows" },
  versely_list_scheduled_workflows: { title: "List scheduled workflows", cls: "read", what: "the user's scheduled workflows" },
  versely_create_workflow_asset: { title: "Create workflow asset", cls: "create", what: "workflow asset", spends: false },
  versely_list_workflow_assets: { title: "List workflow assets", cls: "read", what: "the user's workflow assets" },
  versely_get_workflow_asset: { title: "Get workflow asset", cls: "read", what: "one of the user's workflow assets" },
  versely_update_workflow_asset: { title: "Edit workflow asset", cls: "edit", what: "workflow asset" },
  versely_add_workflow_asset_images: {
    title: "Add workflow asset images", cls: "create", what: "set of reference images on a workflow asset", spends: false,
    why: { destructive: "Only appends images; the asset's existing images are kept." },
  },
  versely_delete_workflow_asset: { title: "Delete workflow asset", cls: "delete", what: "workflow asset" },
  versely_prepare_workflow_assets: { title: "Prepare workflow assets", cls: "create", what: "batch of workflow assets", spends: false },

  // ── Video-workflow runs (full profile only) ─────────────────────────────
  versely_list_video_workflow_runs: { title: "List video workflow runs", cls: "read", what: "the user's video-workflow runs" },
  versely_get_video_workflow_run: { title: "Check video workflow run", cls: "read", what: "the progress of one of the user's video-workflow runs" },
  versely_cancel_video_workflow_run: {
    title: "Cancel video workflow run", cls: "delete", what: "video-workflow run",
    why: {
      readOnly: "Cancels one of the user's video-workflow runs that is still in progress.",
      destructive: "Stops the scenes that have not finished; a cancelled run cannot be resumed. Finished scenes are kept.",
    },
  },
  versely_combine_video_workflow_run: {
    title: "Recombine video workflow run", cls: "edit", what: "video-workflow run",
    why: {
      readOnly: "Re-renders the final video of one of the user's video-workflow runs from its finished scenes.",
      destructive: "Replaces the run's final combined video; the scene videos are kept.",
    },
  },
  versely_retry_video_workflow_scene: {
    title: "Retry video workflow scene", cls: "edit", what: "video-workflow run", spends: true,
    why: { destructive: "Re-renders the failed scene and the scenes that depend on it, replacing their earlier output." },
  },

  // ── Voices & dubbing ────────────────────────────────────────────────────
  versely_list_voices: {
    title: "List voices", cls: "read", what: "the catalog of voices available for voiceovers", openai: true,
    inv: ["Loading voices", "Loaded voices"],
  },
  versely_create_dub: {
    title: "Dub video or audio", cls: "create", what: "dubbed copy of a video or audio file", openai: true,
    inv: ["Starting your dub", "Dub started"],
  },
  versely_get_dub: {
    title: "Check dub", cls: "read", what: "one of the user's dubbing projects", openai: true,
    inv: ["Checking the dub", "Checked the dub"],
  },
  versely_list_dubs: {
    title: "List dubs", cls: "read", what: "the user's dubbing projects", openai: true,
    inv: ["Loading your dubs", "Loaded your dubs"],
  },
  versely_delete_dub: {
    title: "Delete dub", cls: "delete", what: "dubbing project", openai: true,
    inv: ["Deleting the dub", "Deleted the dub"],
    why: {
      readOnly: "Deletes one of the user's dubbing projects; one still generating is cancelled and its credits refunded.",
      destructive: "Permanently removes the dubbing project from the user's list.",
    },
  },

  // ── Debug (registered only with MCP_ENABLE_DEBUG_TOOLS=1) ───────────────
  versely_render_test_card: {
    title: "Render test card", cls: "read", what: "a fixed test card",
    why: { readOnly: "Returns a fixed test card without calling any API; nothing is read, created or charged." },
  },
};

function buildPolicy(name: string, r: Row): ToolPolicy {
  const justifications = { ...defaultWhy(r), ...(r.why ?? {}) };
  return {
    name,
    title: r.title,
    class: r.cls,
    profiles: r.openai ? ["full", "openai"] : ["full"],
    annotations: { ...CLASS_HINTS[r.cls], ...(r.hints ?? {}) },
    justifications,
    ...(r.inv ? { invoking: r.inv[0], invoked: r.inv[1] } : {}),
  };
}

export const TOOL_POLICY: Readonly<Record<string, ToolPolicy>> = Object.freeze(
  Object.fromEntries(Object.entries(ROWS).map(([name, r]) => [name, buildPolicy(name, r)])),
);

export function getToolPolicy(name: string): ToolPolicy | undefined {
  return TOOL_POLICY[name];
}

export function toolInProfile(name: string, profile: Profile): boolean {
  return TOOL_POLICY[name]?.profiles.includes(profile) ?? false;
}

/**
 * Startup guard. Throws when a defined tool has no policy row, when a row names
 * no tool (a typo would otherwise silently drop a tool from the plugin), or
 * when an openai row is missing — or overruns — its invocation strings.
 */
export function assertPolicyCoverage(definedToolNames: readonly string[]): void {
  const defined = new Set(definedToolNames);
  const problems: string[] = [];
  for (const name of definedToolNames) {
    if (!TOOL_POLICY[name]) problems.push(`${name}: no row in tools/_policy.ts`);
  }
  for (const [name, p] of Object.entries(TOOL_POLICY)) {
    if (!defined.has(name)) problems.push(`${name}: policy row for a tool that does not exist`);
    if (!p.title.trim()) problems.push(`${name}: empty title`);
    if (p.profiles.includes("openai")) {
      if (!p.invoking || !p.invoked) problems.push(`${name}: openai tool without invoking/invoked strings`);
    }
    for (const s of [p.invoking, p.invoked]) {
      if (s !== undefined && s.length > MAX_INVOCATION_CHARS) {
        problems.push(`${name}: invocation string over ${MAX_INVOCATION_CHARS} chars: "${s}"`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`Tool policy table is incomplete:\n  - ${problems.join("\n  - ")}`);
  }
}
