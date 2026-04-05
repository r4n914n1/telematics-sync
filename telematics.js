"use strict";

const fs = require("node:fs");
const path = require("node:path");
const axios = require("axios");

const ROOT_DIR = __dirname;
const FIREBASE_CONFIG_PATH = path.join(ROOT_DIR, "firebase-config.js");
const LOG_PATH = path.join(ROOT_DIR, "telematics-sync.log");

const NTS_LOGIN_URL = "https://app.nts-international.net/NTSSecurity/login";
const NTS_ALL_VEHICLES_URL = "https://app.nts-international.net/ntsapi/allvehicles";
const NTS_ALL_VEHICLE_STATE_URL =
  "https://app.nts-international.net/ntsapi/allvehiclestate?timezone=UTC&sensors=true&ioin=true&version=2.3";
const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS || 30_000);
const ACTIVE_BROWSER_WINDOW_MS = 45_000;
const REQUIRE_ACTIVE_BROWSER =
  String(process.env.REQUIRE_ACTIVE_BROWSER || "true").toLowerCase() === "true";
const NTS_APP_HEADER = {
  "nts-application": "nts-rest-api"
};
const DEFAULT_MARKER_COLOR = "#0ea5e9";
const STALE_MARKER_COLOR = "#000000";

function appendLog(entry) {
  const line = JSON.stringify(entry) + "\n";
  fs.appendFileSync(LOG_PATH, line, "utf8");
}

function readFirebaseDatabaseUrl() {
  const fromEnv = String(process.env.FIREBASE_DB_URL || "").trim();
  if (fromEnv) {
    return fromEnv.replace(/\/$/, "");
  }

  const content = fs.readFileSync(FIREBASE_CONFIG_PATH, "utf8");
  const match = content.match(/databaseURL\s*:\s*"([^"]+)"/);

  if (!match || !match[1]) {
    throw new Error("databaseURL nije pronadjen u firebase-config.js");
  }

  return match[1].replace(/\/$/, "");
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();

  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  return { response, text, json };
}

function toVehicleArray(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (payload && Array.isArray(payload.vehicles)) {
    return payload.vehicles;
  }

  if (payload && payload.data && Array.isArray(payload.data)) {
    return payload.data;
  }

  return [];
}

function normalizeIgnitionStatus(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return ["true", "1", "on", "online", "running", "active"].includes(normalized);
}

function normalizeVehicle(raw, index) {
  const licenceplate =
    raw.licenceplate ||
    raw.licensePlate ||
    raw.registration ||
    raw.plate ||
    "";

  const id =
    raw.id ||
    raw.vehicleId ||
    raw.vehicleID ||
    raw.unitId ||
    raw.unitID ||
    raw.imei ||
    licenceplate ||
    `nts-${index + 1}`;

  const label =
    licenceplate ||
    raw.label ||
    raw.name ||
    raw.vehicleName ||
    String(id);

  const lat = Number(raw.lat ?? raw.latitude ?? raw.gpsLat ?? raw.y);
  const lng = Number(raw.lng ?? raw.lon ?? raw.long ?? raw.longitude ?? raw.gpsLng ?? raw.gpsLon ?? raw.x);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  return {
    id: String(id),
    licenceplate: String(licenceplate || id),
    label: String(label),
    lat,
    lng,
    gpsGMT: raw.gpsGMT ?? raw.gpsGmt ?? null,
    gmtLastDriveStatusChange: raw.gmtLastDriveStatusChange ?? null,
    gpsVelocity: raw.gpsVelocity ?? null,
    status: normalizeIgnitionStatus(raw.status ?? raw.ignition),
    source: "nts"
  };
}

function mapVehiclesToFirebasePayload(vehicles) {
  const mapped = {};

  vehicles.forEach((raw, index) => {
    const normalized = normalizeVehicle(raw, index);
    if (!normalized) {
      return;
    }

    mapped[normalized.id] = normalized;
  });

  return mapped;
}

