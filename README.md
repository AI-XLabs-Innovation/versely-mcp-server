# versely-mcp-server

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the Versely content creation API as **93 tools** for any MCP-compatible client (claude.ai, Claude Desktop, Claude Code, ChatGPT, Cursor, etc.). Generate images / videos / voiceovers / music, build slideshows, assemble multi-scene movies, edit UGC, dub videos, run workflows, and post to 9 social platforms — all from a single MCP connection.

Source: <https://github.com/AI-XLabs-Innovation/versely-mcp-server>

> **End user?** Skip to **[INSTALL.md](./INSTALL.md)** — connect claude.ai, ChatGPT, Claude Code or Cursor in a few steps. No Node, no self-hosting needed.
>
> **Operator self-hosting?** See **[deploy/SETUP.md](./deploy/SETUP.md)**.
>
> **Full tool reference:** **[TOOLS.md](./TOOLS.md)** (auto-generated).

The server speaks **Streamable HTTP** (the MCP spec's network transport) and authenticates **every request** with the caller's own bearer: either an OAuth access token (claude.ai and ChatGPT connect this way) or a `vsk_...` API key. One deployment serves many users without sharing identity.

## Run locally (dev)

Requires **Node 20+**.

```bash
npm install
npm run build
node dist/index.js          # listens on 127.0.0.1:8080 by default
```

Health check from another terminal:

```bash
curl -s http://127.0.0.1:8080/healthz
# {"status":"ok","server":"versely-mcp","version":"0.1.0","uptime_s":...,"tools":93,"tools_openai":48}
```

For a real client to talk to it locally, expose it via your MCP client's URL config (see below) — or for production, deploy behind nginx + TLS following [`deploy/SETUP.md`](deploy/SETUP.md).

## Configuration (server-side env)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `MCP_HTTP_PORT` | no | `8080` | Local port to bind. |
| `MCP_HTTP_HOST` | no | `127.0.0.1` | Bind address. Keep loopback in production; let nginx proxy in. |
| `VERSELY_API_URL` | no | `https://api.versely.studio` | Versely backend base URL. Override for ngrok / staging. |
| `OAUTH_JWT_SECRET` | for OAuth | — | Shared HS256 secret (≥ 32 chars) the backend signs access tokens with. Unset = OAuth tokens are refused and no `X-Versely-Proxy` signature is sent. |
| `OAUTH_ISSUER` | no | `VERSELY_API_URL` | Expected `iss` of access tokens. |
| `MCP_RESOURCE_URL` | no | `https://mcp.versely.studio/mcp` | This server's canonical URL (the tokens' `aud`). |
| `OAUTH_AUTH_SERVER_URL` | no | `VERSELY_API_URL` | Advertised in the protected-resource metadata. |
| `VERSELY_DEFAULT_POLL_TIMEOUT_MS` | no | `70000` | Max blocking wait for `mode: "wait"` (clamped to ~70s: the proxy in front cuts requests at ~100s). |
| `VERSELY_DEFAULT_POLL_INTERVAL_MS` | no | `3000` | Initial poll interval (1.5× backoff up to 4×). |
| `VERSELY_INLINE_IMAGE_PREVIEW` | no | `true` | Attach small base64 previews of generated images (never for the ChatGPT profile). |
| `MCP_DISABLE_APPS_UI` | no | off | `1` strips the inline media cards (kill switch for host-side card bugs). |
| `MCP_DEDUPE_PROFILES` | no | `openai` | Profiles whose creation tools get the duplicate-call guard. Empty = off. |
| `MCP_CARD_V2_PROFILES` | no | `openai` | Profiles served the v2 media card; the rest keep v1 unchanged. Empty = v1 everywhere. |
| `MCP_ENABLE_DEBUG_TOOLS` | no | off | `1` registers `versely_render_test_card`. |
| `MCP_ADMIN_TOKEN` | no | — | ≥ 32 chars. Unlocks `GET /debug/recent-calls` for `Authorization: Bearer <token>`; without it that route is a 404. |

There is **no** `VERSELY_API_KEY` env var — the server is multi-tenant; clients send their own credentials per request.

