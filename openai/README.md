# OpenAI plugin package (ChatGPT + Codex directory)

What gets uploaded under **Plugins → Versely → Upload plugin** in the OpenAI Platform dashboard.

| File | Purpose |
|---|---|
| `plugin.json` | Manifest: version (bump it above the last published one), discovery keywords, and `extensions.com.openai` — the listing (`interface`), the 5 positive and 3 negative review test cases, the commerce statement and the release notes. |
| `mcp.json` | The server, `https://mcp.versely.studio/mcp/openai`, and how it signs in (OAuth, dynamic client registration). Everything that connects on that path gets the `openai` tool profile (no billing, checkout or subscription tools): ChatGPT, whose tokens also carry `ck: "openai"`, and Codex, which installs the same directory plugin but signs in from the user's machine with an ordinary token. The portal cannot change this URL after the first connection (that needs OpenAI support), so it is not `/mcp`. |
| `assets/icon.png` | Logo and composer icon: the app icon on white, 1024×1024. |
| `skills/get-started/SKILL.md` | The onboarding skill (`onboardingSkill`): checks the account is connected, asks what the user makes, offers to save their brand, suggests a first piece. A public ZIP needs at least one skill (`plugin_runtime_surface_missing`), and every `versely_*` tool a skill names must be in the `openai` profile (the build checks both). |

Build (checks every limit from OpenAI's submission guide, then zips the four entries at the root):

```bash
node scripts/build-openai-plugin.mjs          # writes output/versely-openai-<version>.zip
node scripts/build-openai-plugin.mjs --check  # validate only
```

Never put reviewer credentials or the demo video URL in this folder: the repo is public and both go in the dashboard.

The developer name in `plugin.json` is the publisher named on versely.studio/privacy and /terms (AI XLabs Innovation). The portal shows the verified developer identity chosen at upload whatever the ZIP says, and it wants the public pages to name the same publisher.

Before the first submission: verify the organization, create the plugin draft, and put the domain-verification token it shows in `src/openaiChallenge.ts` (served at `/.well-known/openai-apps-challenge`), then deploy. Server-only changes don't need a new ZIP: deploy, then use **Rescan** in the portal. Listing or test-case changes need a new ZIP and a new review.