async function readTelematicsSettings(databaseUrl) {
  const { response, json, text } = await fetchJson(`${databaseUrl}/telematics.json`);

  if (!response.ok) {
    throw new Error(`Firebase telematics read failed (${response.status}): ${text.slice(0, 200)}`);
  }

  if (!json) {
    throw new Error("Telematics settings nisu pronadjena u Firebase.");
  }

  return json;
}

async function hasActiveBrowserClient(databaseUrl) {
  const { response, json, text } = await fetchJson(`${databaseUrl}/syncClients.json`);

  if (!response.ok) {
    throw new Error(`Firebase syncClients read failed (${response.status}): ${text.slice(0, 200)}`);
  }

  if (!json || typeof json !== "object") {
    return false;
  }

  const now = Date.now();

  return Object.values(json).some((client) => {
    const lastSeen = Date.parse(client?.lastSeen || "");
    return Number.isFinite(lastSeen) && now - lastSeen <= ACTIVE_BROWSER_WINDOW_MS;
  });
}

async function loginToNts(username, password) {
  try {
    const loginResponse = await axios.post(
      NTS_LOGIN_URL,
      { key: "value" },
      {
        auth: {
          username,
          password
        },
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/plain, */*",
          ...NTS_APP_HEADER
        },
        validateStatus: () => true
      }
    );

    if (loginResponse.status < 200 || loginResponse.status >= 300) {
      throw new Error(`NTS login failed (${loginResponse.status}): ${JSON.stringify(loginResponse.data || "")}`);
    }

    const setCookieHeader = loginResponse.headers["set-cookie"];
    const cookieLine = Array.isArray(setCookieHeader) ? setCookieHeader[0] : "";
    const authToken = cookieLine.match(/auth-token=([^;]+)/)?.[1] || "";

    if (!authToken) {
      throw new Error("NTS login succeeded but auth-token nije pronadjen u set-cookie.");
    }

    return {
      authToken,
      cookie: `auth-token=${authToken}`
    };
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    if (status) {
      throw new Error(`NTS login failed (${status}): ${JSON.stringify(data || "")}`);
    }
    throw err;
  }
}

async function fetchAllVehiclesFromNts(auth) {
  try {
    const vehiclesResponse = await axios.get(`${NTS_ALL_VEHICLES_URL}?version=2.3`, {
      headers: {
        Cookie: auth.cookie,
        Accept: "application/json, text/plain, */*",
        ...NTS_APP_HEADER
      },
      validateStatus: () => true
    });

    if (vehiclesResponse.status < 200 || vehiclesResponse.status >= 300) {
      throw new Error(
        `NTS allvehicles failed (${vehiclesResponse.status}): ${JSON.stringify(vehiclesResponse.data || "")}`
      );
    }

    return toVehicleArray(vehiclesResponse.data);
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    if (status) {
      throw new Error(`NTS allvehicles failed (${status}): ${JSON.stringify(data || "")}`);
    }
    throw err;
  }
}

async function fetchAllVehicleStateFromNts(auth) {
  try {
    const response = await axios.get(NTS_ALL_VEHICLE_STATE_URL, {
      headers: {
        Cookie: auth.cookie,
        Accept: "application/json, text/plain, */*",
        ...NTS_APP_HEADER
      },
      validateStatus: () => true
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `NTS allvehiclestate failed (${response.status}): ${JSON.stringify(response.data || "")}`
      );
    }

    return Array.isArray(response.data) ? response.data : [];
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    if (status) {
      throw new Error(`NTS allvehiclestate failed (${status}): ${JSON.stringify(data || "")}`);
    }
    throw err;
  }
}

