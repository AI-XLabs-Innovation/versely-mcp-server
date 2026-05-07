import { loadConfig, SERVER_NAME } from "./config.js";
import { startServer } from "./server.js";
import { VerselyConfigError } from "./errors.js";

async function main(): Promise<void> {
  const config = loadConfig();
  await startServer(config);
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
