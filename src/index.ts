import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// Load .env from the package root (one level up from dist/index.js after build,
// or src/ during dev — both resolve to the same parent directory).
dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env"),
});

import { loadConfig, SERVER_NAME } from "./config.js";
import { startHttpServer } from "./transports/http.js";
import { VerselyConfigError } from "./errors.js";

async function main(): Promise<void> {
  const config = loadConfig();
  await startHttpServer(config);
}

main().catch((err) => {
  if (err instanceof VerselyConfigError) {
    process.stderr.write(`[${SERVER_NAME}] config error: ${err.message}\n`);
    process.exit(2);
  }
  process.stderr.write(
    `[${SERVER_NAME}] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
