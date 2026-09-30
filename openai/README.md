# OpenAI plugin package (ChatGPT + Codex directory)

What gets uploaded under **Plugins → Versely → Upload plugin** in the OpenAI Platform dashboard.

| File | Purpose |
|---|---|
| `plugin.json` | Manifest: version (bump it above the last published one), discovery keywords, and `extensions.com.openai` — the listing (`interface`), the 5 positive and 3 negative review test cases, the commerce statement and the release notes. |
| `mcp.json` | The server, `https://mcp.versely.studio/mcp`. A ChatGPT connection gets a `ck: "openai"` token, which always lands on the `openai` tool profile (no billing, checkout or subscription tools). |
| `assets/icon.png` | Logo and composer icon: the app icon on white, 1024×1024. |

Build (checks every limit from OpenAI's submission guide, then zips the three entries at the root):

```bash
node scripts/build-openai-plugin.mjs          # writes output/versely-openai-<version>.zip
node scripts/build-openai-plugin.mjs --check  # validate only
```

Never put reviewer credentials or the demo video URL in this folder: the repo is public and both go in the dashboard.

Before the first submission: verify the organization, create the plugin draft, and put the domain-verification token it shows in `src/openaiChallenge.ts` (served at `/.well-known/openai-apps-challenge`), then deploy. Server-only changes don't need a new ZIP: deploy, then use **Rescan** in the portal. Listing or test-case changes need a new ZIP and a new review.
