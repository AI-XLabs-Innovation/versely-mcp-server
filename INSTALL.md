# Install Versely MCP

Connect Claude, ChatGPT or any MCP-compatible client to Versely so it can generate videos, voiceovers, images, music and slideshows — and, outside ChatGPT, post to social — all from inside your chat.

The server URL is always:

```
https://mcp.versely.studio/mcp
```

---

## What you need

1. **A Versely account** — sign up at [versely.studio](https://versely.studio) if you don't have one.
2. **An MCP-compatible client** — claude.ai, ChatGPT, Claude Desktop, Claude Code, Cursor, or another (see [Compatibility](#compatibility)).

You do **not** need to install Node, run anything locally, or self-host. Versely runs the MCP server; you point your client at it.

There are two ways to authenticate:

- **Sign in with Versely (OAuth) — recommended.** Your client opens a Versely sign-in page once, and you approve the connection. Nothing to copy or store; remove the connector in your client to disconnect.
- **API key.** For clients without OAuth support, or for scripts. See [Using an API key](#using-an-api-key).

---

## Connect with your Versely account (OAuth)

### claude.ai (web, desktop and mobile apps)

1. Open **Settings → Connectors → Add custom connector**.
2. Name it `Versely` and paste `https://mcp.versely.studio/mcp` as the URL.
3. Click **Connect**, sign in to Versely, and approve.

The connector is then available in every chat (toggle it from the tools menu). Media results show up as inline cards that update themselves while a job runs.

### ChatGPT

Until the Versely plugin is listed in ChatGPT's directory, you can add it in **developer mode** (available on paid ChatGPT plans):

1. In ChatGPT's settings, turn on **Developer mode**.
2. Add a new app/connector with the URL `https://mcp.versely.studio/mcp` and **OAuth** authentication.
3. Sign in to Versely when prompted and approve.

ChatGPT gets the plugin's tool set: video, image, voiceover and music generation, UGC edits, slideshows, movies and dubbing. Social posting and workflows aren't part of it.

### Claude Code (CLI)

```bash
claude mcp add --transport http versely https://mcp.versely.studio/mcp
```

Then run `/mcp` inside Claude Code and choose **Authenticate** for `versely` — your browser opens the Versely sign-in page. Run `claude mcp list` to confirm the server is registered.

### Claude Desktop (config-file setup)

If you prefer the config file over the Connectors screen, bridge the remote server through `mcp-remote`, which handles the OAuth sign-in for you:

```json
{
  "mcpServers": {
    "versely": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.versely.studio/mcp"]
    }
  }
}
```

**Prereqs:** [Node.js](https://nodejs.org) 18+ installed locally (`node --version`). Open **Claude → Settings → Developer → Edit Config**, paste the block, save, then **fully quit** Claude (Cmd-Q on macOS; right-click the tray icon → Exit on Windows — closing the window is not enough) and reopen. A browser window asks you to sign in to Versely the first time.

**Config file paths if you skip the in-app editor:**

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

---

## Using an API key

### Getting an API key

1. Sign in at [versely.studio](https://versely.studio).
2. Open **Settings → API keys** (look for "API keys" or "Developer").
3. Click **Create new key**.
4. Copy the key. It starts with `vsk_` and is shown **only once** — store it in a password manager.

Keep it secret. The key authorizes your account's credits and content.

### Claude Code (CLI)

```bash
claude mcp add --transport http versely https://mcp.versely.studio/mcp \
  --header "Authorization: Bearer vsk_YOUR_KEY_HERE"
```

Or edit `~/.claude.json` (macOS / Linux) or `%USERPROFILE%\.claude.json` (Windows) and add to the top-level `mcpServers` object:

```json
{
  "mcpServers": {
    "versely": {
      "type": "http",
      "url": "https://mcp.versely.studio/mcp",
      "headers": {
        "Authorization": "Bearer vsk_YOUR_KEY_HERE"
      }
    }
  }
}
```

Restart any open `claude` sessions to pick up the change.

### Claude Desktop

```json
{
  "mcpServers": {
    "versely": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://mcp.versely.studio/mcp",
        "--header",
        "Authorization:${VERSELY_AUTH}"
      ],
      "env": {
        "VERSELY_AUTH": "Bearer vsk_YOUR_KEY_HERE"
      }
    }
  }
}
```

Keeping the token in the `env` block (rather than inline in `args`) keeps the literal value out of the args array. If Claude Desktop shows the tools as missing, run the same command manually to see the underlying error:

```bash
npx -y mcp-remote https://mcp.versely.studio/mcp --header "Authorization:Bearer vsk_YOUR_KEY"
```

### Cursor

Cursor supports MCP via `~/.cursor/mcp.json` (`%USERPROFILE%\.cursor\mcp.json` on Windows), or **Cursor → Settings → MCP**:

```json
{
  "mcpServers": {
    "versely": {
      "url": "https://mcp.versely.studio/mcp",
      "headers": {
        "Authorization": "Bearer vsk_YOUR_KEY_HERE"
      }
    }
  }
}
```

Restart Cursor after saving.

### VS Code (Cline, Continue, or Copilot Chat)

- **Cline** — open the Cline panel → settings (gear icon) → MCP Servers → paste the JSON above.
- **Continue** — edit `~/.continue/config.yaml` and add an `mcpServers:` entry with the URL and auth header.
- **GitHub Copilot Chat** — workspace `.vscode/mcp.json` or user `settings.json` under `chat.mcp.servers`.

### Other MCP clients

Any client that supports the **Streamable HTTP** transport works:

- URL: `https://mcp.versely.studio/mcp`
- Either OAuth (the server advertises its authorization server at `/.well-known/oauth-protected-resource`) or the header `Authorization: Bearer vsk_YOUR_KEY_HERE`.

Clients that only speak stdio can connect through `mcp-remote` as shown for Claude Desktop.

---

## Verify it works

1. Start a new chat.
2. Ask: *"What Versely tools do you have?"* — you should see tools like `versely_generate_video`, `versely_generate_image`, `versely_create_movie`.
3. Ask: *"What's my Versely credit balance?"* — this calls `versely_get_credits`. If it answers without an error, you're connected.

From a terminal, with an API key:

```bash
curl -s -X POST https://mcp.versely.studio/mcp \
  -H "Authorization: Bearer vsk_YOUR_KEY_HERE" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

You should get a JSON-RPC response listing the available tools.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Tools don't appear in the client UI | Config edited but the client wasn't fully restarted | Quit completely (not just close the window) and reopen. |
| The sign-in page never opens | The client doesn't support OAuth for remote servers | Use an [API key](#using-an-api-key), or the `mcp-remote` bridge. |
| `401 missing_authorization` | No credentials were sent | For API keys, the header value must be `Bearer vsk_...` (note the space). |
| `401 invalid_token` | The sign-in expired or was revoked, or the key has stray whitespace | Reconnect (OAuth) or re-copy the key. |
| `authentication failed` (from a tool) | Versely rejected the connection's credentials | Reconnect, or create a fresh API key. |
| `Not enough Versely credits for this` | The job costs more than your balance | Ask for your balance (`versely_get_credits`). |
| `Unknown tool` in ChatGPT | That tool isn't part of the ChatGPT plugin (social posting, workflows) | Use claude.ai, Claude Code or an API-key client for those. |
| A long video "times out" | The job keeps running after the chat moves on | The inline card updates by itself; or ask for the job's status later. Don't resubmit — that starts (and charges for) a second job. |
| Connection refused / timeout | Wrong URL, or a firewall blocks `mcp.versely.studio` | Curl the URL directly to confirm reachability. |

If a problem isn't listed, file an issue with: client name + version, redacted config, and the full error from the client.

---

## Compatibility

| Client | Min version | Notes |
|---|---|---|
| claude.ai | current | Settings → Connectors → custom connector (OAuth) |
| ChatGPT | developer mode | OAuth; the plugin tool set |
| Claude Desktop | Dec 2024 release | Connectors screen, or `mcp-remote` in the config file |
| Claude Code | 1.0+ | `claude mcp add --transport http <name> <url>` |
| Cursor | 0.45+ | Settings UI or `~/.cursor/mcp.json` |
| Cline (VS Code) | recent | Remote URLs in MCP settings |
| Continue.dev | 0.9+ | YAML-based config |
| GitHub Copilot Chat | recent | `chat.mcp.servers` |

---

## Going further

- **Tool reference** — [TOOLS.md](./TOOLS.md) lists every tool's input schema and which are in the ChatGPT plugin.
- **Self-hosting** — run your own copy on a VPS. See [`deploy/SETUP.md`](./deploy/SETUP.md).
- **Privacy** — the MCP server forwards your credentials only to Versely's backend and keeps no content beyond what each tool call needs. See Versely's privacy policy at <https://www.versely.studio/privacy>.

## Need help?

- Versely support: [versely.studio/support](https://www.versely.studio/support)
- MCP spec: [modelcontextprotocol.io](https://modelcontextprotocol.io)
- This repo's issues: [github.com/AI-XLabs-Innovation/versely-mcp-server/issues](https://github.com/AI-XLabs-Innovation/versely-mcp-server/issues)
