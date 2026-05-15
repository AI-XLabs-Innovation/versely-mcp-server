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

export const allTools: Tool[] = [
  ...userTools,
  ...generateTools,
  ...slideshowTools,
  ...movieTools,
  ...ugcTools,
  ...socialTools,
  ...statusTools,
  ...featuresTools,
  ...workflowTools,
  ...videoWorkflowTools,
  ...debugTools,
];
