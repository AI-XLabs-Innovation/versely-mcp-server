# Changelog

All notable changes to `versely-mcp-server` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added — Every feature shipped since October, 46 new tools (2026-11-14)

The server had not gained a feature since early October, so Swap, Remix, the captions studio, talking ads and the rest could not be reached from an assistant, and the ChatGPT listing could not mention them. Full profile 177 → 223 tools, `openai` 163 → 209.

- **Uploads** (`versely_upload_media`): a photo, video or audio file the user gives is stored in their own Versely library and its URL returned. In ChatGPT the attachment arrives as a file input (`_meta["openai/fileParams"]`); other hosts pass an https link. Bytes are streamed to a temp file under per-kind limits (30 / 200 / 60 MB) and PUT through the backend's presigned upload. The fetch is guarded (`src/tools/_fetchGuard.ts`): https only, no credentials or odd ports, and the address the socket connects to must be public, on every redirect hop.
- **Remix** (`versely_list_remix_trends`, `versely_prepare_remix_clip`, `versely_quote_swap`, `versely_swap_video`, `versely_get_swap`, and a `remix_trends` collection in `versely_browse`): Swap replaces people, outfits, products, places or the style in a 4 to 15 second clip with the user's photos or avatars; "moves" makes one character perform the clip's motion. The paid step takes `confirm_credits` (re-quoted first, refused when the price moved) and `rights_confirmed`. No engine is named anywhere.
- **Talking ads** (`versely_list_ugc_actors`, `versely_list_ugc_voices`, `versely_write_ugc_script`, `versely_quote_ugc_ads`, `versely_create_ugc_ads`, `versely_get_ugc_ads`, `versely_list_ugc_ads`) and **ready-made avatars** (`versely_list_ready_made_avatars`, `versely_add_ready_made_avatar`, `versely_list_avatar_creations`).
- **Captions studio** (`versely_list_caption_looks`, `versely_caption_video`, `versely_get_caption_job`): the free animated looks and the premium ones (price returned before anything is charged).
- **Scripts** (`versely_write_script` and its get / list / update / delete, plus the voice profile tools).
- **Music videos** (`versely_quote_music_video`, `versely_create_music_video`, `versely_get_music_video`) and **photo looks** (`versely_list_photo_looks`, `versely_apply_photo_look`, `versely_get_photo_look`).
- **AI creators** (`versely_list_ai_creator_options`, `versely_make_ai_creator_rooms`, `versely_get_ai_creator_rooms`, `versely_create_ai_creator`, `versely_update_ai_creator`, `versely_test_ai_creator_episode`, `versely_list_ai_creator_episodes`, `versely_approve_ai_creator`). Drawing a set of rooms can outlast a tool call, so the tool stops waiting after 50 s and the set is read back with `versely_get_ai_creator_rooms` (backend `GET /automations/ai-creator/rooms`, added with this release).
- A profile variant can now carry its own `_meta` (`ProfileVariant.meta`), used for the ChatGPT-only file input.
- `versely_analyze_post` said it costs 1 credit; the backend has charged 2 since 2026-11-08.
- **Existing tools brought back in line with the backend** (an audit against the current contract):
  - `versely_slideshow_to_video` now sends `use_edited_images: true`, so a captioned slideshow keeps its captions as a video.
  - Slideshow automations no longer run on an interval: posts are made when they are queued. `versely_quote_automation_posts`, `versely_create_automation_posts` (takes `confirm_credits`) and `versely_stop_automation` are new; `versely_create_slideshow_automation` and `versely_update_automation` take `post_time` + `timezone` instead of `start` / `every_minutes`; `versely_start_automation` is described as resume.
  - `versely_get_social_auth_url` no longer offers Bluesky (it has no connect link), and a full account limit is answered without naming a bigger plan. `versely_get_posting_plan` is new; `versely_publish_post` states the real cost and takes `tagging`. "Failed to deduct credits" reads as a credit refusal.
  - `versely_update_drama_show` says a new length or language drops unfilmed scripts; `versely_delete_drama_show` is new.
  - `versely_reuse_hooks` takes `reveal` (a cut to a product shot) and caps lines at 90 characters, as the backend does; `versely_save_hook` the same.
  - `versely_create_automated_slideshow` takes `character_id` (avatar slideshows) and `brand_id`.
  - `versely_list_dubs` / `versely_get_dub` no longer pass the engine's name through.
