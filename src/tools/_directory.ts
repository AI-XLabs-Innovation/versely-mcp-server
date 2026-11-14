// The ChatGPT directory catalog: the tools OpenAI's plugin portal scans,
// reviews and publishes, with the compact wording they are listed under.
//
// Why it exists. The portal's tool scan fails without an error once the tool
// definitions pass a size ceiling: 209 tools (56k tokens of name + description
// + input schema) never completed; 39 tools (13.8k) completed at once. OpenAI
// support's stated limit is 16,000 tokens for all tools combined. So ChatGPT
// gets a subset of the openai profile, each tool re-worded to the minimum a
// model needs. Shared rules (credits, confirm_credits, the card) live in the
// server instructions instead of being repeated per tool.
//
// Who gets it: connections on /mcp/openai and ChatGPT's own OAuth tokens. They
// can list and call ONLY these tools. `?profile=openai` with another token
// still serves the whole openai profile, which is what the smoke test drives.
//
// Rules for an entry:
//   d      the description (may name only tools in this catalog)
//   p      input descriptions by path ("swaps[].image_url"); null = none.
//          Every advertised top-level input must appear in p or hide.
//   hide   inputs not advertised (still accepted; their defaults apply)
//   enums  a narrower list of allowed values to advertise
// The smoke test holds the whole catalog to a size budget.

type Json = Record<string, unknown>;

export interface DirectoryEntry {
  d: string;
  p?: Readonly<Record<string, string | null>>;
  hide?: readonly string[];
  enums?: Readonly<Record<string, readonly string[]>>;
}

const CARD = "The card follows it; check only when you need the result,";
const PRICE = "The exact price the user approved.";

