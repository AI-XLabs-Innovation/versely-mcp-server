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
// The openai set: generation + editing that lands in the user's own library,
// the reads needed to drive it, and (owner, 2026-09-24) social posting to the
// accounts the user connects. Adding a tool to the plugin is a one-word change
// here, but it goes out without re-review, so check its description and schema
// against the free-trial rule first (see server.ts, openai profile shaping).

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
  // Destructive: a live post can't be taken back from here, and OpenAI counts
  // "send messages ... that can't be undone" as destructive. It also makes
  // ChatGPT confirm with the user before anything goes out publicly.
  publish: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
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
        destructive:
          "Posts go out publicly on the user's social accounts, and Versely can't take a post back once it is live.",
        openWorld:
          "Posts to third-party social platforms (such as Instagram, TikTok or YouTube) on the user's behalf.",
      };
  }
}

const ROWS: Record<string, Row> = {
  // ── Account & library ───────────────────────────────────────────────────
  versely_get_me: {
    title: "Get account profile", cls: "read", what: "the user's Versely profile and credit balance", openai: true,
    inv: ["Loading your account", "Loaded your account"],
  },
  versely_get_credits: {
    title: "Get credit balance", cls: "read", what: "the user's Versely credit balance", openai: true,
    inv: ["Checking your Versely credits", "Checked your credits"],
  },
  versely_list_api_key_scopes: { title: "List API key scopes", cls: "read", what: "the catalog of API-key scopes" },
  versely_list_purchases: {
    title: "List purchases", cls: "read", what: "the user's subscription payments and credit purchases", openai: true,
    inv: ["Loading your purchases", "Loaded your purchases"],
  },
  versely_get_subscription: {
    title: "Get subscription", cls: "read", what: "the user's subscription status", openai: true,
    inv: ["Checking your subscription", "Checked your subscription"],
  },
  versely_list_credit_history: {
    title: "List credit history", cls: "read", what: "the user's credit spending, refunds and top-ups", openai: true,
    inv: ["Loading your credit history", "Loaded your credit history"],
  },

  // ── Billing (full profile only: OpenAI's rules keep commerce out of ChatGPT) ──
  versely_list_plans: { title: "List plans and credit packs", cls: "read", what: "Versely's subscription plans and credit packs" },
  versely_create_checkout_link: {
    title: "Create checkout link", cls: "create", what: "Dodo Payments checkout link", spends: false,
    hints: { openWorldHint: true },
    why: {
      readOnly: "Creates a payment link for a Versely plan or credit pack; nothing is charged unless the user pays on that page.",
      destructive: "Only creates a link; nothing existing is changed.",
      openWorld: "The link opens Dodo Payments' hosted checkout.",
    },
  },
  versely_get_billing_portal_link: {
    title: "Get billing portal link", cls: "read", what: "a link to the user's Dodo Payments billing portal",
    hints: { openWorldHint: true },
    why: { openWorld: "The link opens the user's Dodo Payments billing portal." },
  },
  versely_cancel_subscription: {
    title: "Cancel subscription", cls: "delete", what: "subscription",
    hints: { openWorldHint: true },
    why: {
      readOnly: "Sets the user's web subscription to cancel at the end of the current billing period.",
      destructive: "The subscription stops renewing; it can be undone with resume before the period ends.",
      openWorld: "Changes the subscription at Dodo Payments.",
    },
  },
  versely_pause_subscription: {
    title: "Pause subscription", cls: "edit", what: "subscription",
    hints: { openWorldHint: true },
    why: {
      readOnly: "Pauses the user's web subscription.",
      destructive: "Billing and the plan's benefits stop until the subscription is resumed.",
      openWorld: "Changes the subscription at Dodo Payments.",
    },
  },
  versely_resume_subscription: {
    title: "Resume subscription", cls: "edit", what: "subscription",
    hints: { destructiveHint: false, openWorldHint: true, idempotentHint: true },
    why: {
      readOnly: "Resumes the user's paused subscription, or undoes a scheduled cancellation.",
      destructive: "Only restores the subscription; nothing is removed.",
      openWorld: "Changes the subscription at Dodo Payments.",
    },
  },
  versely_skip_trial: {
    title: "End trial now", cls: "edit", what: "subscription",
    hints: { destructiveHint: true, openWorldHint: true },
    why: {
      readOnly: "Ends the user's trial now, so their card is charged for the plan today.",
      destructive: "Charges the user's card today; the payment can't be undone from here.",
      openWorld: "Charges the user's card through Dodo Payments.",
    },
  },
  versely_preview_plan_change: {
    title: "Preview plan change", cls: "read", what: "what switching the user's subscription plan would do",
  },
  versely_change_plan: {
    title: "Change plan", cls: "edit", what: "subscription plan",
    hints: { openWorldHint: true },
    why: {
      readOnly: "Switches the user's web subscription to another plan, which can charge their card today.",
      destructive: "Replaces the current plan (now, or at the next renewal for a downgrade).",
      openWorld: "Changes the subscription, and may charge the card, at Dodo Payments.",
    },
  },
  versely_cancel_plan_change: {
    title: "Cancel plan change", cls: "edit", what: "scheduled plan switch",
    hints: { destructiveHint: false, openWorldHint: true, idempotentHint: true },
    why: {
      readOnly: "Cancels a plan switch scheduled for the next renewal.",
      destructive: "Only keeps the current plan; nothing is removed.",
      openWorld: "Changes the subscription at Dodo Payments.",
    },
  },
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
  versely_generate_sound_effect: {
    title: "Generate sound effect", cls: "create", what: "sound effect", openai: true,
    inv: ["Making your sound effect", "Sound effect started"],
  },
  // On in the plugin for paying accounts (owner, 2026-09-24: ChatGPT knows every
  // model). No lip-sync model is RunPod-served, so the free trial refuses it.
  versely_generate_lipsync: {
    title: "Generate lip-sync video", cls: "create", what: "lip-sync video", openai: true,
    inv: ["Starting your lip-sync video", "Lip-sync video started"],
  },
  versely_list_avatars: {
    title: "List avatars", cls: "read", what: "the stock avatars and voices for avatar videos", openai: true,
    inv: ["Loading avatars", "Loaded avatars"],
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

  // ── Brands (both profiles; owner, 2026-09-24) ───────────────────────────
  versely_analyze_brand: {
    title: "Analyze brand from link", cls: "create", what: "brand profile", spends: false, openai: true,
    inv: ["Reading the brand", "Brand read"],
    hints: { destructiveHint: true, openWorldHint: true },
    why: {
      readOnly: "Reads a brand's public page and saves the brand profile to the user's Versely account; no credits are spent.",
      destructive: "Reading a brand that is already saved refreshes that brand's saved profile.",
      openWorld: "Fetches the public web page or social post the user gives.",
    },
  },
  versely_list_brands: {
    title: "List brands", cls: "read", what: "the brands saved on the user's account", openai: true,
    inv: ["Loading your brands", "Loaded your brands"],
  },
  versely_get_brand: {
    title: "Get brand", cls: "read", what: "one of the user's saved brands", openai: true,
    inv: ["Loading the brand", "Loaded the brand"],
  },
  versely_update_brand: {
    title: "Edit brand", cls: "edit", what: "saved brand", openai: true,
    inv: ["Updating the brand", "Brand updated"],
  },
  versely_set_default_brand: {
    title: "Set default brand", cls: "edit", what: "default brand", openai: true,
    inv: ["Setting the default brand", "Default brand set"],
    hints: { destructiveHint: false, idempotentHint: true },
    why: { destructive: "Only changes which saved brand is the default; nothing is removed." },
  },
  versely_archive_brand: {
    title: "Archive brand", cls: "delete", what: "saved brand", openai: true,
    inv: ["Archiving the brand", "Brand archived"],
    why: {
      readOnly: "Archives one of the user's saved brands.",
      destructive: "The brand leaves the list and its automations pause; it can be restored from the web app.",
    },
  },
  versely_create_brand_slideshow: {
    title: "Create brand slideshow", cls: "create", what: "slideshow for a brand", openai: true,
    inv: ["Creating your brand slideshow", "Brand slideshow started"],
    hints: { openWorldHint: true },
    why: { openWorld: "When given the brand's link, reads that public page first; the slideshow stays private." },
  },

  // ── Visual picker + templates + styles (both profiles; owner, 2026-09-24) ──
  versely_browse: {
    title: "Show options to pick from", cls: "read", openai: true,
    what: "Versely's slideshow styles, avatars, voices, templates or the user's brands",
    inv: ["Opening the picker", "Picker ready"],
  },
  versely_run_ai_template: {
    title: "Run AI template", cls: "create", what: "AI template video", openai: true,
    inv: ["Starting the template", "Template started"],
  },
  versely_get_ai_template_run: {
    title: "Check AI template run", cls: "read", what: "one of the user's AI template runs", openai: true,
    inv: ["Checking the template", "Checked the template"],
  },
  versely_use_workflow_template: {
    title: "Use workflow template", cls: "create", what: "copy of a workflow template", spends: false, openai: true,
    inv: ["Copying the template", "Template copied"],
  },
  versely_use_slideshow_template: {
    title: "Use slideshow template", cls: "create", what: "slideshow from a template", openai: true,
    inv: ["Making the slideshow", "Slideshow started"],
  },
  versely_apply_caption_style: {
    title: "Restyle slideshow captions", cls: "edit", what: "slideshow captions", openai: true,
    inv: ["Restyling the captions", "Captions restyled"],
    why: {
      readOnly: "Re-bakes the captions of one of the user's slideshows in another style.",
      destructive: "Replaces the slideshow's previous caption style; the slide pictures are kept.",
    },
  },

  // ── Inspiration, outliers, hooks (both profiles; owner, 2026-09-24) ─────
  versely_list_inspiration_niches: {
    title: "List inspiration niches", cls: "read", what: "the niches of Versely's viral-post library", openai: true,
    inv: ["Loading niches", "Loaded niches"],
  },
  versely_find_inspiration: {
    title: "Find viral posts", cls: "read", what: "Versely's library of viral posts and outliers", openai: true,
    inv: ["Finding viral posts", "Found viral posts"],
  },
  versely_get_inspiration_post: {
    title: "Get viral post", cls: "read", what: "one post in Versely's viral-post library", openai: true,
    inv: ["Loading the post", "Loaded the post"],
  },
  versely_list_trending_sounds: {
    title: "List trending sounds", cls: "read", what: "the sounds behind today's viral posts", openai: true,
    inv: ["Loading trending sounds", "Loaded trending sounds"],
  },
  versely_recreate_inspiration: {
    title: "Recreate viral post", cls: "create", what: "recreation of a viral post", openai: true,
    inv: ["Recreating the post", "Recreation started"],
  },
  versely_create_hooks: {
    title: "Create hook videos", cls: "create", what: "set of hook videos", openai: true,
    inv: ["Making your hooks", "Hooks started"],
  },
  versely_get_hooks: {
    title: "Check hook videos", cls: "read", what: "one of the user's hook-video batches", openai: true,
    inv: ["Checking the hooks", "Checked the hooks"],
  },
  versely_list_hook_models: {
    title: "List hook models", cls: "read", what: "the models and settings hook videos can use", openai: true,
    inv: ["Loading hook models", "Loaded hook models"],
  },
  versely_analyze_post: {
    title: "Analyze why a post worked", cls: "create", what: "breakdown of a social post", openai: true,
    inv: ["Analyzing the post", "Post analyzed"],
    hints: { openWorldHint: true },
    why: {
      readOnly: "Reads a public social post and saves a breakdown of why it worked to the user's account; spends 1 Versely credit.",
      openWorld: "Fetches the public social post from its platform.",
    },
  },
  versely_get_post_analysis: {
    title: "Get post breakdown", cls: "read", what: "one of the user's post breakdowns", openai: true,
    inv: ["Loading the breakdown", "Loaded the breakdown"],
  },
  versely_list_post_analyses: {
    title: "List post breakdowns", cls: "read", what: "the user's post breakdowns", openai: true,
    inv: ["Loading your breakdowns", "Loaded your breakdowns"],
  },
  versely_search_social_posts: {
    title: "Search social posts", cls: "read", what: "public social posts", openai: true,
    inv: ["Searching social posts", "Searched social posts"],
    hints: { openWorldHint: true },
    why: { openWorld: "Searches public posts on TikTok, YouTube and Instagram." },
  },
  versely_get_social_post_info: {
    title: "Read a social post", cls: "read", what: "one public social post", openai: true,
    inv: ["Reading the post", "Read the post"],
    hints: { openWorldHint: true },
    why: { openWorld: "Reads a public post from its social platform." },
  },
  versely_import_social_video: {
    title: "Import a social video", cls: "create", what: "copy of a public social video in the user's library", openai: true,
    inv: ["Importing the video", "Video imported"],
    hints: { openWorldHint: true },
    why: {
      readOnly: "Downloads a public social video into the user's private Versely library; spends 1 Versely credit.",
      openWorld: "Fetches the video from its social platform.",
    },
  },

  // ── Hooks studio + post analytics (both profiles; owner, 2026-09-24) ────
  versely_list_hook_library: {
    title: "List hook clips", cls: "read", what: "Versely's library of ready-made hook clips", openai: true,
    inv: ["Loading hook clips", "Loaded hook clips"],
  },
  versely_save_hook: {
    title: "Save hook clip", cls: "create", what: "saved hook", spends: false, openai: true,
    inv: ["Saving the hook", "Hook saved"],
  },
  versely_list_saved_hooks: {
    title: "List saved hooks", cls: "read", what: "the user's saved hooks", openai: true,
    inv: ["Loading saved hooks", "Loaded saved hooks"],
  },
  versely_unsave_hook: {
    title: "Remove saved hook", cls: "delete", what: "saved hook", openai: true,
    inv: ["Removing the hook", "Hook removed"],
  },
  versely_list_music_beds: {
    title: "List music beds", cls: "read", what: "Versely's royalty-free music beds", openai: true,
    inv: ["Loading music", "Loaded music"],
  },
  versely_quote_hooks: {
    title: "Price hook collection", cls: "read", what: "the price of a hook collection", openai: true,
    inv: ["Pricing the hooks", "Priced the hooks"],
  },
  versely_reuse_hooks: {
    title: "Reuse hook clips", cls: "create", what: "set of hooks with the user's lines", openai: true,
    inv: ["Making your hooks", "Hooks started"],
  },
  versely_create_hook_pack: {
    title: "Create hook pack", cls: "create", what: "pack of hook videos", openai: true,
    inv: ["Making your hook pack", "Hook pack started"],
  },
  versely_create_character_hook_pack: {
    title: "Create character hook pack", cls: "create", what: "pack of hook videos with a character", openai: true,
    inv: ["Making your character hooks", "Character hooks started"],
  },
  versely_get_hook_collection: {
    title: "Check hook collection", cls: "read", what: "one of the user's hook collections", openai: true,
    inv: ["Checking the hooks", "Checked the hooks"],
  },
  versely_list_hook_collections: {
    title: "List hook collections", cls: "read", what: "the user's hook collections", openai: true,
    inv: ["Loading hook collections", "Loaded hook collections"],
  },
  versely_cancel_hook_collection: {
    title: "Cancel hook collection", cls: "delete", what: "hook collection in progress", openai: true,
    inv: ["Cancelling the hooks", "Hooks cancelled"],
    why: {
      readOnly: "Stops one of the user's hook collections that is still being made.",
      destructive: "Hooks not yet made are not made; finished hooks are kept.",
    },
  },
  versely_schedule_hook_collection: {
    title: "Schedule hook collection", cls: "publish", what: "scheduled posts of a hook collection", openai: true,
    inv: ["Scheduling your hooks", "Hooks scheduled"],
    why: {
      readOnly: "Schedules each hook of a collection as a post to the user's connected social accounts; posts are charged like any social post.",
      destructive:
        "The scheduled posts go out publicly without another confirmation, and Versely can't take a post back once it is live.",
    },
  },
  versely_list_hook_characters: {
    title: "List hook characters", cls: "read", what: "the user's hook characters", openai: true,
    inv: ["Loading your characters", "Loaded your characters"],
  },
  versely_create_hook_character: {
    title: "Create hook character", cls: "create", what: "hook character (with portraits)", openai: true,
    inv: ["Creating the character", "Character started"],
  },
  versely_upload_hook_character: {
    title: "Add character from photo", cls: "create", what: "hook character from a photo", spends: false, openai: true,
    inv: ["Adding the character", "Character added"],
  },
  versely_get_hook_character: {
    title: "Get hook character", cls: "read", what: "one of the user's hook characters", openai: true,
    inv: ["Loading the character", "Loaded the character"],
  },
  versely_pick_character_portrait: {
    title: "Pick character portrait", cls: "edit", what: "character's chosen portrait", openai: true,
    inv: ["Choosing the portrait", "Portrait chosen"],
    hints: { destructiveHint: false, idempotentHint: true },
    why: { destructive: "Only changes which of the character's portraits is used; nothing is removed." },
  },
  versely_delete_hook_character: {
    title: "Remove hook character", cls: "delete", what: "hook character", openai: true,
    inv: ["Removing the character", "Character removed"],
  },
  versely_get_social_analytics_overview: {
    title: "Get posting analytics", cls: "read", what: "the performance of the user's published posts", openai: true,
    inv: ["Loading your analytics", "Loaded your analytics"],
  },
  versely_get_post_analytics: {
    title: "Get post analytics", cls: "read", what: "one published post's stats as last collected", openai: true,
    inv: ["Loading the post's stats", "Loaded the post's stats"],
  },
  versely_refresh_post_analytics: {
    title: "Refresh post analytics", cls: "create", what: "reading of a published post's stats", spends: false, openai: true,
    inv: ["Fetching the latest stats", "Fetched the latest stats"],
    hints: { openWorldHint: true, idempotentHint: true },
    why: {
      readOnly: "Asks Versely to fetch the post's latest numbers from the social platform now and store them as a new reading; it does not spend credits.",
      destructive: "Adds a new reading of the post's stats; earlier readings are kept.",
      openWorld: "Reads the post's public numbers from the social platform it was published on.",
    },
  },
  versely_get_post_analytics_history: {
    title: "Get post stats history", cls: "read", what: "one published post's stats over time", openai: true,
    inv: ["Loading the stats history", "Loaded the stats history"],
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

  // ── Short dramas (both profiles; owner, 2026-11-04) ─────────────────────
  // Planning, edits, scripts and quotes are free; filming one episode is the
  // only paid call, and it carries the price the user approved (confirm_credits).
  versely_plan_drama_show: {
    title: "Plan a short drama", cls: "create", what: "short-drama plan", openai: true, spends: false,
    inv: ["Planning your show", "Show planned"],
    why: {
      readOnly:
        "Creates a new short-drama plan (season, cast portraits, Episode 1 script) in the user's private Versely library. It does not spend credits; nothing is filmed until the user approves an episode.",
    },
  },
  versely_update_drama_show: {
    title: "Edit short drama", cls: "edit", what: "short drama", openai: true,
    inv: ["Updating your show", "Show updated"],
    why: {
      destructive:
        "Overwrites the fields it is given, and a redrawn portrait replaces the old one; episodes already filmed are kept.",
    },
  },
  versely_write_drama_episode: {
    title: "Write drama episode", cls: "edit", what: "short-drama episode script", openai: true,
    inv: ["Writing the episode", "Episode written"],
    why: {
      readOnly: "Writes or rewrites the script of one episode of the user's short drama; it does not spend credits.",
      destructive: "A rewrite replaces that episode's earlier, unfilmed script.",
    },
  },
  versely_get_drama_quote: {
    title: "Price drama episode", cls: "read", what: "the price to film one episode of the user's short drama", openai: true,
    inv: ["Pricing the episode", "Priced the episode"],
  },
  versely_film_drama_episode: {
    title: "Film drama episode", cls: "create", what: "short-drama episode video", openai: true,
    inv: ["Filming your episode", "Episode filming started"],
    why: {
      readOnly:
        "Films one episode of the user's short drama into their private Versely library and spends the credits the user approved for it (refunded if filming fails).",
    },
  },
  versely_get_drama_show: {
    title: "Get short drama", cls: "read", what: "one of the user's short dramas and its episodes", openai: true,
    inv: ["Loading your show", "Loaded your show"],
  },
  versely_list_drama_shows: {
    title: "List short dramas", cls: "read", what: "the user's short dramas", openai: true,
    inv: ["Loading your shows", "Loaded your shows"],
  },
  versely_delete_drama_show: {
    title: "Delete short drama", cls: "delete", what: "short drama", openai: true,
    inv: ["Deleting the show", "Show deleted"],
    why: { destructive: "Permanently removes the show and its unfilmed scripts; episodes already filmed stay in the user's library." },
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

  // ── Social posting (both profiles; owner, 2026-09-24) ───────────────────
  versely_get_social_auth_url: {
    title: "Connect social account", cls: "create", what: "social-account connection link", spends: false, openai: true,
    inv: ["Creating a connect link", "Connect link ready"],
    hints: { openWorldHint: true },
    why: {
      readOnly: "Creates a sign-in link for connecting one of the user's social accounts to Versely.",
      destructive: "Only creates a link; nothing existing is changed or removed.",
      openWorld: "The link leads to a third-party social platform's sign-in page.",
    },
  },
  versely_list_social_accounts: {
    title: "List social accounts", cls: "read", what: "the social accounts the user connected", openai: true,
    inv: ["Loading your social accounts", "Loaded your social accounts"],
  },
  versely_refresh_social_accounts: {
    title: "Refresh social accounts", cls: "edit", what: "connected social accounts", openai: true,
    inv: ["Linking your social accounts", "Social accounts linked"],
    hints: { destructiveHint: false, openWorldHint: true, idempotentHint: true },
    why: {
      readOnly: "Links newly connected social accounts to the user's Versely account and refreshes the stored names and pictures.",
      destructive: "Only adds or updates stored account details; nothing is posted or deleted.",
      openWorld: "Reads the user's connected accounts from the social-posting provider.",
    },
  },
  versely_disconnect_social_account: {
    title: "Disconnect social account", cls: "delete", what: "social account connection", openai: true,
    inv: ["Disconnecting the account", "Account disconnected"],
    hints: { openWorldHint: true },
    why: {
      readOnly: "Disconnects one of the user's social accounts from Versely.",
      destructive: "Removes the connection; the user must reconnect before Versely can post there again.",
      openWorld: "Stops Versely from posting to that third-party social account.",
    },
  },
  versely_preview_post: {
    title: "Preview social post", cls: "read", what: "a preview of a social post", openai: true,
    inv: ["Previewing your post", "Post previewed"],
    why: {
      readOnly: "Only renders a preview of a post; nothing is published, saved or charged.",
      openWorld: "Nothing is posted; the preview is returned only to the user.",
    },
  },
  versely_publish_post: {
    title: "Publish social post", cls: "publish", what: "a post (caption and media)", openai: true,
    inv: ["Publishing your post", "Post sent"],
    why: {
      readOnly:
        "Publishes (or schedules) a post from the user's Versely account to the social accounts they connected, and spends the user's Versely credits for each account.",
    },
  },
  versely_list_posts: {
    title: "List social posts", cls: "read", what: "the user's social posts", openai: true,
    inv: ["Loading your posts", "Loaded your posts"],
  },
  versely_get_post: {
    title: "Get social post", cls: "read", what: "one of the user's social posts and its links", openai: true,
    inv: ["Loading the post", "Loaded the post"],
  },
  versely_update_post: {
    title: "Reschedule social post", cls: "edit", what: "scheduled social post", openai: true,
    inv: ["Updating the post", "Post updated"],
    hints: { openWorldHint: true },
    why: {
      readOnly: "Changes the time and/or caption of one of the user's scheduled posts; no extra credits are spent.",
      destructive: "Replaces the post's earlier time and caption.",
      openWorld: "Updates the scheduled post at the social-posting provider that will publish it.",
    },
  },
  versely_delete_post: {
    title: "Delete social post", cls: "delete", what: "social post", openai: true,
    inv: ["Deleting the post", "Post deleted"],
    hints: { openWorldHint: true },
    why: {
      readOnly:
        "Deletes one of the user's social posts from Versely; a post that is still scheduled is cancelled and its credits refunded.",
      destructive: "Permanently removes the post from Versely; a cancelled scheduled post is never published.",
      openWorld:
        "Cancels the scheduled post at the social-posting provider. Posts already published stay live on the platforms.",
    },
  },
  versely_get_posting_plan: {
    title: "Get posting cost", cls: "read", what: "what posting costs the user and how many accounts they can connect", openai: true,
    inv: ["Checking posting costs", "Checked posting costs"],
  },

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

  // ── Workflows (both profiles; owner, 2026-09-24) ────────────────────────
  versely_create_workflow: {
    title: "Create workflow", cls: "create", what: "workflow", spends: false, openai: true,
    inv: ["Creating your workflow", "Workflow created"],
  },
  versely_list_workflows: {
    title: "List workflows", cls: "read", what: "the user's workflows", openai: true,
    inv: ["Loading your workflows", "Loaded your workflows"],
  },
  versely_get_workflow: {
    title: "Get workflow", cls: "read", what: "one of the user's workflows", openai: true,
    inv: ["Loading the workflow", "Loaded the workflow"],
  },
  versely_update_workflow: {
    title: "Edit workflow", cls: "edit", what: "workflow", openai: true,
    inv: ["Updating the workflow", "Workflow updated"],
  },
  versely_delete_workflow: {
    title: "Delete workflow", cls: "delete", what: "workflow", openai: true,
    inv: ["Deleting the workflow", "Workflow deleted"],
  },
  versely_duplicate_workflow: {
    title: "Duplicate workflow", cls: "create", what: "copy of a workflow", spends: false, openai: true,
    inv: ["Duplicating the workflow", "Workflow duplicated"],
  },
  versely_export_workflow: {
    title: "Export workflow", cls: "read", what: "one of the user's workflows as portable JSON", openai: true,
    inv: ["Exporting the workflow", "Workflow exported"],
  },
  versely_update_workflow_mode: {
    title: "Set workflow mode", cls: "edit", what: "workflow schedule and auto-post settings", openai: true,
    inv: ["Updating the workflow schedule", "Workflow schedule updated"],
    hints: { openWorldHint: true },
    why: {
      openWorld:
        "Can switch on automatic posting, after which future scheduled runs publish to the user's connected social platforms.",
    },
  },
  versely_update_workflow_schedule: {
    title: "Set workflow schedule", cls: "edit", what: "workflow schedule", openai: true,
    inv: ["Updating the schedule", "Schedule updated"],
  },
  versely_update_workflow_dates: {
    title: "Set workflow run dates", cls: "edit", what: "workflow run dates", openai: true,
    inv: ["Updating the run dates", "Run dates updated"],
  },
  versely_update_workflow_assets: {
    title: "Set workflow media", cls: "edit", what: "workflow media list", openai: true,
    inv: ["Updating the workflow media", "Workflow media updated"],
  },
  versely_run_workflow: {
    title: "Run workflow", cls: "publish", what: "workflow results", openai: true,
    inv: ["Starting your workflow", "Workflow started"],
    why: {
      readOnly: "Runs one of the user's saved workflows, which generates media and spends the user's Versely credits.",
      destructive:
        "When the workflow auto-posts, its results go out publicly, and Versely can't take a post back once it is live.",
      openWorld: "When the workflow is set to auto-post, its results are published to the user's connected social platforms.",
    },
  },
  versely_list_workflow_runs: {
    title: "List workflow runs", cls: "read", what: "the run history of one of the user's workflows", openai: true,
    inv: ["Loading the runs", "Loaded the runs"],
  },
  versely_get_workflow_run: {
    title: "Check workflow run", cls: "read", what: "the progress of one of the user's workflow runs", openai: true,
    inv: ["Checking the run", "Checked the run"],
  },
  versely_list_active_workflow_runs: {
    title: "List running workflows", cls: "read", what: "the user's workflow runs still in progress", openai: true,
    inv: ["Loading running workflows", "Loaded running workflows"],
  },
  versely_list_failed_workflow_runs: {
    title: "List failed workflow runs", cls: "read", what: "the user's failed or cancelled workflow runs", openai: true,
    inv: ["Loading failed runs", "Loaded failed runs"],
  },
  versely_summarize_workflow: {
    title: "Summarize workflow", cls: "read", what: "run statistics for one of the user's workflows", openai: true,
    inv: ["Summarizing the workflow", "Workflow summarized"],
  },
  versely_list_scheduled_workflows: {
    title: "List scheduled workflows", cls: "read", what: "the user's scheduled workflows", openai: true,
    inv: ["Loading scheduled workflows", "Loaded scheduled workflows"],
  },
  versely_create_workflow_asset: {
    title: "Create workflow asset", cls: "create", what: "workflow asset", spends: false, openai: true,
    inv: ["Creating the asset", "Asset created"],
  },
  versely_list_workflow_assets: {
    title: "List workflow assets", cls: "read", what: "the user's workflow assets", openai: true,
    inv: ["Loading your assets", "Loaded your assets"],
  },
  versely_get_workflow_asset: {
    title: "Get workflow asset", cls: "read", what: "one of the user's workflow assets", openai: true,
    inv: ["Loading the asset", "Loaded the asset"],
  },
  versely_update_workflow_asset: {
    title: "Edit workflow asset", cls: "edit", what: "workflow asset", openai: true,
    inv: ["Updating the asset", "Asset updated"],
  },
  versely_add_workflow_asset_images: {
    title: "Add workflow asset images", cls: "create", what: "set of reference images on a workflow asset", spends: false,
    openai: true, inv: ["Adding the images", "Images added"],
    why: { destructive: "Only appends images; the asset's existing images are kept." },
  },
  versely_delete_workflow_asset: {
    title: "Delete workflow asset", cls: "delete", what: "workflow asset", openai: true,
    inv: ["Deleting the asset", "Asset deleted"],
  },
  versely_prepare_workflow_assets: {
    title: "Prepare workflow assets", cls: "create", what: "batch of workflow assets", spends: false, openai: true,
    inv: ["Preparing the assets", "Assets prepared"],
  },

  // ── Video-workflow runs (both profiles) ─────────────────────────────────
  versely_list_video_workflow_runs: {
    title: "List video workflow runs", cls: "read", what: "the user's video-workflow runs", openai: true,
    inv: ["Loading video workflow runs", "Loaded video workflow runs"],
  },
  versely_get_video_workflow_run: {
    title: "Check video workflow run", cls: "read", what: "the progress of one of the user's video-workflow runs", openai: true,
    inv: ["Checking the run", "Checked the run"],
  },
  versely_cancel_video_workflow_run: {
    title: "Cancel video workflow run", cls: "delete", what: "video-workflow run", openai: true,
    inv: ["Cancelling the run", "Run cancelled"],
    why: {
      readOnly: "Cancels one of the user's video-workflow runs that is still in progress.",
      destructive: "Stops the scenes that have not finished; a cancelled run cannot be resumed. Finished scenes are kept.",
    },
  },
  versely_combine_video_workflow_run: {
    title: "Recombine video workflow run", cls: "edit", what: "video-workflow run", openai: true,
    inv: ["Combining the video", "Video combined"],
    why: {
      readOnly: "Re-renders the final video of one of the user's video-workflow runs from its finished scenes.",
      destructive: "Replaces the run's final combined video; the scene videos are kept.",
    },
  },
  versely_retry_video_workflow_scene: {
    title: "Retry video workflow scene", cls: "edit", what: "video-workflow run", spends: true, openai: true,
    inv: ["Retrying the scene", "Scene retry started"],
    why: { destructive: "Re-renders the failed scene and the scenes that depend on it, replacing their earlier output." },
  },

  // ── Automations (both profiles; owner, 2026-09-24) ──────────────────────
  versely_list_slideshow_options: {
    title: "List slideshow options", cls: "read", openai: true,
    what: "the slideshow models, caption styles and categories, and the user's brands",
    inv: ["Loading slideshow options", "Loaded slideshow options"],
  },
  versely_estimate_slideshow_automation: {
    title: "Estimate automation cost", cls: "read", openai: true,
    what: "the credit cost of one run of a slideshow automation",
    inv: ["Estimating the cost", "Estimated the cost"],
    why: { readOnly: "Only computes what one post would cost; nothing is created, changed or charged." },
  },
  versely_create_slideshow_automation: {
    title: "Create slideshow automation", cls: "create", what: "slideshow automation", spends: false, openai: true,
    inv: ["Setting up your automation", "Automation set up"],
    hints: { destructiveHint: true, openWorldHint: true },
    why: {
      readOnly:
        "Saves a slideshow automation in the user's Versely account. Saving it spends and posts nothing; posts are made only when versely_create_automation_posts queues them, each spending the user's Versely credits.",
      destructive:
        "When posts are queued for it and it is set to post, they publish without another confirmation, and Versely can't take a post back once it is live.",
      openWorld: "Stores the connected social accounts its queued posts will be published to.",
    },
  },
  versely_list_automations: {
    title: "List automations", cls: "read", what: "the user's automations", openai: true,
    inv: ["Loading your automations", "Loaded your automations"],
  },
  versely_get_automation: {
    title: "Get automation", cls: "read", what: "one of the user's automations", openai: true,
    inv: ["Loading the automation", "Loaded the automation"],
  },
  versely_update_automation: {
    title: "Edit automation", cls: "edit", what: "automation", openai: true,
    inv: ["Updating the automation", "Automation updated"],
    hints: { openWorldHint: true },
    why: {
      openWorld: "Can change which connected social accounts its future runs post to.",
    },
  },
  versely_start_automation: {
    title: "Start automation", cls: "edit", what: "automation", openai: true,
    inv: ["Starting the automation", "Automation started"],
    hints: { destructiveHint: true, openWorldHint: true, idempotentHint: true },
    why: {
      readOnly: "Resumes one of the user's automations: its queued posts are made again, each spending the user's Versely credits.",
      destructive:
        "When it is set to post, the resumed posts publish without another confirmation, and Versely can't take a post back once it is live.",
      openWorld: "When it is set to post, each resumed post publishes to the user's connected social accounts.",
    },
  },
  versely_pause_automation: {
    title: "Pause automation", cls: "edit", what: "automation", openai: true,
    inv: ["Pausing the automation", "Automation paused"],
    hints: { destructiveHint: false, idempotentHint: true },
    why: {
      readOnly: "Pauses one of the user's automations; its queued posts wait.",
      destructive: "Only holds the queued posts; nothing is deleted, and it can be resumed.",
    },
  },
  versely_run_automation_now: {
    title: "Run automation now", cls: "publish", what: "automation run", openai: true,
    inv: ["Running the automation", "Automation run started"],
    why: {
      readOnly: "Queues one extra post of the user's automation, made now, which spends the user's Versely credits.",
      destructive:
        "When the automation is set to post, the slideshow goes out publicly, and Versely can't take a post back once it is live.",
      openWorld: "When the automation is set to post, the new slideshow is published to the user's connected social accounts.",
    },
  },
  versely_quote_automation_posts: {
    title: "Quote automation posts", cls: "read", what: "the credits and days of N posts of one of the user's automations", openai: true,
    inv: ["Pricing the posts", "Priced the posts"],
    why: { readOnly: "A dry run: works out the price and the posting days; nothing is queued, changed or charged." },
  },
  versely_create_automation_posts: {
    title: "Queue automation posts", cls: "publish", what: "queued automation posts", openai: true,
    inv: ["Queueing the posts", "Posts queued"],
    why: {
      readOnly:
        "Queues posts of the user's automation: each is made in their Versely library and spends the credits the user approved for them.",
      destructive:
        "When the automation is set to post, each post publishes on its day without another confirmation, and Versely can't take a post back once it is live.",
      openWorld: "When the automation is set to post, the posts are published to the user's connected social accounts.",
    },
  },
  versely_stop_automation: {
    title: "Stop automation", cls: "delete", what: "queued automation posts", openai: true,
    inv: ["Stopping the automation", "Automation stopped"],
    why: {
      readOnly: "Drops the posts queued but not made yet for one of the user's automations, and pauses it.",
      destructive: "The queued posts are removed (they were never charged); posts already made keep their booked times.",
    },
  },
  versely_delete_automation: {
    title: "Delete automation", cls: "delete", what: "automation", openai: true,
    inv: ["Deleting the automation", "Automation deleted"],
    why: { destructive: "Permanently removes the automation; the slideshows it already made are kept." },
  },
  versely_list_automation_runs: {
    title: "List automation runs", cls: "read", what: "the run history of one of the user's automations", openai: true,
    inv: ["Loading the runs", "Loaded the runs"],
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

  // ── Uploads ─────────────────────────────────────────────────────────────
  versely_upload_media: {
    title: "Store a file in Versely", cls: "create", what: "copy of the user's photo, video or audio file", openai: true, spends: false,
    inv: ["Storing your file in Versely", "File stored"],
    why: {
      readOnly: "Stores a copy of a photo, video or audio file the user provided in their private Versely library; it does not spend credits.",
      destructive: "Only adds a new file; nothing existing is changed or deleted.",
      openWorld: "The file is the user's own attachment and is kept privately in their Versely library; nothing is posted or shared.",
    },
  },

  // ── Remix: Swap and Copy the moves ──────────────────────────────────────
  versely_list_remix_trends: {
    title: "List remix trends", cls: "read", what: "Versely's Remix trend library", openai: true,
    inv: ["Loading trends to remix", "Loaded trends to remix"],
  },
  versely_prepare_remix_clip: {
    title: "Prepare clip to remix", cls: "create", what: "short clip to remix", openai: true, spends: false,
    inv: ["Getting the clip ready", "Clip ready"],
    why: {
      readOnly: "Cuts a private 4 to 15 second clip for the user's own remix, kept for 6 days; it does not spend credits.",
      destructive: "Only adds a temporary clip; nothing existing is changed or deleted.",
      openWorld: "The clip is stored privately for this user's own remix; nothing is posted or shared.",
    },
  },
  versely_quote_swap: {
    title: "Quote a remix", cls: "read", what: "the price of remixing the user's prepared clip, and their credit balance", openai: true,
    inv: ["Pricing your remix", "Priced your remix"],
  },
  versely_swap_video: {
    title: "Swap into a video", cls: "create", what: "remixed video", openai: true,
    inv: ["Starting your remix", "Remix started"],
  },
  versely_get_swap: {
    title: "Check remix", cls: "read", what: "the status of the user's remix jobs", openai: true,
    inv: ["Checking your remix", "Checked your remix"],
  },

  // ── musicVideo ──
  versely_quote_music_video: {
    title: "Quote music video", cls: "read", what: "the price of a music video of one of the user's songs", openai: true,
    inv: ["Pricing the music video", "Priced the music video"],
  },
  versely_create_music_video: {
    title: "Create music video", cls: "create", what: "music video", openai: true,
    inv: ["Starting your music video", "Music video started"],
    why: {
      readOnly:
        "Makes a music video from one of the user's songs into their private Versely library and spends the credits the user approved for it (refunded if it fails).",
    },
  },
  versely_get_music_video: {
    title: "Get music video", cls: "read", what: "the status of the user's music video", openai: true,
    inv: ["Checking your music video", "Checked your music video"],
  },

  // ── aiLooks ──
  versely_list_photo_looks: {
    title: "List photo looks", cls: "read", what: "Versely's photo looks and their prices", openai: true,
    inv: ["Loading photo looks", "Loaded photo looks"],
  },
  versely_apply_photo_look: {
    title: "Apply photo look", cls: "create", what: "restyled photo", openai: true,
    inv: ["Applying the photo look", "Photo look started"],
    why: {
      readOnly:
        "Re-shoots one of the user's photos in the chosen look as a new image in their private Versely library and spends the credits the user approved for it (refunded if it fails).",
    },
  },
  versely_get_photo_look: {
    title: "Get photo look", cls: "read", what: "the status of the user's photo look", openai: true,
    inv: ["Checking your photo look", "Checked your photo look"],
  },

  // ── styledCaptions ──
  // ── Captions studio (both profiles; 2026-11-14) ─────────────────────────
  // Free looks cost nothing. A premium look is charged per started minute of
  // video; versely_caption_video only quotes it until the call carries that
  // exact price (confirm_credits).
  versely_list_caption_looks: {
    title: "List caption looks", cls: "read", what: "the caption looks the user can pick and what each costs", openai: true,
    inv: ["Loading caption looks", "Loaded caption looks"],
  },
  versely_caption_video: {
    title: "Caption a video", cls: "create", what: "captioned copy of a video", openai: true,
    inv: ["Starting your captions", "Captions started"],
    why: {
      readOnly:
        "Starts a captioned copy of the user's video in their private Versely library. Free looks cost nothing; a premium look spends only the credits the user approved for it (refunded if it fails), and without that approval the call only returns the price.",
    },
  },
  versely_get_caption_job: {
    title: "Check captions", cls: "read", what: "one of the user's captions jobs", openai: true,
    inv: ["Checking your captions", "Checked your captions"],
  },

  // ── scripts ──
  // ── Scripts: remix a viral script (both profiles; 2026-11-14) ───────────
  // Writing a script is the only paid call: a fixed price from /scripts/pricing,
  // started only with that exact price (confirm_credits). Voice profiles are free.
  versely_write_script: {
    title: "Write a script", cls: "create", what: "video script", openai: true,
    inv: ["Writing your script", "Script written"],
    hints: { openWorldHint: true },
    why: {
      readOnly:
        "Writes a new script into the user's private Versely scripts and spends the fixed credits the user approved (refunded if no script comes out); without that approval the call only returns the price.",
      openWorld: "Reads the public social post the user links to, when the script remixes one; nothing is posted.",
    },
  },
  versely_get_script: {
    title: "Get script", cls: "read", what: "one of the user's scripts", openai: true,
    inv: ["Loading your script", "Loaded your script"],
  },
  versely_list_scripts: {
    title: "List scripts", cls: "read", what: "the user's scripts", openai: true,
    inv: ["Loading your scripts", "Loaded your scripts"],
  },
  versely_update_script: {
    title: "Edit script", cls: "edit", what: "script", openai: true,
    inv: ["Updating your script", "Script updated"],
  },
  versely_delete_script: {
    title: "Delete script", cls: "delete", what: "script", openai: true,
    inv: ["Deleting the script", "Script deleted"],
  },
  versely_get_voice_profile: {
    title: "Get voice profile", cls: "read", what: "the user's voice profile", openai: true,
    inv: ["Loading your voice profile", "Loaded your voice profile"],
  },
  versely_build_voice_profile: {
    title: "Build voice profile", cls: "create", what: "voice profile", openai: true, spends: false,
    inv: ["Learning your voice", "Voice profile built"],
    hints: { destructiveHint: true, openWorldHint: true },
    why: {
      readOnly:
        "Learns how the user talks from the public videos of their own Instagram or TikTok account and saves it as their voice profile; it does not spend credits.",
      destructive: "A finished rebuild replaces the user's previous voice profile.",
      openWorld: "Reads the public posts of the social account the user names; nothing is posted.",
    },
  },
  versely_delete_voice_profile: {
    title: "Delete voice profile", cls: "delete", what: "voice profile", openai: true,
    inv: ["Deleting your voice profile", "Voice profile deleted"],
  },

  // ── ugcAds ──
  // ── UGC ads (presenter reads the user's script) ─────────────────────────
  versely_list_ugc_actors: {
    title: "List UGC ad presenters", cls: "read", what: "the presenters for the user's UGC ads, including their own avatars", openai: true,
    inv: ["Loading presenters", "Loaded presenters"],
  },
  versely_list_ugc_voices: {
    title: "List UGC ad voices", cls: "read", what: "the voices for the user's UGC ads, including their cloned voices", openai: true,
    inv: ["Loading voices", "Loaded voices"],
  },
  versely_write_ugc_script: {
    title: "Write UGC ad scripts", cls: "read", what: "the user's product details to write ad script options", openai: true,
    inv: ["Writing ad scripts", "Ad scripts written"],
    hints: { openWorldHint: true },
    why: {
      readOnly: "Writes three ad script options from the user's brief, product link or brand and returns them; nothing is saved, changed or charged.",
      openWorld: "Given a product link, Versely reads that public web page to learn about the product; nothing is posted or shared.",
    },
  },
  versely_quote_ugc_ads: {
    title: "Price UGC ads", cls: "read", what: "the price of a batch of UGC ads for the user's script", openai: true,
    inv: ["Pricing your ads", "Priced your ads"],
  },
  versely_create_ugc_ads: {
    title: "Create UGC ads", cls: "create", what: "UGC ad videos", openai: true,
    inv: ["Starting your UGC ads", "UGC ads started"],
    why: {
      readOnly:
        "Starts 1-4 UGC ad videos in the user's private Versely library and spends the credits the user approved for them (an ad that fails is refunded its share).",
    },
  },
  versely_get_ugc_ads: {
    title: "Get UGC ads", cls: "read", what: "one batch of the user's UGC ads and its videos", openai: true,
    inv: ["Checking your ads", "Checked your ads"],
  },
  versely_list_ugc_ads: {
    title: "List UGC ads", cls: "read", what: "the user's recent UGC ads", openai: true,
    inv: ["Loading your ads", "Loaded your ads"],
  },

  // ── avatarStudio ──
  // ── Avatar Studio (avatars are hook characters) ─────────────────────────
  versely_list_ready_made_avatars: {
    title: "List ready-made avatars", cls: "read", what: "Versely's ready-made avatar cast", openai: true,
    inv: ["Loading ready-made avatars", "Loaded ready-made avatars"],
  },
  versely_add_ready_made_avatar: {
    title: "Add ready-made avatar", cls: "create", what: "avatar from Versely's ready-made cast", spends: false, openai: true,
    inv: ["Adding the avatar", "Avatar added"],
    hints: { idempotentHint: true },
    why: {
      readOnly:
        "Adds a ready-made person to the user's own avatars in their private Versely library; it does not spend credits. Adding the same person again returns the avatar the user already has.",
    },
  },
  versely_list_avatar_creations: {
    title: "List avatar creations", cls: "read", what: "the slideshows, hook packs and UGC ads the user made with one of their avatars", openai: true,
    inv: ["Loading creations", "Loaded creations"],
  },

  // ── aiCreator ──
  // ── AI creators (both profiles; 2026-11-14) ─────────────────────────────
  // One avatar, room and voice that post a new video every day. Options,
  // create, edit and the episode list are free; rooms and a test take carry
  // the price the user approved (confirm_credits); approval starts the daily
  // paid episodes and their posts.
  versely_list_ai_creator_options: {
    title: "AI creator options", cls: "read", what: "the user's AI creator choices: avatars, voices, formats and prices", openai: true,
    inv: ["Loading AI creator options", "Loaded AI creator options"],
  },
  versely_get_ai_creator_rooms: {
    title: "Get AI creator rooms", cls: "read", what: "the newest set of room pictures the user made for an AI creator", openai: true,
    inv: ["Loading your rooms", "Loaded your rooms"],
  },
  versely_make_ai_creator_rooms: {
    title: "Make AI creator rooms", cls: "create", what: "AI creator room pictures", openai: true,
    inv: ["Drawing the rooms", "Rooms drawn"],
    why: {
      readOnly:
        "Draws four pictures of the avatar in a room into the user's private Versely storage and spends the credits the user approved for them (pictures that fail are refunded).",
    },
  },
  versely_create_ai_creator: {
    title: "Create AI creator", cls: "create", what: "AI creator", openai: true, spends: false,
    inv: ["Setting up your AI creator", "AI creator set up"],
    why: {
      readOnly:
        "Creates an AI creator in the user's Versely account. Creating it spends nothing and posts nothing; it waits until the user approves a test take.",
    },
  },
  versely_update_ai_creator: {
    title: "Edit AI creator", cls: "edit", what: "AI creator", openai: true,
    inv: ["Updating your AI creator", "AI creator updated"],
    hints: { openWorldHint: true },
    why: {
      destructive: "Overwrites the settings it is given; episodes already made are kept.",
      openWorld: "Can change which connected social account, and at what daily time, its future episodes post to.",
    },
  },
  versely_test_ai_creator_episode: {
    title: "Make AI creator test take", cls: "create", what: "AI creator test episode video", openai: true,
    inv: ["Making the test take", "Test take started"],
    why: {
      readOnly:
        "Makes one test episode into the user's private Versely library (it is never posted) and spends the credits the user approved for it (refunded if it fails).",
    },
  },
  versely_list_ai_creator_episodes: {
    title: "Get AI creator episodes", cls: "read", what: "one of the user's AI creators and its episodes", openai: true,
    inv: ["Loading the episodes", "Loaded the episodes"],
  },
  versely_approve_ai_creator: {
    title: "Approve AI creator", cls: "publish", what: "AI creator daily posting", openai: true,
    inv: ["Approving your AI creator", "AI creator is live"],
    hints: { destructiveHint: true },
    why: {
      readOnly:
        "Makes the user's AI creator live: from then on it makes one episode a day, each spending the user's Versely credits.",
      destructive:
        "Its daily episodes publish without another confirmation, and Versely can't take a post back once it is live.",
      openWorld: "Each daily episode is posted to the user's connected social account.",
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
