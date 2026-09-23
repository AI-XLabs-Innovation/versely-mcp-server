# Changelog

All notable changes to `versely-mcp-server` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added — ChatGPT plugin

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