The server fails fast (exit 2) on bad config, and refuses to start if a tool is missing its row in the policy table (see [Profiles](#profiles)).

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/mcp` | `Authorization: Bearer <OAuth token or vsk_...>` | MCP JSON-RPC (Streamable HTTP transport, sessions) |
| GET | `/mcp` | same | Standalone SSE stream (keepalive) |
| DELETE | `/mcp` | same | End a session |
| GET | `/healthz` | none | Liveness probe (tool counts per profile) |
| GET | `/.well-known/oauth-protected-resource` (also `…/mcp`) | none | RFC 9728 metadata: which authorization server protects `/mcp` |
| GET | `/.well-known/openai-apps-challenge` | none | OpenAI domain-verification token (404 until one is committed in `src/openaiChallenge.ts`) |
| GET | `/debug/recent-calls` | `MCP_ADMIN_TOKEN` | Recent calls that reached this process (no bodies, no tokens) |
| GET | `/` | none | Tiny landing JSON describing the endpoints |

Auth-gate failures return 401 with an RFC 9728 `WWW-Authenticate` challenge (`missing_authorization`, `invalid_token`).

## Profiles

Each request is served one of two tool **profiles**:

| Profile | Who | Tools |
|---|---|---|
| `full` | claude.ai, Claude Code, Cursor, API-key users | all 93 |
| `openai` | the ChatGPT plugin | 48: generation and editing that lands in the user's private library, plus the reads that drive it. No social posting, no workflows. |

- A token the backend signed with `ck: "openai"` (issued to ChatGPT) **always** gets `openai` — the claim is inside the signature, so it can't be widened. Any other caller can restrict itself with `?profile=openai` or `X-Versely-Profile: openai` (handy for testing the plugin surface with an API key).
- Calls to a tool outside the caller's profile fail as `Unknown tool`. A session is bound to the profile it was opened with (a mismatched request gets 403).
- The `openai` profile lists **only RunPod-served models** (`versely_find_models` reads the backend's plugin catalog; `versely_get_model_inputs` returns each model's accepted inputs), hides model pickers that could only name other models, never offers blocking `mode: "wait"`, and keeps bulky card data in result `_meta` rather than `structuredContent` (ChatGPT shows `structuredContent` to the model).
- ChatGPT tends to re-call a tool after ~60 s. For `openai` creation tools, an identical call made while the first is running **joins** it, and one made within 150 s of a success gets that result back, so nothing is generated — or charged — twice. `confirm_repeat: true` makes a deliberate second copy.

Every tool has a row in [`src/tools/_policy.ts`](src/tools/_policy.ts): its title, class (read / create / edit / delete / publish → MCP annotations), profiles, ChatGPT status strings, and a written justification per annotation hint. `npm run annotations -- --profile openai` prints those justifications as Markdown for OpenAI's plugin portal.

## Client config

OAuth clients (claude.ai, ChatGPT, Claude Code) only need the URL `https://mcp.versely.studio/mcp` and sign in with Versely. With an API key:

```json
{
  "mcpServers": {
    "versely": {
      "url": "https://mcp.versely.studio/mcp",
      "headers": {
        "Authorization": "Bearer vsk_YOUR_REAL_KEY"
      }
    }
  }
}
```

See [INSTALL.md](./INSTALL.md) for per-client steps.

## Tools at a glance

| Category | Count | Highlights |
|---|---:|---|
| User & account | 6 | `versely_get_credits`, `versely_list_user_media`, `versely_delete_generation` |
| Generation | 12 | `versely_find_models`, `versely_get_model_inputs`, `versely_generate_image`, `versely_generate_video`, `versely_generate_audio`, `versely_generate_music` |
| Slideshow | 8 | `versely_create_automated_slideshow`, `versely_add_text_overlay`, `versely_slideshow_to_video` |
| Movie | 11 | `versely_create_movie`, `versely_generate_movie_scenes`, `versely_get_movie_status` |
| UGC | 5 | `versely_add_video_overlay`, `versely_add_timestamped_captions`, `versely_compose_with_overlay` |
| Social | 8 | `versely_publish_post`, `versely_get_social_auth_url`, `versely_list_posts` |
| Status | 2 | `versely_get_task_status`, `versely_wait_for_task` |
| Utilities | 6 | `versely_merge_videos`, `versely_add_auto_captions`, `versely_colorize_photo` |
| Workflows | 25 | `versely_create_workflow`, `versely_run_workflow`, `versely_get_workflow_run` |
| Video-workflow runs | 5 | `versely_get_video_workflow_run`, `versely_combine_video_workflow_run` |
| Voices | 1 | `versely_list_voices` |
| Dubbing | 4 | `versely_create_dub`, `versely_get_dub` |

See [TOOLS.md](./TOOLS.md) for every tool's input schema and which ones the ChatGPT plugin includes.

## Async generation

Generation tools return a `request_id` immediately (`mode: "submit"`, the default) while the job runs in the background:

- Hosts with MCP Apps support (claude.ai, ChatGPT) show an inline media card that polls the job and swaps in the result by itself.
- Otherwise check with `versely_get_task_status` (movies: `versely_get_movie_status`, dubs: `versely_get_dub`).
- `mode: "wait"` blocks for at most ~70 seconds (the proxy in front cuts requests at ~100s) and then hands back the `request_id`. It is not offered to ChatGPT.

Endpoints that work synchronously (UGC composites, merges, frame extraction, slideshow renders) get a 95-second backend timeout and return the finished file as a completed card. Write requests are never retried automatically: a POST that times out may already have started a paid job, so the error says to check `versely_list_user_media` first.

## Deploy to a server (DigitalOcean / any VPS)

The walkthrough lives in [`deploy/SETUP.md`](deploy/SETUP.md). Short version:

1. SSH in, install Node 20 + nginx + certbot + PM2
2. Clone, `npm ci && npm run build`
3. `pm2 start deploy/ecosystem.config.cjs && pm2 save && pm2 startup`
4. Drop [`deploy/nginx.conf`](deploy/nginx.conf) into `/etc/nginx/sites-available/` (replace placeholder hostname)
5. `sudo certbot --nginx -d versely-mcp.YOURDOMAIN.com`
6. Enable ufw

Subsequent deploys: a push to `main` runs typecheck, build and the smoke test in CI, then `./deploy/deploy.sh` on the droplet (git pull + build + zero-downtime PM2 reload).

## Development

```bash
npm run dev          # tsx watch (no build step)
npm run typecheck    # tsc --noEmit
npm run build        # bundle to dist/index.js with shebang
npm run docs         # regenerate TOOLS.md from tool definitions
npm run annotations -- --profile openai   # annotation justifications for OpenAI's portal
npm run smoke        # build + run the server against a fake backend (~75s)
npm run preview:card # offline preview of the media card (add -- --v2 for the v2 card)
```

`npm run smoke` spawns the built server against [`scripts/fake-backend.ts`](scripts/fake-backend.ts) — no real backend, no paid calls — and checks auth, profiles, annotations, retries, the proxy signature, the duplicate-call guard, credit-error wording and the card contracts.

## Project layout

```
versely-mcp-server/
├── src/
│   ├── index.ts                  # bootstrap
│   ├── server.ts                 # MCP server factory + per-profile tool catalogs
│   ├── profiles.ts               # full / openai profiles, ChatGPT server instructions
│   ├── config.ts                 # env loader
│   ├── client.ts                 # Versely HTTP client (per bearer): signed proxy headers, GET-only retries
│   ├── proxySignature.ts         # X-Versely-Proxy HMAC (shared with the backend)
│   ├── requestContext.ts         # per-call context (profile, ChatGPT subject)
│   ├── idempotency.ts            # duplicate-call guard
│   ├── poller.ts                 # async status polling (wait mode)
│   ├── errors.ts                 # typed errors + user-facing wording
│   ├── oauth.ts                  # HS256 access-token verification
│   ├── openaiChallenge.ts        # OpenAI domain-verification token
│   ├── transports/http.ts        # Express + Streamable HTTP transport, sessions
│   ├── ui/templates.ts           # inline media card (v1 + v2)
│   └── tools/
│       ├── _policy.ts            # per-tool title, annotations, profiles, justifications
│       ├── _shaping.ts           # per-profile schema/result shaping
│       ├── _pluginCatalog.ts     # RunPod-only model catalog client
│       ├── _types.ts / _helpers.ts / _async.ts / _registry.ts
│       └── user / generate / slideshow / movie / ugc / social / status /
│           features / workflows / videoWorkflows / voices / dubbing / debug .ts
├── scripts/
│   ├── smoke-test.ts / fake-backend.ts
│   ├── annotations-report.ts
│   ├── generate-tools-doc.ts     # TOOLS.md generator
│   └── preview-card.ts
├── deploy/                       # PM2, nginx, deploy.sh, SETUP.md
└── dist/                         # build output (gitignored)
```

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `401 missing_authorization` | client didn't send `Authorization` |
| `401 invalid_token` | the OAuth token expired or was revoked (reconnect), or the `vsk_` key is malformed |
| `authentication failed` from a tool call | the backend rejected the credential — reconnect, or check the API key hasn't been revoked |
| `Not enough Versely credits for this` | the balance is below the job's price — `versely_get_credits` shows it |
| `not allowed` (403) from a tool call | the account or connection has no access to that feature |
| `Unknown tool` | the tool isn't in the caller's profile (ChatGPT has the 48-tool plugin set) |
| `The request may still have been processed` | a write timed out — check `versely_list_user_media` before retrying |
| `502 Bad Gateway` from the proxy | PM2 process down — `pm2 status`, `pm2 logs versely-mcp` |

## License

MIT