export const OPENAI_DIRECTORY: Readonly<Record<string, DirectoryEntry>> = {
  // ── Account and files ──────────────────────────────────────────────────────
  versely_get_credits: {
    d: "The user's Versely credit balance. free_account: true means the account is on the plugin's free trial: only models marked free_trial in versely_find_models work and some features are unavailable; say so plainly.",
  },
  versely_list_user_media: {
    d: "List the user's Versely creations of one type, newest first.",
    p: { type: null, limit: "Default 10.", offset: null },
  },
  versely_upload_media: {
    d: "Store a photo, video or audio file the user attached in this chat in their private Versely library and return its URL for other Versely tools. Free. Photos up to 30 MB, videos 200 MB, audio 60 MB. Only files the user provided themselves.",
    p: { file: "The attached file.", "file.download_url": null, "file.file_id": null, "file.mime_type": null, "file.file_name": null },
  },

  // ── Models and generation ──────────────────────────────────────────────────
  versely_find_models: {
    d: "List Versely's image, video, voiceover and lip-sync models, best first (rank 1 tops the latest independent leaderboard), with prices in credits: per image, per 5 s of video (or credits_per_second times the length), per 1,000 characters of voiceover. Call it before a generate tool and pass an entry's `name` as `model`; never guess a name. When on_free_trial is true, generate only with models marked free_trial.",
    p: { type: "Omit for all four.", q: "Words in the model's name.", free_trial_only: null, limit: "Default 30." },
  },
  versely_get_model_inputs: {
    d: "The inputs one model accepts: names, allowed values, defaults, and the voices of a voiceover model. Pass them as top-level arguments to the matching generate tool.",
    p: { model: "A `name` from versely_find_models." },
  },
  versely_generate_image: {
    d: "Generate images from a prompt, optionally from reference images. Spends credits per image.",
    p: {
      model: "Image model `name` from versely_find_models.",
      prompt: null,
      negative_prompt: null,
      num_images: "Default 1.",
      aspect_ratio: "e.g. '1:1', '9:16'.",
      resolution: "For models that list one; higher costs more.",
      image_urls: "Reference images to edit or follow.",
    },
    hide: ["seed"],
  },
  versely_generate_video: {
    d: "Generate a video from a prompt, optionally from a starting image (models whose modes are i2v only need one). Spends credits by model and length; takes a few minutes.",
    p: {
      model: "Video model `name` from versely_find_models.",
      prompt: null,
      image_url: "Starting frame.",
      end_image_url: "End frame, for first-last-frame models.",
      duration_seconds: "Default 5; sets the price.",
      aspect_ratio: null,
      resolution: null,
    },
    hide: ["image_urls", "seed"],
  },
  versely_generate_audio: {
    d: "Generate a voiceover (text to speech). Pick the voice yourself from versely_list_voices or versely_get_model_inputs instead of asking; omit it for the model's default. Spends credits by length.",
    p: {
      model: "Voiceover model `name` from versely_find_models (type 'audio').",
      text: null,
      voice: "A voice `id`, not its name.",
      language: null,
      style_prompt: "Delivery, for models that take one: 'warm, a little faster'.",
    },
    hide: ["voice_id"],
  },
  versely_list_voices: {
    d: "List one provider's voices for versely_generate_audio; pass a voice's `id` as `voice`. Providers and the models they serve: elevenlabs (Eleven Labs Speech Turbo, Multilingual), minimax (Minimax Speech), gemini (Gemini TTS), qwen (Qwen 3 TTS), grok (Grok TTS), chatterbox (Chatterbox TTS).",
    p: { provider: null, query: "Words in the name, description, language or accent.", language: null, gender: null, limit: "Default 25." },
    hide: ["accent", "tag", "offset", "refresh"],
    enums: { provider: ["elevenlabs", "minimax", "gemini", "qwen", "grok", "chatterbox"] },
  },
  versely_generate_music: {
    d: "Generate a song or instrumental from a description, optionally with your own lyrics. Models: Suno V6 (default; full songs), Lyria 3.5 (songs or instrumentals; can fit an image_url), MiniMax Music 3 (needs lyrics), ElevenLabs Music V2.5 and Sonilo Text to Music (set duration_seconds; Sonilo can score a video_url). Spends credits.",
    p: {
      prompt: "Genre, mood, instruments, vocals.",
      model: null,
      lyrics: "Words to sing; with Suno the prompt then sets the style.",
      instrumental: null,
      duration_seconds: "MiniMax, ElevenLabs and Sonilo only; default 60.",
      title: null,
      image_url: null,
      video_url: null,
    },
    hide: ["style", "custom_mode", "negative_tags", "vocal_gender", "style_weight", "weirdness_constraint", "audio_weight", "persona_id"],
  },
  versely_generate_sound_effect: {
    d: "Generate a sound effect from a description (whoosh, rain, crowd, click), or one that matches a video. 0.5 to 22 s. Spends credits.",
    p: { prompt: "What it should sound like; required without video_url.", duration_seconds: "Default 10.", loop: null, video_url: "A video to match." },
    hide: ["model", "prompt_influence", "bpm", "key"],
  },
  versely_generate_lipsync: {
    d: "Make a talking video with a lip-sync model from versely_find_models (type 'lipsync'). Three kinds: a photo that speaks (image_url + audio_url), a video re-synced to new speech (video_url + audio_url), or a stock avatar reading a script (avatar_id + script; pick the avatar, and a voice_id where the model needs one, with versely_list_avatars). versely_get_model_inputs says what a model takes. A voiceover from versely_generate_audio works as audio_url. Billed per second of video.",
    p: {
      model: null,
      image_url: "Face photo to animate.",
      audio_url: "The speech.",
      video_url: "Video to re-sync.",
      script: "Text an avatar speaks.",
      prompt: null,
      avatar_id: null,
      voice_id: null,
      resolution: null,
    },
  },
  versely_list_avatars: {
    d: "Stock avatars (and voices) for the avatar lip-sync models. Pass the chosen avatar_id, and voice_id for HeyGen, to versely_generate_lipsync.",
    p: { model: null, q: null, gender: null, orientation: null, language: "Voices: only this language.", limit: "Default 30." },
  },
  versely_get_task_status: {
    d: "Status and result links of a generation. The card already shows progress, so call this only when you need the links, at most every 15 to 30 s.",
    p: { request_id: null },
  },

  // ── Remix (Swap, Copy the moves) ───────────────────────────────────────────
  versely_list_remix_trends: {
    d: "The Remix trend library: short trending clips to recreate with the user in them, by tab; 'versely' holds Versely's own ready-made moves. Each item says whether it suits a swap or copying the moves. Free. To let the user pick visually use versely_browse (collection 'remix_trends'). Next: versely_prepare_remix_clip.",
    p: { tab: null, limit: null, cursor: "next_cursor of the previous page." },
  },
  versely_prepare_remix_clip: {
    d: "Cut a 4 to 15 s clip, with its sound, ready to remix. Free. Give exactly one of trend_id, move_id, link or video_url. Without start and end the liveliest 8 s or so is used; shorter costs less. Returns a clip_id for versely_quote_swap and versely_swap_video. For a link or their own video the user must own the clip or have permission to use it.",
    p: {
      trend_id: "From versely_list_remix_trends or the picker.",
      move_id: "A Versely ready-made move.",
      link: "A TikTok, Instagram, YouTube or X post.",
      video_url: "The user's own video, stored with versely_upload_media.",
      start: "Seconds.",
      end: "Seconds.",
    },
  },
  versely_quote_swap: {
    d: "The exact credits to remix a prepared clip, and the user's balance. Free. Show it before versely_swap_video. When the balance is short it lists what the balance covers: offer that.",
    p: {
      clip_id: null,
      type: "'swap': replace people, outfits, products, places or the style and keep the rest. 'moves': one character performs the clip's motion.",
      resolution: "480p costs least.",
      quality: "'plus' costs more.",
      versions: "Each is charged.",
    },
  },
  versely_swap_video: {
    d: "Remix a prepared clip. 'swap' replaces what `swaps` names with the photo or avatar given for each and keeps the clip's motion, camera, cuts and sound; 'moves' makes one character perform the clip's motion. It cannot change what is said. Paid: first versely_quote_swap, show the price, and have the user confirm they own or may use the clip and that anyone whose photo goes in has agreed; then pass confirm_credits and rights_confirmed. Not allowed: nudity, sexual content, or a celebrity's or public figure's face. Takes a few minutes; failed versions are refunded.",
    p: {
      clip_id: null,
      type: null,
      swaps: "One entry per thing replaced; each has image_url or avatar_id.",
      "swaps[].replaces": "For 'moves': person, optionally place and style.",
      "swaps[].target": "Which one, e.g. 'the woman on the left'; omit when there is only one.",
      "swaps[].image_url": "Photo of what goes in; store the user's own with versely_upload_media.",
      "swaps[].avatar_id": "An avatar instead: the user's (versely_list_hook_characters) or a ready-made one (versely_list_ready_made_avatars).",
      note: "Extra direction in the user's words.",
      resolution: null,
      quality: null,
      versions: null,
      confirm_credits: "The quoted price the user approved.",
      rights_confirmed: "true only after the user confirmed the rights above.",
    },
  },
  versely_get_swap: {
    d: `Progress and finished videos of a remix. ${CARD} at most once a minute.`,
    p: { job_ids: "From versely_swap_video." },
  },

  // ── Avatars ────────────────────────────────────────────────────────────────
  versely_list_ready_made_avatars: {
    d: "Versely's ready-made avatars: fictional adult characters with portraits. Free. An id works as avatar_id in versely_swap_video; for talking ads add it first with versely_add_ready_made_avatar.",
    p: {
      type: "average: relatable people; bold: fashion faces; extreme: theatrical; creature: human-animal hybrids.",
      gender: null,
      age_band: null,
      q: "Words in the name or style, e.g. 'chef'.",
      full_body_only: "Only avatars with a head-to-toe shot (best for remixes).",
      limit: "Default 24.",
      offset: null,
    },
  },
  versely_add_ready_made_avatar: {
    d: "Add a ready-made avatar to the user's own avatars (up to 12) and return its character id, usable in actor_ids of versely_create_ugc_ads and as avatar_id in versely_swap_video. Free.",
    p: { avatar_id: "From versely_list_ready_made_avatars." },
  },
  versely_list_hook_characters: {
    d: "The user's own avatars (characters), with portraits.",
  },

  // ── Hook videos ────────────────────────────────────────────────────────────
  versely_create_hooks: {
    d: "Make short hook videos (the first seconds of a TikTok or Reel): a presenter in a setting with the hook line on screen, from a brief. Spends credits per hook; the card fills in as they finish.",
    p: {
      brief: "The product, offer or idea.",
      count: "Default 1.",
      vibe: "The setting.",
      hook_line: "Your own line; else one is written.",
      face: null,
      character_id: "With face 'character': an id from versely_list_hook_characters.",
      captions: "Burn the line on (default true).",
    },
    hide: ["video_model", "duration"],
  },
  versely_get_hooks: {
    d: "Which hook videos of a batch are ready, with their links.",
    p: { batch_id: null },
  },

  // ── Talking ads ────────────────────────────────────────────────────────────
  versely_list_ugc_actors: {
    d: "Presenters for talking ads: Versely's cast filmed in everyday settings, and the user's own avatars (source 'yours'). Free. Show a few that fit, then pass the chosen ids as actor_ids.",
    p: {
      gender: null,
      age_band: null,
      setting: "e.g. selfie, car, kitchen, gym, office.",
      source: null,
      format: "Only presenters that can make this format.",
      q: null,
      limit: "Default 24.",
      offset: null,
    },
  },
  versely_list_ugc_voices: {
    d: "Voices for talking ads; the user's cloned voices come first. Free. Without a voice_id each Versely presenter uses their own voice.",
    p: { language: "Code such as 'en', 'es'.", gender: null, q: "e.g. 'British', 'warm'.", limit: null },
  },
  versely_write_ugc_script: {
    d: "Write three talking-ad scripts (hook, body, call to action) from a brief, a product page link or one of the user's brands. Free; takes up to 30 s. Show the options; the user picks or edits one.",
    p: {
      brief: "What is sold and to whom.",
      url: "A public product or app page.",
      brand_id: "From versely_list_brands.",
      format: null,
      tone: null,
      length_s: "Default 30.",
      language: "Code, default 'en'.",
    },
  },
  versely_quote_ugc_ads: {
    d: "The exact credits for a batch of talking ads: one per presenter, for this script and settings. Free. Show the user the script, the presenters and the price before versely_create_ugc_ads.",
    p: {
      actor_ids: "Ids from versely_list_ugc_actors, or the user's avatars; one ad each.",
      script: "Exactly what is said: up to 1,500 characters, about 60 s. Cues like [laughs] are performed.",
      seconds: "Without a script: an estimate for this many seconds.",
      voice_id: "From versely_list_ugc_voices, for every ad. The user's own avatars have no voice: pick one that fits.",
      format: "talking_head (default); product_in_hand holds the product (needs product_image_url); show_your_app holds a phone with the app (needs app_screenshot_url).",
      resolution: "Default 720p.",
      captions: "Word-by-word captions (default true).",
    },
  },
  versely_create_ugc_ads: {
    d: "Make talking ads: each presenter reads the script to camera in a vertical video, optionally holding the user's product or showing their app. Paid: pass the price from versely_quote_ugc_ads, for the same settings, as confirm_credits after the user's yes. Takes a few minutes; a failed ad is refunded.",
    p: {
      script: "As quoted.",
      actor_ids: "As quoted.",
      voice_id: null,
      format: null,
      product_image_url: "product_in_hand: a photo of the product.",
      app_screenshot_url: "show_your_app: a screenshot.",
      resolution: null,
      captions: null,
      caption_style: null,
      language: "Language code of the script.",
      confirm_credits: "The quoted price the user approved.",
    },
  },
  versely_get_ugc_ads: {
    d: `Progress and finished videos of a batch of talking ads. ${CARD} at most once a minute.`,
    p: { batch_id: null },
  },

  // ── Captions ───────────────────────────────────────────────────────────────
  versely_list_caption_looks: {
    d: "Caption looks for versely_caption_video. Free looks cost nothing; premium looks (premium-...) cost credits per started minute. Suggest two or three that fit the video.",
    p: { which: null },
  },
  versely_caption_video: {
    d: "Add animated word-by-word captions to a video with speech: the speech is transcribed and the words burned in, in a look from versely_list_caption_looks. Free looks are free. For a premium look call first without confirm_credits (nothing starts; the exact price comes back), show it, then call again with it. Up to 10 minutes and 200 MB. Runs in the background; a failed premium render is refunded.",
    p: {
      video_url: "A direct link to the video file (a Versely result or a file stored with versely_upload_media), not a page link.",
      look: "A look id, e.g. 'bold-pop' or 'premium-glass'.",
      position: "Free looks: default 'bottom'.",
      accent: "Free looks: highlight colour, e.g. '#FFD400'.",
      language: "Spoken language code; default detected.",
      confirm_credits: "Premium looks: the price the user approved.",
    },
  },
  versely_get_caption_job: {
    d: `Progress and result of a captions job. ${CARD} about a minute apart.`,
    p: { job_id: null },
  },

  // ── Slideshows and carousels ───────────────────────────────────────────────
  versely_create_automated_slideshow: {
    d: "Make a captioned slideshow or carousel on a topic: a hook and slide captions are written, the slides drawn and the text put on them. Spends credits per slide; the card fills in. Show caption styles with versely_browse (collection 'slideshow_styles').",
    p: {
      prompt: "The topic.",
      num_images: "Slides (default 5).",
      aspect_ratio: null,
      caption_style: "A style id from the picker; default classic white captions.",
      character_id: "Put one of the user's avatars (versely_list_hook_characters) on every slide.",
      brand_id: "Write it for one of the user's brands (versely_list_brands).",
    },
    hide: ["model", "content_type", "style", "theme", "text_style"],
  },
  versely_get_slideshow: {
    d: "One of the user's slideshows: whether it is still generating, and its slides.",
    p: { slideshow_id: null },
  },
  versely_slideshow_to_video: {
    d: "Turn a slideshow into an MP4 with its captions, optional audio and transitions.",
    p: {
      slideshow_id: null,
      duration_per_image: "Seconds per slide (default 3).",
      audio_url: null,
      voiceover_url: null,
      music_url: null,
      output_resolution: "Default 1080p.",
      aspect_ratio: "Default 'reel'.",
    },
    hide: ["transition", "use_edited_images"],
  },

  // ── Ideas ──────────────────────────────────────────────────────────────────
  versely_find_inspiration: {
    d: "Find viral posts in Versely's inspiration library. Outliers got far more views than the account has followers. Free. To show them use versely_browse (collection 'inspiration'); recreate one with versely_recreate_inspiration.",
    p: {
      niche: "A niche slug, e.g. 'fitness'.",
      type: null,
      outliers_only: "Default true.",
      sort: null,
      small_creators: "Only accounts under 100K followers.",
      platform: "Default tiktok.",
      q: "Words in the hook or caption.",
      limit: null,
      cursor: null,
    },
    hide: ["medium"],
  },
  versely_recreate_inspiration: {
    d: "Recreate an inspiration post as the user's own: a slideshow post becomes a captioned slideshow with the same structure, a video post becomes hook videos from its hook. Spends credits; the card fills in.",
    p: {
      post_id: "From versely_find_inspiration or the picker.",
      brand_id: "One of the user's brands.",
      twist: "How the user's version differs, e.g. 'for busy parents'.",
      num_images: "Slideshow posts: slides.",
      count: "Video posts: hook videos (default 1).",
    },
    hide: ["caption_style", "model", "vibe", "hook_line", "face", "character_id", "video_model", "duration", "captions"],
  },
  versely_list_trending_sounds: {
    d: "The sounds behind current outlier posts, ranked, each with a royalty-free Versely music bed made to match (bed.url) that is safe to use. Free. To show them with previews use versely_browse (collection 'trending_sounds').",
    p: { limit: null },
  },
  versely_browse: {
    d: "Show the user a visual picker with previews instead of listing options in text. Their pick arrives as their next message with the id to use; don't repeat the options, ask them to pick above.",
    p: {
      collection: null,
      q: "Words to narrow it.",
      category: "remix_trends: a tab; inspiration: a niche.",
      limit: "Default 24.",
      offset: null,
    },
    enums: {
      collection: [
        "remix_trends",
        "inspiration",
        "trending_sounds",
        "hook_characters",
        "slideshow_styles",
        "heygen_avatars_v5",
        "heygen_avatars_v3",
        "heygen_voices_v5",
        "heygen_voices_v3",
        "veed_avatars",
        "avatar_x_avatars",
        "brands",
      ],
    },
  },

  // ── Brands ─────────────────────────────────────────────────────────────────
  versely_analyze_brand: {
    d: "Read a brand from its website, product page or social profile and save it to the user's brands (name, products, audience, voice, colours). Returns brand_id. Takes up to a minute. Show a short summary.",
    p: { url: null },
  },
  versely_list_brands: {
    d: "The brands saved on the user's account.",
  },
  versely_update_brand: {
    d: "Correct one of the user's saved brands. Only the fields given change.",
    p: {
      brand_id: "From versely_list_brands.",
      name: null,
      tagline: null,
      description: null,
      audience: null,
      voice_tone: "How the brand talks, e.g. 'playful, short sentences'.",
      website_url: null,
    },
    hide: ["logo_url", "colors", "products", "product_shots"],
  },
  versely_create_brand_slideshow: {
    d: "Make a captioned slideshow for one of the user's brands, in its voice. Spends credits per slide; the card fills in.",
    p: {
      brand_id: "From versely_list_brands or versely_analyze_brand.",
      url: "Or the brand's link (read and saved first).",
      topic: "Default: one of the brand's content angles.",
      num_images: "Slides (default 5).",
      caption_style: "A style id from the versely_browse 'slideshow_styles' picker.",
    },
    hide: ["source", "model", "content_type"],
  },

  // ── Posting ────────────────────────────────────────────────────────────────
  versely_list_social_accounts: {
    d: "The social accounts the user connected to Versely; each `id` goes in account_ids.",
  },
  versely_get_social_auth_url: {
    d: "A link the user opens to connect one of their social accounts to Versely. Show it as a clickable link. Instagram needs a professional account. Afterwards call versely_refresh_social_accounts, then versely_list_social_accounts.",
    p: { platform: null },
  },
  versely_refresh_social_accounts: {
    d: "Pick up social accounts the user just connected through a connect link.",
  },
  versely_preview_post: {
    d: "Preview how a post will look on each chosen account. Nothing is published or charged.",
    p: { caption: null, media_urls: "Images or a video.", account_ids: "From versely_list_social_accounts." },
    hide: ["tiktok_draft", "tagging"],
  },
  versely_publish_post: {
    d: "Publish a caption with images or a video to the user's connected accounts, now or at a set time. Confirm the caption, media and accounts with the user first. Costs at most 1 credit per account. YouTube takes video only; TikTok one video or pictures; X at most 4 pictures.",
    p: {
      caption: null,
      media_urls: "Images or a video; Versely result links work.",
      account_ids: "From versely_list_social_accounts.",
      scheduled_at: "ISO-8601 time with offset; omit to publish now.",
      is_draft: "Save as a Versely draft instead (free).",
      tiktok_draft: "Send to the TikTok app's drafts instead of posting live.",
    },
    hide: ["tagging"],
  },
  versely_list_posts: {
    d: "The user's social posts, newest first, with their status.",
    p: { limit: "Default 20." },
    hide: ["offset", "platform"],
  },
  versely_get_social_analytics_overview: {
    d: "Totals for the user's published posts (views, likes, comments, shares) and the top posts. Needs a subscription.",
  },
  versely_get_post_analytics: {
    d: "Stats of one published post, as last collected. Needs a subscription.",
    p: { post_id: "From versely_list_posts." },
  },

  // ── Dubbing ────────────────────────────────────────────────────────────────
  versely_create_dub: {
    d: "Dub a video or audio file into another language, keeping the speaker's voice. Up to 30 minutes; trim it to pay for only part. Spends credits; takes several minutes.",
    p: {
      source_url: "A Versely-hosted file (a result, or stored with versely_upload_media); outside links such as YouTube are refused.",
      target_lang: "e.g. 'es', 'hi', 'pt-BR'.",
      source_lang: "Default: detected.",
      start_time: "Trim start, seconds.",
      end_time: "Trim end, seconds.",
    },
    hide: ["name", "num_speakers", "drop_background_audio", "highest_resolution", "watermark"],
  },
  versely_get_dub: {
    d: `Progress and result of a dub. ${CARD} a minute or two apart.`,
    p: { project_id: null },
  },

  // ── Music videos ───────────────────────────────────────────────────────────
  versely_quote_music_video: {
    d: "The exact credits for a music video: AI stills cut to the beat of one song, with its timed lyrics on screen. The song is one the user made in Versely (music_id + audio_id from versely_list_user_media, type 'music') or their own file stored with versely_upload_media (audio_url; no lyrics shown). Free. Show the price before versely_create_music_video.",
    p: {
      music_id: "The song row's `id`.",
      audio_id: "One user_music_urls[].audio_id of that row.",
      audio_url: "Instead: the user's stored song file.",
      start_sec: "Default: just before the first sung line.",
      duration_sec: "Default 60; longer costs more.",
      aspect_ratio: "Default '9:16'.",
      quality: "'quality' (default) or 'fast' (cheaper).",
      style: "The look, in the user's words.",
      instrumental: "No lyrics on screen.",
    },
    hide: ["keep_audio_untouched"],
  },
  versely_create_music_video: {
    d: "Make the music video quoted by versely_quote_music_video. Paid: pass the same settings and the quoted price as confirm_credits after the user's yes. Takes a few minutes; refunded if it fails.",
    p: {
      music_id: null,
      audio_id: null,
      audio_url: null,
      start_sec: null,
      duration_sec: null,
      aspect_ratio: null,
      quality: null,
      style: null,
      instrumental: null,
      confirm_credits: "The quoted price the user approved.",
    },
    hide: ["keep_audio_untouched"],
  },
  versely_get_music_video: {
    d: `Progress and result of a music video. ${CARD} every minute or two.`,
    p: { job_id: null },
  },

  // ── Photo looks ────────────────────────────────────────────────────────────
  versely_list_photo_looks: {
    d: "Photo looks re-shoot one photo of a person in a new camera and light style (digicam flash, film, golden hour, night flash, photobooth strip...) while keeping the face, outfit and pose. Lists each look with its id, an example and its price in credits. Free.",
    p: { group: "One group: digicam, flash, film, golden, night, photobooth, editorial." },
  },
  versely_apply_photo_look: {
    d: "Apply a photo look to a photo of the user or of someone who agreed. Paid: pass the look's price from versely_list_photo_looks as confirm_credits after the user picked it and said yes. Takes about a minute; refunded if it fails.",
    p: {
      image_url: "The photo: a Versely result or a file stored with versely_upload_media.",
      look: "A look id, e.g. 'golden-hour'.",
      strength: "Default 'balanced'.",
      confirm_credits: PRICE,
    },
  },
  versely_get_photo_look: {
    d: "Progress and result of a photo look. The card follows it.",
    p: { job_id: null },
  },

  // ── Scripts ────────────────────────────────────────────────────────────────
  versely_write_script: {
    d: "Turn a viral reel's link, or an idea, into a 15 to 60 s script the user films in their own voice: 3 hooks, timed beats, a call to action, a caption and hashtags. It keeps what made the reel work without copying its lines. Paid, fixed price: call first without confirm_credits (nothing is charged; the price comes back), show it, then call again with it. Takes 30 s to 3 minutes; if it is still writing, read it with versely_get_script. Nothing is filmed.",
    p: {
      source_url: "A TikTok, Instagram, YouTube, X, Facebook or LinkedIn post.",
      idea: "Instead of a link: the user's idea.",
      language: "The language the user will speak (default en).",
      length_seconds: "Default 30.",
      notes: "Angle, product, audience, tone.",
      confirm_credits: PRICE,
    },
    hide: ["analysis_id"],
  },
  versely_get_script: {
    d: "Read one of the user's scripts, or learn that it is still being written.",
    p: { script_id: null },
  },

  // ── Short dramas ───────────────────────────────────────────────────────────
  versely_plan_drama_show: {
    d: "Plan a short drama series: vertical 15 or 30 s episodes with the same AI cast in each. Free; takes up to 40 s. First ask at most 2 rounds of short multiple-choice questions (story, episode length, leads, quality). It writes the season, casts the characters and writes Episode 1. Show the cast, the episode titles, Episode 1's lines and its exact price; film only after the user's yes. Every character is a fictional adult: no minors, real people, celebrities or brands.",
    p: {
      idea: "The premise and what the user chose.",
      genre: null,
      format: null,
      language: "Dialogue language code (default 'en').",
      episodes: "Season length (default 10); only filmed episodes cost credits.",
      episode_seconds: "30 (default) or 15 (about half the price).",
      quality: "'standard' (default, 1080p) or 'high' (most realistic, costs more).",
      resolution: "High quality only; 480p costs about half.",
      cast_avatar_ids: "The user's own characters (versely_list_hook_characters) to cast.",
    },
    enums: { resolution: ["480p", "720p"] },
  },
  versely_write_drama_episode: {
    d: "Write or rewrite episode n of a short drama, following the season plan. Free. Returns the lines and the exact credits to film it; show both.",
    p: { show_id: null, n: null, notes: "What the user wants changed." },
  },
  versely_film_drama_episode: {
    d: "Film episode n of a short drama. Paid: pass the episode's exact price (from versely_plan_drama_show, versely_write_drama_episode or versely_get_drama_show) as confirm_credits after the user saw its lines and said yes. Takes about 10 minutes; refunded if it fails.",
    p: { show_id: null, n: null, confirm_credits: PRICE },
  },
  versely_get_drama_show: {
    d: "A short drama: its cast, its episodes (title, status, price) and one episode's lines. The card follows filming; check every few minutes.",
    p: { show_id: null, n: "Episode to show (default: the next one)." },
  },
  versely_list_drama_shows: {
    d: "The user's short dramas, newest first.",
  },

  // ── Movies ─────────────────────────────────────────────────────────────────
  versely_create_movie: {
    d: "Plan a multi-scene movie: the scenes are saved and nothing is generated yet. Show the plan, then start it with versely_generate_movie_scenes.",
    p: {
      title: null,
      aspect_ratio: "For all scenes, e.g. '9:16'.",
      transition_type: "Default 'concat' (hard cut).",
      scenes: null,
      "scenes[].generation_type": "text_to_video (prompt), image_to_video (image_url), first_last_frame (first_frame_url + last_frame_url), or previous_scene_image_to_video (continues from the previous scene's last frame; not for scene 1).",
      "scenes[].model": "Video model `name` from versely_find_models.",
      "scenes[].prompt": null,
      "scenes[].image_url": null,
      "scenes[].first_frame_url": null,
      "scenes[].last_frame_url": null,
      "scenes[].duration": "Seconds (default 5).",
    },
    hide: ["description", "transition_duration", "scenes[].aspect_ratio", "scenes[].previous_scene_order"],
    enums: {
      "scenes[].generation_type": ["text_to_video", "image_to_video", "first_last_frame", "previous_scene_image_to_video"],
    },
  },
  versely_generate_movie_scenes: {
    d: "Generate every pending scene of a movie and join them into one video. Spends credits per scene; the card follows it.",
    p: { movie_id: null },
  },
  versely_get_movie_status: {
    d: `Progress of a movie and its scenes, and the final video. ${CARD} a minute or two apart.`,
    p: { movie_id: null },
  },

  // ── AI creators ────────────────────────────────────────────────────────────
  versely_list_ai_creator_options: {
    d: "Choices and prices for an AI creator: a virtual creator (one avatar, one room, one voice) that makes a short vertical video every day and posts it to one of the user's connected accounts. Free. Steps: versely_make_ai_creator_rooms (paid; the user picks a room), versely_create_ai_creator (free; returns the credits per episode), versely_test_ai_creator_episode (paid; never posted), versely_approve_ai_creator (goes live and spends one episode's credits every day). State every price and the daily schedule before each paid step.",
    p: { avatar_gender: "Only ready-made avatars of this gender." },
  },
  versely_make_ai_creator_rooms: {
    d: "Draw four pictures of an AI creator's avatar in a room; the user picks one for every episode. Paid: pass credits_per_set from versely_list_ai_creator_options as confirm_credits after the user's yes. Takes about a minute; if it is still drawing, read it with versely_get_ai_creator_rooms.",
    p: {
      avatar_id: "From versely_list_ai_creator_options.",
      setting: "'custom' takes the room from note.",
      note: "A few words on the room.",
      confirm_credits: PRICE,
    },
  },
  versely_get_ai_creator_rooms: {
    d: "The newest set of room pictures made for an AI creator, or that one is still being drawn. Free.",
    p: { made_after: "Only a set made after this ISO time." },
  },
  versely_create_ai_creator: {
    d: "Set up an AI creator. Free: nothing is made or posted until a test take is approved. Returns creator_id and the exact credits per episode. Set the posting account and daily time here.",
    p: {
      name: null,
      avatar_id: "The avatar the rooms were made for.",
      room_image_url: "A URL from versely_make_ai_creator_rooms.",
      voice: "A voice name from versely_list_ai_creator_options; its language is the episodes' language.",
      format: "product_demo needs product_url; custom needs topic.",
      topic: "What it posts about.",
      product_url: null,
      length_seconds: "Default 20; longer costs more.",
      quality: "Default 720p.",
      post_account_id: "The one account it posts to (versely_list_social_accounts).",
      post_time: "Daily time 'HH:MM' in timezone.",
      timezone: "IANA zone, e.g. 'Europe/London'. Ask the user.",
    },
    hide: ["comment_word", "caption_style"],
  },
  versely_test_ai_creator_episode: {
    d: "Make a test take: a full first episode that is shown to the user and never posted. Paid: pass the credits per episode as confirm_credits after the user's yes. Takes a few minutes; refunded if it fails.",
    p: { creator_id: null, confirm_credits: PRICE },
  },
  versely_list_ai_creator_episodes: {
    d: "An AI creator and its episodes: setup, live or paused, the price per episode, the schedule, and each episode's status, video and lines. Free. The card follows an episode being made.",
    p: { creator_id: null },
    hide: ["episode_id"],
  },
  versely_approve_ai_creator: {
    d: "Approve the test take and make the AI creator live: it then makes and posts a new episode every day without asking again, spending the price per episode each time (a post may cost 1 more credit). Call only after the user watched the take and agreed to the schedule and the price; pass that price as confirm_credits. It pauses itself when credits run short. Stop it with versely_stop_automation.",
    p: {
      creator_id: null,
      confirm_credits: "The price per episode the user approved.",
      post_test_episode: "Also post the approved take (default false).",
    },
  },
  versely_list_automations: {
    d: "The user's automations (AI creators and slideshow series) with status, schedule and cost.",
  },
  versely_stop_automation: {
    d: "Stop an AI creator or other automation: it is paused and posts not made yet are dropped, never charged. Free.",
    p: { automation_id: "The creator_id, or an id from versely_list_automations." },
  },
  versely_start_automation: {
    d: "Resume a paused AI creator: it makes and posts its daily episodes again, each spending credits.",
    p: { automation_id: "The creator_id, or an id from versely_list_automations." },
  },
};