function combineVehicleData(vehicles, states) {
  const stateByVehicleId = new Map();

  states.forEach((state) => {
    const key = String(state.vehicleId ?? state.id ?? "");
    if (key) {
      stateByVehicleId.set(key, state);
    }
  });

  return vehicles.map((vehicle, index) => {
    const vehicleId = String(vehicle.id ?? vehicle.vehicleId ?? "");
    const state = stateByVehicleId.get(vehicleId) || {};

    return normalizeVehicle(
      {
        id: vehicle.id,
        vehicleId: vehicle.vehicleId,
        label: vehicle.label,
        name: vehicle.name,
        vehicleName: vehicle.vehicleName,
        plate: vehicle.plate,
        registration: vehicle.registration,
        licenceplate: vehicle.licenceplate,
        status: state.ignitionStatus ?? state.status,
        lat: state.gpsLat ?? vehicle.gpsLat ?? vehicle.latitude,
        lng: state.gpsLon ?? vehicle.gpsLon ?? vehicle.longitude,
        gpsGMT: state.gpsGMT ?? state.gpsGmt ?? vehicle.gpsGMT ?? vehicle.gpsGmt,
        gmtLastDriveStatusChange:
          state.gmtLastDriveStatusChange ??
          state.gmtlastdrivestatuschange ??
          vehicle.gmtLastDriveStatusChange,
        gpsVelocity: state.gpsVelocity ?? vehicle.gpsVelocity ?? null
      },
      index
    );
  }).filter(Boolean);
}

async function readExistingVehicles(databaseUrl) {
  const { response, json, text } = await fetchJson(`${databaseUrl}/vehicles.json`);

  if (!response.ok) {
    throw new Error(`Firebase vehicles read failed (${response.status}): ${text.slice(0, 200)}`);
  }

  return json || {};
}

async function writeVehiclesToFirebase(databaseUrl, nextVehicles, existingVehicles) {
  const nextIds = new Set(Object.keys(nextVehicles));
  const existingIds = Object.keys(existingVehicles || {});

  for (const [vehicleId, vehicle] of Object.entries(nextVehicles)) {
    const existingVehicle = existingVehicles?.[vehicleId] || {};
    const payload = { ...vehicle };

    // Boju korisnika cuvamo kao primarnu. Crna je samo privremena stale boja.
    if (existingVehicle.color === STALE_MARKER_COLOR && existingVehicle.colorBeforeStale) {
      payload.color = existingVehicle.colorBeforeStale;
      payload.colorBeforeStale = null;
    } else if (existingVehicle.color) {
      delete payload.color;
      payload.colorBeforeStale = null;
    } else {
      payload.color = DEFAULT_MARKER_COLOR;
      payload.colorBeforeStale = null;
    }

    // Label vise ne prepisujemo ako vec postoji u Firebase.
    // Ako ne postoji, inicijalno ga postavljamo na licenceplate.
    if (typeof existingVehicle.label === "string" && existingVehicle.label.trim()) {
      delete payload.label;
    } else {
      payload.label = String(payload.licenceplate || existingVehicle.licenceplate || vehicleId);
    }

    const response = await fetch(`${databaseUrl}/vehicles/${encodeURIComponent(vehicleId)}.json`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Firebase vehicle write failed (${response.status}): ${text.slice(0, 200)}`);
    }
  }

  // Vozila koja nisu stigla u novom feedu ostaju u Firebase, ali postaju "stale"
  // i dobijaju crnu boju dok ne stigne novi update iz telematike.
  for (const vehicleId of existingIds) {
    if (nextIds.has(vehicleId)) {
      continue;
    }

    const existingVehicle = existingVehicles?.[vehicleId] || {};
    const backupColor =
      existingVehicle.color && existingVehicle.color !== STALE_MARKER_COLOR
        ? existingVehicle.color
        : existingVehicle.colorBeforeStale || DEFAULT_MARKER_COLOR;

    const response = await fetch(`${databaseUrl}/vehicles/${encodeURIComponent(vehicleId)}.json`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        color: STALE_MARKER_COLOR,
        colorBeforeStale: backupColor
      })
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Firebase stale-vehicle update failed (${response.status}): ${text.slice(0, 200)}`);
    }
  }
}