- **Plugin package 1.0.1**: the listing leads with Swap, the capabilities, prompts and release notes name the new features, the Remix test case uses only Versely's own ready-made moves and avatars, and the onboarding skill offers a remix.
- No free ChatGPT account (never paid) can reach these routes: the backend's free-plugin allowlist is unchanged, so they answer with the existing "not available with free plugin credits" message.

### Added — The directory plugin has its own endpoint, `/mcp/openai` (2026-11-13)

- ChatGPT and Codex share one plugin directory. ChatGPT's tokens carry `ck: "openai"`, so `/mcp` already served it the plugin's tools. Codex installs the same plugin but signs in from the user's machine (loopback redirect), so its token is an ordinary one and `/mcp` would have served it the full catalog, checkout and plan tools included. `/mcp/openai` serves the `openai` profile to every caller.
- The endpoint has its own protected-resource metadata (`/.well-known/oauth-protected-resource/mcp/openai`, `resource` = the endpoint), and its 401s and tool-level sign-in challenges point there. The backend accepts that resource next to the canonical one and still mints canonical-audience tokens, so one token works on both paths.
- `openai/mcp.json` now names `https://mcp.versely.studio/mcp/openai` and declares OAuth with dynamic client registration. The portal cannot change a plugin's MCP URL after the first connection, so this goes in before the first upload. `/mcp` is unchanged for every other client.
- `openai/plugin.json`: the developer is AI XLabs Innovation, the publisher named on versely.studio/privacy and /terms.

### Changed — The iPhone app's first week is paid too (2026-11-13)

- `versely_list_plans` no longer says the iPhone app has a free 3-day App Store trial with 24 credits. It now describes the App Store offer as the Weekly plan's first week for $2.99 (US price, charged by Apple, once per Apple ID, refunds through Apple), with 100 credits (80 + 20 bonus), then $8.99 a week. TOOLS.md regenerated. Ship only after the offer is switched in App Store Connect.

### Changed — The web trial is the first week for $3 (2026-11-12)

- **The web trial is no longer free.** Since 2026-11-12 it is the Weekly plan's first week for $3 (charged at checkout, not refunded), then $9 a week unless cancelled; no other plan has a trial. `versely_create_checkout_link` (`trial: true`), `versely_list_plans`, `versely_get_subscription` and `versely_skip_trial` (titled "End trial now") say so, and the checkout tool has the assistant confirm both charges with the user before it creates a trial link. A trial link's result carries the same terms.
- **New result fields, old ones kept.** `versely_get_subscription` returns `on_trial`, and `versely_list_plans` returns `trial_offer`; `on_free_trial` and `free_trial` stay as the old names with the same values.
- **The plugin's free trial is not the web trial.** `free_trial` / `on_free_trial` in `versely_find_models` (openai) are about the plugin's free credits for an account that has never paid. The description and the ChatGPT server instructions now say that a subscription trial is a different thing and has none of those limits.
- The plugin listing check (`scripts/build-openai-plugin.mjs`) now also catches a dollar amount, "subscription" and "trials" in the long description. Fake-backend plan, trial-offer and trial-checkout routes, plus smoke assertions; TOOLS.md regenerated.

### Changed — Short drama Standard is always 1080p (2026-11-04)

- **Standard films shot by shot at 1080p**, each shot from the cast's photos, so it has no resolution choice: about 150 credits for a 15 s episode and about 300 for 30 s (the exact quote also counts the script's shots). High quality is unchanged (480p 160 / 320, 720p 320 / 640). `resolution` on `versely_plan_drama_show` and `versely_update_drama_show` takes `480p | 720p | 1080p` and only matters for High quality (the backend reads 1080p as 720p there); `540p` is still accepted (High quality reads it as 480p). Descriptions and the ChatGPT server instructions carry the new prices and drop the old 540p / 720p Standard figures. The fake backend prices a script from its seconds and shots like the server; smoke asserts the mapping, the re-pricing and that no old figure is left. TOOLS.md regenerated (still 177 tools, 163 in the plugin).

### Added — Short drama quality tiers (2026-11-04)

