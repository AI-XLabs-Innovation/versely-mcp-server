# Changelog

All notable changes to `versely-mcp-server` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

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
