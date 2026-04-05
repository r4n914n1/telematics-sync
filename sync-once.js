"use strict";

const { runSingleSync, readFirebaseDatabaseUrl } = require("./telematics");

async function main() {
  const databaseUrl = readFirebaseDatabaseUrl();
  const result = await runSingleSync(databaseUrl, { requireActiveClient: false });

  if (!result.ok) {
    console.error(`[SyncOnce] Failed: ${result.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`[SyncOnce] OK: count=${result.count}, skipped=${result.skipped}, durationMs=${result.durationMs}`);
}

main().catch((err) => {
  console.error("[SyncOnce] Fatal:", err.message);
  process.exitCode = 1;
});
