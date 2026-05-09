# Install Versely MCP

Connect Claude (or any MCP-compatible client) to Versely so it can generate images, videos, music, slideshows and post to social — all from inside your chat.

> **Before publishing this guide:** replace `https://mcp.versely.studio/mcp` below with the real Versely MCP URL if it differs.

---

## What you need

1. **A Versely account** — sign up at [versely.studio](https://versely.studio) if you don't have one.
2. **A Versely API key** — see [Getting an API key](#getting-an-api-key) below.
3. **An MCP-compatible client** — Claude Desktop, Claude Code, Cursor, or another (see [Compatibility](#compatibility)).

You do **not** need to install Node, run anything locally, or self-host. Versely runs the MCP server. You just point your client at it.

---

## Getting an API key

1. Sign in at [versely.studio](https://versely.studio).
2. Open **Settings → API keys** (path may differ — look for "API keys" or "Developer").
3. Click **Create new key**.
4. Copy the key. It starts with `vsk_` and is shown **only once** — store it in a password manager.

Keep it secret. The key authorizes your account's credits and content.

---

## Install per client

Pick your client below. URL and key go in the same place every time:

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

The differences across clients are **where this JSON lives** and **how the client picks it up**.

### Claude Desktop

Claude Desktop's `claude_desktop_config.json` only understands **stdio** servers (a local subprocess). To use a hosted HTTP MCP like Versely, you bridge it through `mcp-remote` — a tiny npm tool that runs as a local stdio process and forwards calls to the remote URL. Claude Desktop sees a stdio server; under the hood it talks HTTP to Versely.

**Prereqs:** [Node.js](https://nodejs.org) installed locally (any version 18+). Check: `node --version`.

**Steps:**

1. Open **Claude → Settings → Developer → Edit Config** (or edit the file directly — paths below).
2. Add the bridged config:

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

3. Save, then **fully quit** Claude (Cmd-Q on macOS; right-click tray icon → Exit on Windows — closing the window is not enough). Reopen.
4. New chat → click the tools icon. You should see Versely tools.

`npx -y mcp-remote …` auto-installs the bridge on first run; no global install needed. Keeping the token in the `env` block (rather than inline in `args`) keeps the literal value out of the args array — cosmetic but cleaner.

**Config file paths if you skip the in-app editor:**

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

**Why not the simpler `url` + `headers` format?** Other clients (Claude Code CLI, Cursor, web Claude) support that shape directly. Claude Desktop's JSON config doesn't — it'll show *"not valid MCP server configurations and were skipped"* and silently drop the entry. The bridge is the workaround.

**Debugging the bridge:** If Claude Desktop shows tools as missing or the entry as invalid, run the same command manually to see the underlying error:

```bash
npx -y mcp-remote https://mcp.versely.studio/mcp --header "Authorization:Bearer vsk_YOUR_KEY"
```

### Claude Code (CLI)

Claude Code is the terminal CLI from Anthropic.

**Option A — `claude mcp` command:**

```bash
claude mcp add versely \
  --transport http \
  --url https://mcp.versely.studio/mcp \
  --header "Authorization: Bearer vsk_YOUR_KEY_HERE"
```

Run `claude mcp list` to confirm it's registered.

**Option B — edit `~/.claude.json`:**

The user-level config lives at `~/.claude.json` (macOS / Linux) or `%USERPROFILE%\.claude.json` (Windows). Add to the top-level `mcpServers` object:

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

Restart any open `claude` sessions to pick up the change.

### Cursor

Cursor is a fork of VS Code with built-in AI; it supports MCP via `~/.cursor/mcp.json`.

| OS | Path |
|---|---|
| macOS | `~/.cursor/mcp.json` |
| Linux | `~/.cursor/mcp.json` |
| Windows | `%USERPROFILE%\.cursor\mcp.json` |

Create the file if it doesn't exist, paste the JSON above, save. Restart Cursor.

You can also configure it in **Cursor → Settings → MCP** if your version exposes a UI.

### VS Code (with Cline, Continue, or Copilot Chat MCP)

If you use a VS Code extension that speaks MCP:

- **Cline** — open the Cline panel → settings (gear icon) → MCP Servers → paste the JSON.
- **Continue** — edit `~/.continue/config.yaml` and add a `mcpServers:` entry referencing the URL + auth header.
- **GitHub Copilot Chat** (recent versions) — workspace `.vscode/mcp.json` or user `settings.json` under `chat.mcp.servers`.

The shape is identical across them; only the file location changes.

### Other MCP clients

Any client that supports the **Streamable HTTP** transport works. The pattern is always:

- URL: `https://mcp.versely.studio/mcp`
- Header: `Authorization: Bearer vsk_YOUR_KEY_HERE`

If your client supports only stdio (legacy), it can't connect — Versely doesn't ship a stdio bridge.

---

## Verify it works

After restarting your client:

1. Start a new chat.
2. Ask: *"What Versely tools do you have available?"* — your client should list tools like `versely_get_me`, `versely_generate_image`, `versely_create_movie`, etc.
3. Run a smoke test: *"Use Versely to fetch my account profile and credit balance."* This calls `versely_get_me` and `versely_get_credits` and prints your plan + remaining credits — if both come back without errors, you're connected.

You can also check from a terminal without any client:

```bash
curl -s -X POST https://mcp.versely.studio/mcp \
  -H "Authorization: Bearer vsk_YOUR_KEY_HERE" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

You should get a JSON-RPC response listing all available tools.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Tools don't appear in the client UI | Config file edited but client wasn't fully restarted | Quit completely (not just close window) and reopen. On macOS use Cmd-Q; on Windows quit from the tray icon. |
| `401 missing_authorization` | No `Authorization` header sent | Double-check the JSON — the header value must be `Bearer vsk_...` (note the space). |
| `401 invalid_api_key_format` | Key doesn't start with `vsk_` or has stray whitespace | Re-copy from versely.studio. Watch for hidden spaces / line breaks. |
| `401 authentication failed` (from a tool, not the gate) | API key was revoked or your account was suspended | Generate a fresh key. |
| `402 insufficient credits` | You're out | Top up at [versely.studio](https://versely.studio). Run `versely_get_credits` to see balance. |
| `403 forbidden` from a tool | The key has restricted scopes | Run the tool `versely_list_api_key_scopes` to see what scopes exist; create a new key with the right scopes in the Versely dashboard. |
| Connection refused / timeout | Wrong URL, or your firewall blocks `mcp.versely.studio` | Curl the URL directly to confirm reachability. |
| Some tools succeed but `mode: "wait"` ones time out | Slow video models can take 3–5 minutes; defaults are 3 min | Pass `poll_timeout_ms: 600000` (10 min) on the call, or use `mode: "submit"` and poll with `versely_get_task_status`. |

If a problem isn't listed, file an issue with: client name + version, redacted config, and the full error from the client's developer console.

---

## Compatibility

| Client | Min version | Notes |
|---|---|---|
| Claude Desktop | Dec 2024 release | Native remote-URL support; older versions only ran local stdio servers. |
| Claude Code | 1.0+ | `claude mcp add --transport http` |
| Cursor | 0.45+ | Settings UI or `~/.cursor/mcp.json` |
| Cline (VS Code) | recent | Supports remote URLs in MCP settings |
| Continue.dev | 0.9+ | YAML-based config |
| GitHub Copilot Chat | recent | MCP support in chat.mcp.servers |

If your client only supports the old **stdio** transport (running an MCP server as a local subprocess), it can't talk to a hosted MCP directly. Workarounds: upgrade the client, or run a local stdio→HTTP proxy.

---

## Going further

- **Tool reference** — see [TOOLS.md](./TOOLS.md) for every available tool's input schema.
- **Self-hosting** — run your own copy on a VPS. See [`deploy/SETUP.md`](./deploy/SETUP.md).
- **Privacy** — the MCP forwards your `vsk_` key only to Versely's backend. The MCP server itself never sees plaintext content beyond what each tool call needs (see Versely's privacy policy at <https://versely.studio> for retention details).

---

## Need help?

- Versely support: [versely.studio/support](https://versely.studio)
- MCP spec: [modelcontextprotocol.io](https://modelcontextprotocol.io)
- This repo's issues: [github.com/AI-XLabs-Innovation/versely-mcp/issues](https://github.com/AI-XLabs-Innovation/versely-mcp/issues)
