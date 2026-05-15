// Render-pipeline test tool.
//
// Isolates the MCP Apps iframe render from every other moving part: no API
// call, no auth, no async, no signed URLs. Returns a hardcoded
// structuredContent payload with a public placeholder image so the host has
// nothing to fail on except the iframe itself.
//
// Outcome A — card renders: iframe + handshake + payload delivery all work,
//   so any non-rendering in the real media tools is a data/state issue
//   (asset URL shape, CSP block on the CDN, structuredContent missing).
// Outcome B — blank gap: the issue is in the host (claude.ai), not us, and
//   the diagnostic is the same regardless of which tool is called.

import { z } from "zod";
import { defineTool, type Tool } from "./_types.js";
import { metaForMediaCard, buildMediaCardPayload } from "../ui/templates.js";

const PLACEHOLDER_IMAGE =
  "https://picsum.photos/seed/versely-mcp-render-test/1024/1024";

const versely_render_test_card = defineTool({
  name: "versely_render_test_card",
  description:
    "Render-pipeline smoke test. Returns a hardcoded media-card payload (no API call, no auth) so the MCP Apps iframe render can be tested in isolation. If this renders inline but real generation tools don't, the gap is in data delivery, not the UI template.",
  meta: metaForMediaCard(),
  inputSchema: z.object({
    label: z
      .string()
      .optional()
      .describe("Optional label shown as the card's prompt header."),
  }),
  handler: async (input) => {
    const structuredContent = buildMediaCardPayload(
      "image",
      [{ url: PLACEHOLDER_IMAGE, label: "placeholder.jpg" }],
      {
        model: "Render Test",
        prompt:
          input.label ?? "Static payload — confirms the iframe renders inline.",
        aspect_ratio: "1:1",
        toolName: "versely_render_test_card",
        toolArgs: input.label ? { label: input.label } : {},
      },
    );
    return {
      content: [
        {
          type: "text",
          text: `Render test card. Placeholder image: ${PLACEHOLDER_IMAGE}`,
        },
      ],
      ...(structuredContent ? { structuredContent } : {}),
    };
  },
});

export const debugTools: Tool[] = [versely_render_test_card];