export const OPENAI_DIRECTORY_NAMES: ReadonlySet<string> = new Set(Object.keys(OPENAI_DIRECTORY));

const SHORT_CONFIRM_REPEAT = "Set true only when the user asks for a second copy of a request just made.";

interface Listed {
  name: string;
  description: string;
  inputSchema: Json;
}

/** Walk "a", "a.b" or "a[].b" to the object that owns the last key. */
function owner(schema: Json, path: string, tool: string): { props: Record<string, Json>; holder: Json; key: string } {
  const segs = path.split(".");
  let node: Json | undefined = schema;
  for (let i = 0; i < segs.length - 1; i++) {
    const raw = segs[i]!;
    const isArray = raw.endsWith("[]");
    const seg = isArray ? raw.slice(0, -2) : raw;
    node = (node?.properties as Record<string, Json> | undefined)?.[seg];
    if (node && isArray) node = node.items as Json | undefined;
  }
  const key = segs[segs.length - 1]!;
  const props = node?.properties as Record<string, Json> | undefined;
  if (!node || !props || !(key in props)) throw new Error(`${tool}: the directory names an unknown input "${path}"`);
  return { props, holder: node, key };
}

/** Drop what a model does not need to fill the form: length bounds, and closed-object markers. */
function slim(node: unknown): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) slim(n);
    return;
  }
  const obj = node as Json;
  delete obj.minLength;
  delete obj.maxLength;
  const props = obj.properties as Record<string, unknown> | undefined;
  // ChatGPT's file inputs must stay a closed object (download_url + file_id).
  if (obj.additionalProperties === false && !(props && "download_url" in props)) delete obj.additionalProperties;
  if (props) for (const v of Object.values(props)) slim(v);
  slim(obj.items);
  slim(obj.anyOf);
}