async function runSingleSync(databaseUrl, options = {}) {
  const started = Date.now();
  const requireActiveClient = options.requireActiveClient !== false;

  try {
    if (requireActiveClient) {
      const hasActiveClient = await hasActiveBrowserClient(databaseUrl);

      if (!hasActiveClient) {
        const durationMs = Date.now() - started;
        console.log("[Telematics] Sync preskočen - nema aktivnog browser klijenta.");
        return {
          ok: true,
          skipped: true,
          count: 0,
          durationMs,
          message: "Skipped: no active browser client"
        };
      }
    }

    const settings = await readTelematicsSettings(databaseUrl);

    const provider = String(settings.provider || "").toLowerCase();
    const username = String(settings.username || "").trim();
    const password = String(settings.password || "").trim();

    if (provider !== "nts") {
      throw new Error(`Provider nije NTS (trenutno: ${settings.provider || "nije postavljen"})`);
    }

    if (!username || !password) {
      throw new Error("Nedostaju username/password u telematics settings.");
    }

    const auth = await loginToNts(username, password);
    const ntsVehicles = await fetchAllVehiclesFromNts(auth);
    const ntsVehicleStates = await fetchAllVehicleStateFromNts(auth);
    const combinedVehicles = combineVehicleData(ntsVehicles, ntsVehicleStates);
    const firebaseVehicles = mapVehiclesToFirebasePayload(combinedVehicles);
    const existingVehicles = await readExistingVehicles(databaseUrl);

    await writeVehiclesToFirebase(databaseUrl, firebaseVehicles, existingVehicles);

    const durationMs = Date.now() - started;
    appendLog({
      ok: true,
      at: new Date().toISOString(),
      count: Object.keys(firebaseVehicles).length,
      durationMs,
      message: "Sync successful"
    });

    console.log(`[Telematics] Sync OK: ${Object.keys(firebaseVehicles).length} vozila (${durationMs}ms)`);
    return {
      ok: true,
      skipped: false,
      count: Object.keys(firebaseVehicles).length,
      durationMs,
      message: "Sync successful"
    };
  } catch (error) {
    const durationMs = Date.now() - started;
    appendLog({
      ok: false,
      at: new Date().toISOString(),
      durationMs,
      message: error.message
    });

    console.error("[Telematics] Sync error:", error.message);
    return {
      ok: false,
      skipped: false,
      count: 0,
      durationMs,
      message: error.message
    };
  }
}

const SYNC_HOUR_START = Number(process.env.SYNC_HOUR_START || 6);
const SYNC_HOUR_END   = Number(process.env.SYNC_HOUR_END   || 18);

function isWithinSyncWindow() {
  const h = new Date().getHours();
  return h >= SYNC_HOUR_START && h < SYNC_HOUR_END;
}

async function checkManualSync(databaseUrl) {
  try {
    const { response, json } = await fetchJson(`${databaseUrl}/syncClients/manualSync.json`);
    if (!response.ok || json !== true) return false;
    // Reset flag
    await fetch(`${databaseUrl}/syncClients/manualSync.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "false"
    });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const databaseUrl = readFirebaseDatabaseUrl();
  console.log(`[Telematics] Sync start. Firebase: ${databaseUrl}`);

  let syncing = false;

  async function doSync(opts = {}) {
    if (syncing) return;
    syncing = true;
    try {
      await runSingleSync(databaseUrl, opts);
    } catch (err) {
      console.error("[Telematics] Unexpected sync error:", err.message);
    } finally {
      syncing = false;
    }
  }

  await doSync({ requireActiveClient: REQUIRE_ACTIVE_BROWSER });

  // Regular interval — samo u vremenskom prozoru
  setInterval(() => {
    if (!isWithinSyncWindow()) {
      console.log(`[Telematics] Izvan radnog vremena (${SYNC_HOUR_START}-${SYNC_HOUR_END}h) — preskočen.`);
      return;
    }
    doSync({ requireActiveClient: REQUIRE_ACTIVE_BROWSER });
  }, SYNC_INTERVAL_MS);

  // Manual sync trigger — uvijek aktivan, poll every 3s
  setInterval(async () => {
    const manual = await checkManualSync(databaseUrl);
    if (manual) {
      console.log("[Telematics] Ručni sync pokrenut.");
      doSync({ requireActiveClient: false });
    }
  }, 3000);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[Telematics] Fatal error:", err.message);
    process.exitCode = 1;
  });
}

module.exports = {
  runSingleSync,
  readFirebaseDatabaseUrl,
  hasActiveBrowserClient
};
