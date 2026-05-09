# versely-mcp-server

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the Versely content creation API as **51 curated tools** for any MCP-compatible client (Claude Desktop, Claude Code, Cursor, etc.). Generate images / videos / music, build slideshows, assemble multi-scene movies, edit UGC, and post to 9 social platforms — all from a single MCP connection.

> **End user?** Skip to **[INSTALL.md](./INSTALL.md)** — connect Claude / Cursor / VS Code in 3 steps. No Node, no self-hosting needed.
>
> **Operator self-hosting?** See **[deploy/SETUP.md](./deploy/SETUP.md)**.
>
> **Full tool reference:** **[TOOLS.md](./TOOLS.md)** (auto-generated).

The server speaks **Streamable HTTP** (the MCP spec's network transport) and uses **per-request authentication**: each MCP request must carry the caller's own `vsk_...` API key in `Authorization`. This makes one deployment usable by multiple users without sharing identity.

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
# {"status":"ok","server":"versely-mcp","version":"0.1.0","uptime_s":...,"tools":51}
```

For a real client to talk to it locally, expose it via your MCP client's URL config (see below) — or for production, deploy behind nginx + TLS following [`deploy/SETUP.md`](deploy/SETUP.md).

## Configuration (server-side env)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `MCP_HTTP_PORT` | no | `8080` | Local port to bind. |
| `MCP_HTTP_HOST` | no | `127.0.0.1` | Bind address. Keep loopback in production; let nginx proxy in. |
| `VERSELY_API_URL` | no | `https://api.versely.studio` | Versely backend base URL. Override for ngrok / staging. |
| `VERSELY_DEFAULT_POLL_TIMEOUT_MS` | no | `180000` (3 min) | Max wait when a tool runs in `mode: "wait"`. |
| `VERSELY_DEFAULT_POLL_INTERVAL_MS` | no | `3000` | Initial poll interval (1.5× backoff up to 4×). |

There is **no** `VERSELY_API_KEY` env var anymore — the server is multi-tenant; clients send their own `vsk_` key per request.

The server fails fast (exit 2) on bad config so misconfiguration surfaces before it starts listening.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/mcp` | `Authorization: Bearer vsk_...` | MCP JSON-RPC (Streamable HTTP transport) |
| GET | `/healthz` | none | Liveness probe |
| GET | `/` | none | Tiny landing JSON describing the endpoints |

Auth-gate failure modes (all return 401):

- `missing_authorization` — no `Authorization` header
- `invalid_authorization_format` — header isn't `Bearer <token>`
- `invalid_api_key_format` — token isn't `vsk_...`

## Client config

```json
{
  "mcpServers": {
    "versely": {
      "url": "https://versely-mcp.YOURDOMAIN.com/mcp",
      "headers": {
        "Authorization": "Bearer vsk_YOUR_REAL_KEY"
      }
    }
  }
}
```

Drop into Claude Desktop / Cursor / Claude Code's `mcp.json` (or platform equivalent).

## Tools at a glance

| Category | Count | Highlights |
|---|---:|---|
| User & account | 6 | `versely_get_me`, `versely_get_credits`, `versely_list_user_media` |
| Generation | 10 | `versely_generate_image`, `versely_generate_video`, `versely_generate_music`, `versely_list_models` |
| Slideshow | 8 | `versely_create_automated_slideshow`, `versely_add_text_overlay`, `versely_slideshow_to_video` |
| Movie | 7 | `versely_create_movie`, `versely_get_movie_status`, `versely_combine_movie` |
| UGC | 5 | `versely_add_video_overlay`, `versely_add_timestamped_captions` |
| Social | 8 | `versely_publish_post`, `versely_get_social_auth_url`, `versely_list_posts` |
| Status | 2 | `versely_get_task_status`, `versely_wait_for_task` |
| Utilities | 5 | `versely_merge_videos`, `versely_colorize_photo`, `versely_audio_isolation` |

See [TOOLS.md](./TOOLS.md) for every tool's input schema.

## Async generation: `mode: "wait"` vs `mode: "submit"`

Most generation tools (`versely_generate_image`, `versely_generate_video`, `versely_generate_music`, etc.) take an optional `mode` field:

- **`mode: "wait"` (default)** — submits the request, polls `/api/v1/status/:request_id` until the job completes (or fails / times out), and returns the final result data inline.
- **`mode: "submit"`** — submits and returns the `request_id` immediately. Useful when parallelizing multiple generations. Pass the `request_id` to `versely_get_task_status` (single check) or `versely_wait_for_task` (block-and-poll).

Per-call overrides: `poll_timeout_ms` and `poll_interval_ms`.

## Deploy to a server (DigitalOcean / any VPS)

The walkthrough lives in [`deploy/SETUP.md`](deploy/SETUP.md). Short version:

1. SSH in, install Node 20 + nginx + certbot + PM2
2. Clone, `npm ci && npm run build`
3. `pm2 start deploy/ecosystem.config.cjs && pm2 save && pm2 startup`
4. Drop [`deploy/nginx.conf`](deploy/nginx.conf) into `/etc/nginx/sites-available/` (replace placeholder hostname)
5. `sudo certbot --nginx -d versely-mcp.YOURDOMAIN.com`
6. Enable ufw

Subsequent deploys: `./deploy/deploy.sh` on the droplet — git pull + build + zero-downtime PM2 reload.

## Development

```bash
npm run dev         # tsx watch (no build step)
npm run typecheck   # tsc --noEmit
npm run build       # bundle to dist/index.js with shebang
npm run docs        # regenerate TOOLS.md from tool definitions
npm run smoke       # build + spawn HTTP server + 20 assertions
```

## Project layout

```
versely-mcp/
├── src/
│   ├── index.ts                  # bootstrap
│   ├── server.ts                 # MCP server factory (per-request)
│   ├── config.ts                 # env loader
│   ├── client.ts                 # Versely HTTP client (per-key)
│   ├── poller.ts                 # async status polling
│   ├── errors.ts                 # typed error classes
│   ├── transports/
│   │   └── http.ts               # Express + Streamable HTTP transport
│   └── tools/
│       ├── _types.ts / _helpers.ts / _async.ts / _registry.ts
│       ├── index.ts              # aggregator
│       ├── user.ts               # 6 tools
│       ├── generate.ts           # 10 tools
│       ├── slideshow.ts          # 8 tools
│       ├── movie.ts              # 7 tools
│       ├── ugc.ts                # 5 tools
│       ├── social.ts             # 8 tools
│       ├── status.ts             # 2 tools
│       └── features.ts           # 5 tools
├── scripts/
│   ├── generate-tools-doc.ts     # TOOLS.md generator
│   └── smoke-test.ts             # HTTP-mode smoke harness
├── deploy/
│   ├── ecosystem.config.cjs      # PM2 config
│   ├── nginx.conf                # nginx vhost template
│   ├── deploy.sh                 # pull + build + reload
│   └── SETUP.md                  # one-time droplet bootstrap
└── dist/                         # build output (gitignored)
```

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `401 missing_authorization` | client didn't send `Authorization` header |
| `401 invalid_api_key_format` | token doesn't start with `vsk_` |
| `401 authentication failed` from a tool call | the `vsk_` key is invalid / revoked at the Versely backend |
| `402 insufficient credits` | top up at <https://versely.studio> |
| `403 forbidden` | the API key lacks the required scope (run `versely_list_api_key_scopes`) |
| `Timed out after Xms waiting on request …` | generation took longer than the poll timeout. Increase `poll_timeout_ms`, raise `VERSELY_DEFAULT_POLL_TIMEOUT_MS`, or use `mode: "submit"` |
| `502 Bad Gateway` from the proxy | PM2 process down — `pm2 status`, `pm2 logs versely-mcp` |

## License

MIT
