"use strict";

const express = require("express");
const { runSingleSync, readFirebaseDatabaseUrl } = require("./telematics");

const app = express();
const port = Number(process.env.PORT || 8080);
const requireActiveClient = String(process.env.REQUIRE_ACTIVE_BROWSER || "false").toLowerCase() === "true";

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, service: "telematics-cloudrun" });
});

app.post("/sync", async (_req, res) => {
  try {
    const databaseUrl = readFirebaseDatabaseUrl();
    const result = await runSingleSync(databaseUrl, { requireActiveClient });

    if (!result.ok) {
      res.status(500).json(result);
      return;
    }

    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

app.listen(port, () => {
  console.log(`[CloudRun] Listening on port ${port}`);
});
