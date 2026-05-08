// PM2 ecosystem file — referenced by deploy/deploy.sh and the SETUP guide.
// IMPORTANT: this server uses per-request auth (clients send their own
// `vsk_` API key in the Authorization header). DO NOT set VERSELY_API_KEY here.

const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");

module.exports = {
  apps: [
    {
      name: "versely-mcp",
      cwd: ROOT,
      script: path.join(ROOT, "dist/index.js"),
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 1000,
      // Must exceed the in-app graceful shutdown timeout (10s) so PM2 lets
      // the drain finish before SIGKILL.
      kill_timeout: 12000,
      env: {
        NODE_ENV: "production",
        MCP_HTTP_HOST: "127.0.0.1",
        MCP_HTTP_PORT: "8080",
        VERSELY_API_URL: "https://api.versely.studio",
        // Optional tuning:
        // VERSELY_DEFAULT_POLL_TIMEOUT_MS: "300000",
        // VERSELY_DEFAULT_POLL_INTERVAL_MS: "3000",
      },
    },
  ],
};
