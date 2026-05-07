# Changelog

All notable changes to `versely-mcp-server` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Initial Model Context Protocol server for the Versely content creation API (stdio transport).
- **51 curated tools** across 8 categories:
  - User & account (6): profile, credits, scopes, purchases, media listing, generation deletion
  - Generation (10): image, video, audio (TTS), music (Suno), lipsync, background removal, image/video upscale, model catalog
  - Slideshow (8): create, automated create, list, get, delete, add images, text overlays, slideshow-to-video
  - Movie (7): create, list, get, delete, status, generate scenes, combine
  - UGC (5): video overlay, captions, timestamped captions, compose with overlay, get UGC
  - Social (8): OAuth URL, list/refresh/disconnect accounts, preview/publish/list/get posts (9 platforms via Post for Me)
  - Status (2): get task status, wait for task
  - Utilities (5): extract frames, merge videos, generate prompt, colorize photo, audio isolation
- Async generation tools support `mode: "wait"` (default, polls until completion) and `mode: "submit"` (returns request_id for later polling).
- Configurable poll timeout / interval per call and via env vars (`VERSELY_DEFAULT_POLL_TIMEOUT_MS`, `VERSELY_DEFAULT_POLL_INTERVAL_MS`).
- Auth via `VERSELY_API_KEY` (must start with `vsk_`); base URL overridable via `VERSELY_API_URL` for ngrok / dev tunnels.
- Typed error mapping: 401/402/403/422/429/5xx surface as actionable messages with backend error details.
- Single-retry on transient 5xx and network errors with exponential backoff.
- Auto-resolves the authenticated user_id (cached) so path-param tools don't require it.
- `npm run docs` regenerates [TOOLS.md](TOOLS.md) from tool definitions.
- `npm run smoke` runs an offline JSON-RPC handshake test (initialize, tools/list, error paths).