- **`quality` on `versely_plan_drama_show` and `versely_update_drama_show`**: `"standard"` (default; shown as "Standard", good quality, lowest price) or `"high"` (shown as "High quality": faces, outfits and motion stay true to each character's photo). `resolution` now takes `480p | 540p | 720p` (Standard films at 540p or 720p, High quality at 480p or 720p; the backend moves a mismatch to the tier's lower one).
- The descriptions have the assistant offer both tiers with their prices (credits per episode, 15 s / 30 s: Standard 540p 68 / 135, 720p 142 / 284; High quality 480p 160 / 320, 720p 320 / 640) and say that changing quality or resolution re-prices every scripted episode while keeping its script. Planning casts the user's avatars first, then Versely's ready-made characters. The ChatGPT server instructions name both tiers in the interview round.
- Show text, `versely_get_drama_quote` and the stale-price refusal carry the tier ("High quality 480p"). Fake-backend tier normalisation and re-pricing, plus smoke assertions; TOOLS.md regenerated (still 177 tools, 163 in the plugin).

### Added — Short dramas (2026-11-04)

- **Seven tools wrapping `/api/v1/drama` 1:1** (`src/tools/drama.ts`), in both profiles (177 tools; 163 in the ChatGPT plugin): `versely_plan_drama_show` (free: season, cast portraits, locations, Episode 1 script), `versely_update_drama_show` and `versely_write_drama_episode` (free), `versely_get_drama_quote`, `versely_film_drama_episode` (the one paid call: `confirm_credits` must equal the current quote; a stale price comes back as a plain "not filmed, nothing charged, the price is now N" error), `versely_get_drama_show` and `versely_list_drama_shows`.
- The descriptions carry the flow: at most 2 multiple-choice rounds (3 premises when there is no idea), plan for free, show the cast, episode titles, Episode 1's lines and the exact credits, film only after the user says yes, about 10 minutes per episode, the same cast every episode, fictional adults only, no real people or brands. No provider names. The ChatGPT server instructions gained one sentence on the same flow.
- Filming returns a pending media card that polls `versely_get_drama_show` every 15 s (a card poll target, app-visible and `widgetAccessible`); the card then shows the finished episodes, or the cast portraits before anything is filmed.
- Policy rows (`plan` create/free, `update` and `write` edit, `quote`/`get`/`list` read, `film` create/paid), fake-backend routes and smoke assertions for the whole flow; TOOLS.md regenerated.

### Added — ChatGPT plugin

- **Per-tool auth (2026-10-01).** Every tool declares `securitySchemes` (OAuth 2.0 plus the one scope that describes it: read, generate, slideshow, ugc, post, manage_accounts, workflows or analytics), mirrored under `_meta` for clients that only read `_meta` (`src/tools/_security.ts`). A call the backend refuses with 401 mid-session returns `_meta["mcp/www_authenticate"]`, so ChatGPT offers to sign in again instead of showing a dead error. Every token Versely issues carries all scopes, so this is disclosure, not a new gate.
- **Every model in the plugin (2026-09-24).** `versely_find_models` (openai) lists the full catalog ranked by leaderboard with `free_trial` flags and the account's `on_free_trial`; only free-trial accounts are limited to RunPod models. Model pickers are visible again, `versely_list_voices` is the full catalog, and `versely_generate_lipsync` joins the plugin (49 tools).
- **Tool profiles.** `full` (every client so far, 93 tools) and `openai` (the ChatGPT plugin, 48 tools). A backend-signed `ck: "openai"` token always gets `openai`; anyone can narrow to it with `?profile=openai` / `X-Versely-Profile`. Out-of-profile calls fail as unknown tools; sessions are bound to their profile.
- **Policy table** (`src/tools/_policy.ts`): title, class and MCP annotations for every tool (emitted in both profiles), ChatGPT status strings, and a written justification per hint. The server refuses to start if a tool has no row. `npm run annotations` prints the justifications.
- **RunPod-only models in the plugin**: `versely_find_models` reads the backend's plugin catalog (falls back to RunPod-discounted catalog models when it isn't deployed), new `versely_get_model_inputs` returns each model's inputs, `versely_list_voices` lists only the RunPod TTS voices, and model pickers that can only name other models are hidden.
- **Plugin free credits**: `versely_get_credits` reports `{credits, plugin_free_credits, free_account}`; plugin refusals are relayed as plain, link-free text.
- **Duplicate-call guard** for plugin creation tools: identical calls in flight join, successes are reused for 150s, `confirm_repeat: true` opts out.
- **Media card v2** for the plugin (single in-flight poll with a stale watchdog, ping/teardown, host theme, `ui/open-link`, `_meta` card state, `info` status). claude.ai keeps v1 unchanged.
- Server title "Versely", ChatGPT server instructions, `/.well-known/openai-apps-challenge`, `/.well-known/oauth-protected-resource/mcp`.

