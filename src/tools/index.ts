import type { Tool } from "./_types.js";
import { userTools } from "./user.js";
import { generateTools } from "./generate.js";
import { slideshowTools } from "./slideshow.js";
import { movieTools } from "./movie.js";
import { ugcTools } from "./ugc.js";
import { socialTools } from "./social.js";
import { statusTools } from "./status.js";
import { featuresTools } from "./features.js";
import { workflowTools } from "./workflows.js";
import { videoWorkflowTools } from "./videoWorkflows.js";
import { debugTools } from "./debug.js";
import { voiceTools } from "./voices.js";
import { dubbingTools } from "./dubbing.js";
import { automationTools } from "./automations.js";
import { audioTools } from "./audio.js";
import { billingTools } from "./billing.js";
import { avatarTools } from "./avatars.js";

/** Every tool users can be offered (subject to their profile — see _policy.ts). */
export const standardTools: Tool[] = [
  ...userTools,
  ...billingTools,
  ...generateTools,
  ...audioTools,
  ...avatarTools,
  ...slideshowTools,
  ...movieTools,
  ...ugcTools,
  ...socialTools,
  ...statusTools,
  ...featuresTools,
  ...workflowTools,
  ...videoWorkflowTools,
  ...voiceTools,
  ...dubbingTools,
  ...automationTools,
];

export { debugTools };

/**
 * Every tool DEFINED, registered or not. The policy table is checked against
 * this, so a row for the (normally unregistered) debug tool is still valid.
 */
export const allToolDefinitions: Tool[] = [...standardTools, ...debugTools];

/** What the server registers: debug tools only with MCP_ENABLE_DEBUG_TOOLS=1. */
export function registeredTools(opts: { enableDebugTools: boolean }): Tool[] {
  return opts.enableDebugTools ? allToolDefinitions : standardTools;
}
