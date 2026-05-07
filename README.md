# versely-mcp-server

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the Versely content creation API as **51 curated tools** for any MCP-compatible client (Claude Desktop, Claude Code, Cursor, etc.). Generate images / videos / music, build slideshows, assemble multi-scene movies, edit UGC, and post to 9 social platforms — all from a single MCP connection.

> Full tool reference: **[TOOLS.md](./TOOLS.md)** (auto-generated, 51 tools across 8 categories).

## Install & run

Requires **Node 20+**. The server speaks stdio — clients spawn it as a subprocess.

```bash
npm install
npm run build
node dist/index.js   # smoke test from terminal (stdin closes immediately)
```

Once published to npm: `npx -y versely-mcp-server`.

## Configuration

| Variable | Required | Default | Notes |
|---|---|---|---|
| `VERSELY_API_KEY` | yes | — | Versely API key (must start with `vsk_`). Generate at `POST /api/v1/auth/api-keys`. |
| `VERSELY_API_URL` | no | `https://api.versely.studio` | Override for dev / ngrok tunnels. |
| `VERSELY_DEFAULT_POLL_TIMEOUT_MS` | no | `180000` (3 min) | Max wait for async tools when `mode: "wait"`. |
| `VERSELY_DEFAULT_POLL_INTERVAL_MS` | no | `3000` | Initial poll interval (1.5× exponential backoff up to 4×). |

The server fails fast (exit code 2) if any value is missing or malformed, so misconfiguration surfaces before the MCP transport opens.

## Client config

### Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "versely": {
      "command": "node",
      "args": ["/absolute/path/to/versely-mcp/dist/index.js"],
      "env": {
        "VERSELY_API_KEY": "vsk_..."
      }
    }
  }
}
```

After publish: replace `command`/`args` with `"command": "npx", "args": ["-y", "versely-mcp-server"]`.

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
- **`mode: "submit"`** — submits the request and returns the `request_id` immediately. Useful when you want to parallelize multiple generations or come back later. Pass the returned `request_id` to `versely_get_task_status` (single check) or `versely_wait_for_task` (block-and-poll).

Per-call overrides: `poll_timeout_ms` and `poll_interval_ms`.

## Development

```bash
npm run dev         # tsx, no build step
npm run typecheck   # tsc --noEmit
npm run build       # bundle to dist/index.js with shebang
npm run docs        # regenerate TOOLS.md
npm run smoke       # build + offline JSON-RPC handshake test
```

## Project layout

```
versely-mcp/
├── src/
│   ├── index.ts          # bootstrap (loads config, starts server)
│   ├── server.ts         # MCP server + tool dispatch
│   ├── config.ts         # env loader
│   ├── client.ts         # Versely HTTP client (undici)
│   ├── poller.ts         # async status polling
│   ├── errors.ts         # typed error classes + message builder
│   └── tools/
│       ├── _types.ts     # Tool / ToolContext / ToolResult
│       ├── _helpers.ts   # jsonResult / errorResult / resolveUserId
│       ├── _async.ts     # mode + AsyncFields + handleAsync
│       ├── _registry.ts  # tool collection
│       ├── index.ts      # aggregator
│       ├── user.ts       # 6 tools
│       ├── generate.ts   # 10 tools
│       ├── slideshow.ts  # 8 tools
│       ├── movie.ts      # 7 tools
│       ├── ugc.ts        # 5 tools
│       ├── social.ts     # 8 tools
│       ├── status.ts     # 2 tools
│       └── features.ts   # 5 tools
├── scripts/
│   ├── generate-tools-doc.ts    # TOOLS.md generator
│   └── smoke-test.ts            # offline MCP handshake test
└── dist/                        # build output (gitignored)
```

## Troubleshooting

- **`config error: VERSELY_API_KEY is required`** — set the env var in your client config under `mcpServers.versely.env`. The server cannot prompt; missing config is a fatal startup error.
- **`401 authentication failed`** — your API key is invalid or revoked. Check at the Versely dashboard or rotate via `POST /api/v1/auth/api-keys`.
- **`402 insufficient credits`** — top up at <https://versely.studio>.
- **`403 forbidden`** — the key lacks the required scope. Run `versely_list_api_key_scopes` to see the catalog and create a new key with the right scope.
- **`Timed out after Xms waiting on request …`** — the generation took longer than your poll timeout. Either increase `poll_timeout_ms`, raise `VERSELY_DEFAULT_POLL_TIMEOUT_MS`, or pass `mode: "submit"` and poll later with `versely_wait_for_task`.
- **Want a tool that's not here?** — the curated set covers the most common workflows. For one-off endpoints not exposed as tools, use the existing markdown skills (which document the raw HTTP API) until the tool is added.

## License

MIT