### Changed

- Backend requests carry `X-Versely-Proxy` (HMAC, key derived from `OAUTH_JWT_SECRET`), `X-Versely-OpenAI-Subject`, `X-Versely-Client-Profile`, and an `Idempotency-Key` on POSTs. Only GETs are retried; a timed-out write says to check `versely_list_user_media` first. Synchronous endpoints get a 95s timeout.
- Credit errors no longer upsell ("Top up at …") and 401/403 wording fits OAuth users.
- Provider safety switches (`enable_safety_checker`, `safety_tolerance`, …) are stripped from every call.
- Synchronous results (UGC composites, merges) finish as completed cards; card tools always hand the card a state; model-initiated movie/dub/workflow checks carry the poll instruction; the four card poll targets are app-visible.

### Security

- `/debug/recent-calls` requires `MCP_ADMIN_TOKEN` (it accepted any `vsk_`-shaped bearer). `versely_render_test_card` only registers with `MCP_ENABLE_DEBUG_TOOLS=1`.

### Changed (earlier)

- **Transport: stdio → Streamable HTTP.** The server now listens on an HTTP port (default `127.0.0.1:8080`) and speaks the MCP Streamable HTTP transport instead of stdio. Designed to run behind a reverse proxy (nginx + Let's Encrypt) for cloud hosting.
- **Auth: server-level → per-request.** `VERSELY_API_KEY` is no longer a server env var. Each MCP request must include `Authorization: Bearer vsk_...` from the calling user. The server is now multi-tenant — one deployment can serve multiple users without sharing identity.
- The Versely client (`VerselyClient`) is constructed per HTTP request, scoped to the caller's API key. The user_id cache lives on that per-request instance.
- `buildServer(config, client)` factory replaces the previous lifetime-singleton `startServer(config)`. Tool registry is module-level (registered once, reused across requests).

### Added

- `src/transports/http.ts` — Express app with `POST /mcp`, `GET /healthz`, `GET /`, request logging (JSON to stderr), graceful shutdown on SIGTERM/SIGINT (10 s drain).
- Auth middleware with three distinct 401 reasons: `missing_authorization`, `invalid_authorization_format`, `invalid_api_key_format`.
- New env vars: `MCP_HTTP_PORT` (default `8080`), `MCP_HTTP_HOST` (default `127.0.0.1`).
- `deploy/` directory: `ecosystem.config.cjs` (PM2), `nginx.conf` (vhost template with TLS section and tuned proxy settings), `deploy.sh` (pull + build + zero-downtime reload), `SETUP.md` (DigitalOcean droplet walkthrough).
- Smoke test rewritten for HTTP — spawns the server, drives it via the SDK's `StreamableHTTPClientTransport`, exercises auth-gate failure modes plus the existing tool-catalog assertions (20 total).

### Removed

- `VERSELY_API_KEY` env var (replaced by per-request `Authorization`).
- stdio transport. The server is HTTP-only now; `node dist/index.js` boots an HTTP listener instead of a stdin/stdout JSON-RPC pipe.

## [0.1.0-stdio] - 2026-05-07 (superseded)

### Added

- Initial Model Context Protocol server for the Versely content creation API (stdio transport).
- **51 curated tools** across 8 categories:
  - User & account (6), Generation (10), Slideshow (8), Movie (7), UGC (5), Social (8), Status (2), Utilities (5).
- Async generation tools support `mode: "wait"` (default) and `mode: "submit"`.
- Configurable poll timeout / interval per call and via env vars.
- Auth via `VERSELY_API_KEY` (server-level); base URL overridable via `VERSELY_API_URL`.
- Typed error mapping for 401/402/403/422/429/5xx with backend error details.
- Single-retry on transient 5xx and network errors with exponential backoff.
- `npm run docs` regenerates [TOOLS.md](TOOLS.md). `npm run smoke` runs an offline stdio handshake test.
