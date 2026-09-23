/**
 * OpenAI Apps domain-verification token, served as plain text at
 * GET /.well-known/openai-apps-challenge (see transports/http.ts).
 *
 * The token is public by design — OpenAI fetches it anonymously to confirm we
 * control mcp.versely.studio — so it lives in the repo rather than in env.
 * Paste the value from the OpenAI Platform's plugin draft here and deploy.
 * While it is empty the route answers 404.
 */
export const OPENAI_APPS_CHALLENGE_TOKEN = "";