/**
 * The directory's listing, built from the openai profile's listed tools.
 * Throws on any mismatch (unknown tool, unknown input, an input left
 * undecided) so a drifted entry stops the process at startup.
 */
export function buildDirectoryListing<T extends Listed>(listed: readonly T[]): T[] {
  const byName = new Map(listed.map((t) => [t.name, t]));
  const out: T[] = [];
  for (const [name, entry] of Object.entries(OPENAI_DIRECTORY)) {
    const base = byName.get(name);
    if (!base) throw new Error(`${name}: in the ChatGPT directory but not in the openai profile`);
    const schema = structuredClone(base.inputSchema) as Json;
    delete schema.$schema;

    for (const path of entry.hide ?? []) {
      const { props, holder, key } = owner(schema, path, name);
      delete props[key];
      if (Array.isArray(holder.required)) {
        const req = (holder.required as string[]).filter((k) => k !== key);
        if (req.length > 0) holder.required = req;
        else delete holder.required;
      }
    }
    for (const [path, values] of Object.entries(entry.enums ?? {})) {
      const { props, key } = owner(schema, path, name);
      const node = props[key]!;
      const had = new Set((node.enum as string[] | undefined) ?? []);
      const unknown = values.filter((v) => !had.has(v));
      if (unknown.length > 0) throw new Error(`${name}: the directory offers unknown ${path} values: ${unknown.join(", ")}`);
      node.enum = [...values];
      if (typeof node.default === "string" && !values.includes(node.default)) delete node.default;
    }
    for (const [path, text] of Object.entries(entry.p ?? {})) {
      const { props, key } = owner(schema, path, name);
      if (text === null) delete props[key]!.description;
      else props[key]!.description = text;
    }

    const top = (schema.properties ?? {}) as Record<string, Json>;
    if (top.confirm_repeat) top.confirm_repeat.description = SHORT_CONFIRM_REPEAT;
    const undecided = Object.keys(top).filter((k) => k !== "confirm_repeat" && !(entry.p && k in entry.p));
    if (undecided.length > 0) throw new Error(`${name}: the directory neither describes nor hides: ${undecided.join(", ")}`);

    slim(schema);
    out.push({ ...base, description: entry.d, inputSchema: schema });
  }
  return out;
}
