/**
 * vehicle.js
 * Preuzima pozicije vozila u realnom vremenu iz Firebase Realtime Database
 * i prikazuje ih na Leaflet mapi kao SVG markere u obliku obrnute kapljice.
 *
 * Ako Firebase nije konfigurisan, koristi statične podatke kao fallback.
 */


// Čuva aktivne markere po ID-u vozila radi efikasnog ažuriranja
const _vehicleMarkers = new Map();
// Set of vehicle IDs explicitly hidden by the user
const _hiddenVehicles = new Set();
// Čuva poslednje poznate podatke vozila radi ponovnog renderovanja pri promeni skale
const _vehicleDataCache = new Map();
let _textMeasureCtx = null;

/**
 * Kreira Leaflet DivIcon u obliku obrnute kapljice (pin).
 * @param {string} color - Boja markera u hex formatu
 * @param {string} label - Kratka oznaka vozila prikazana unutar markera
 * @returns {L.DivIcon}
 */
function _escapeSvgText(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function _measureTextWidth(text, fontSpec, letterSpacingPx) {
  if (!_textMeasureCtx) {
    const canvas = document.createElement("canvas");
    _textMeasureCtx = canvas.getContext("2d");
  }

  if (!_textMeasureCtx) {
    return String(text || "").length * 7;
  }

  _textMeasureCtx.font = fontSpec;
  const normalized = String(text || "");
  const baseWidth = _textMeasureCtx.measureText(normalized).width;
  const spacingWidth = Math.max(0, normalized.length - 1) * (letterSpacingPx || 0);
  return baseWidth + spacingWidth;
}

function createVehicleIcon(color, label, gpsVelocity, status) {
  const id = "g" + Math.random().toString(36).slice(2, 7);
  const rawLabel = String(label || "").trim();
  const markerLabel = _escapeSvgText(rawLabel || "-");
  const labelLen = Math.max(1, rawLabel.length);
  const textFontSize = 11.1;
  const textLetterSpacing = 0.2;
  const textFontSpec = `700 ${textFontSize}px "Segoe UI", Arial, sans-serif`;
  const measuredTextWidth = _measureTextWidth(rawLabel || "-", textFontSpec, textLetterSpacing);
  // Extra space includes target side padding, stroke thickness and rendering tolerance.
  const panelWidth = Math.max(26, Math.ceil(measuredTextWidth + 10));
  const markerWidth = Math.ceil(panelWidth);
  const markerHeight = 50;
  const centerX = markerWidth / 2;
  const panelX = centerX - panelWidth / 2;
  const panelBottomY = 20;
  const panelHeight = 14.8;
  const panelY = panelBottomY - panelHeight;
  const panelRight = panelX + panelWidth;
  const panelRadius = 3.2;
  const tailHalfWidth = labelLen <= 3 ? 13 : 12;
  const tailLeftX = centerX - tailHalfWidth;
  const tailRightX = centerX + tailHalfWidth;
  const tailTipY = 49;
  const baseTopWidth = tailRightX - tailLeftX;
  const minExtraForRoundedJoin = panelRadius * 2 + 4;
  const topIsWiderThanBase = panelWidth >= baseTopWidth + minExtraForRoundedJoin;
  const lowerRadius = topIsWiderThanBase ? panelRadius : 0;
  const rightLowerJoin = topIsWiderThanBase
    ? `V${panelBottomY - lowerRadius}
        Q${panelRight} ${panelBottomY} ${panelRight - lowerRadius} ${panelBottomY}
        H${tailRightX + lowerRadius}
        Q${tailRightX} ${panelBottomY} ${tailRightX} ${panelBottomY + lowerRadius}`
    : `V${panelBottomY}
        H${tailRightX}`;
  const leftLowerJoin = topIsWiderThanBase
    ? `L${tailLeftX} ${panelBottomY + lowerRadius}
        Q${tailLeftX} ${panelBottomY} ${tailLeftX - lowerRadius} ${panelBottomY}
        H${panelX + lowerRadius}
        Q${panelX} ${panelBottomY} ${panelX} ${panelBottomY - lowerRadius}`
    : `L${tailLeftX} ${panelBottomY}
        H${panelX}`;
  
  // Generiši indikator brzine
  const velocity = Number(gpsVelocity) || 0;
  const isIgnitionOn = status === true;
  let speedIndicator = "";
  
  if (velocity === 0 && isIgnitionOn) {
    // Stop znak - beli kvadratić sa crnom ivicom (vozilo je ukljuceno ali stoji)
    const stopSize = 8;
    const stopX = centerX - stopSize / 2;
    const stopY = 24;
    speedIndicator = `<rect x="${stopX}" y="${stopY}" width="${stopSize}" height="${stopSize}" fill="white" stroke="#000000" stroke-width="0.9" rx="1.2"/>`;
  } else if (velocity > 0 && velocity < 8) {
    // Pause znak - dva mala vertikalna pravougaonika (sporo kretanje)
    const pauseHeight = 8;
    const pauseWidth = 3;
    const pauseGap = 1.5;
    const pauseY = 23;
    const leftRectX = centerX - pauseWidth - pauseGap / 2;
    const rightRectX = centerX + pauseGap / 2;
    speedIndicator = `<rect x="${leftRectX}" y="${pauseY}" width="${pauseWidth}" height="${pauseHeight}" fill="white" stroke="#000000" stroke-width="0.7"/><rect x="${rightRectX}" y="${pauseY}" width="${pauseWidth}" height="${pauseHeight}" fill="white" stroke="#000000" stroke-width="0.7"/>`;
  } else if (velocity > 7) {
    // Play znak - beli jednakostrani trougao sa crnom ivicom (play dugme ►)
    const triHeight = 8;
    const triWidth = 8;
    const triY = 23;
    speedIndicator = `<polygon points="${centerX + triWidth / 2},${triY + triHeight / 2} ${centerX - triWidth / 2},${triY} ${centerX - triWidth / 2},${triY + triHeight}" fill="white" stroke="#000000" stroke-width="0.9"/>`;
  }
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${markerWidth}" height="${markerHeight}" viewBox="0 0 ${markerWidth} ${markerHeight}" style="overflow: visible;">
      <defs>
        <filter id="shadow-${id}" x="-40%" y="-10%" width="180%" height="160%">
          <feDropShadow dx="0" dy="3" stdDeviation="2.5" flood-color="rgba(0,0,0,0.38)"/>
        </filter>
      </defs>
      <path
        d="M${panelX + panelRadius} ${panelY}
           H${panelRight - panelRadius}
           Q${panelRight} ${panelY} ${panelRight} ${panelY + panelRadius}
           ${rightLowerJoin}
           L${centerX} ${tailTipY}
           ${leftLowerJoin}
           V${panelY + panelRadius}
           Q${panelX} ${panelY} ${panelX + panelRadius} ${panelY}
           Z"
        fill="${color}"
        stroke="rgba(0,0,0,0.75)"
        stroke-width="1"
        stroke-linejoin="round"
        filter="url(#shadow-${id})"
      />
      <text
        x="${centerX}"
        y="16.5"
        text-anchor="middle"
        font-family="Segoe UI, Arial, sans-serif"
        font-size="${textFontSize}"
        font-weight="700"
        fill="#ffffff"
        stroke="#000000"
        stroke-width="1.1"
        paint-order="stroke fill"
        letter-spacing="${textLetterSpacing}"
      >${markerLabel}</text>
      ${speedIndicator}
    </svg>`.trim();

  const scale = window.markerSizeScale || 1;
  const scaledW = Math.round(markerWidth * scale);
  const scaledH = Math.round(markerHeight * scale);
  const scaledSvg = svg.replace(`width="${markerWidth}" height="${markerHeight}"`, `width="${scaledW}" height="${scaledH}"`);
  return L.divIcon({
    html: scaledSvg,
    className: "vehicle-marker",
    iconSize: [scaledW, scaledH],
    iconAnchor: [Math.round(centerX * scale), Math.round(49 * scale)],
    popupAnchor: [0, -50],
  });
}

function _buildPopup(v) {
  const label = v.label || v.licenceplate || v.registration || v.id;

  return `<div class="vehicle-popup">
    <strong>${label}</strong>
    <span class="vehicle-id">${label}</span>
    <span class="vehicle-status">${v.status}</span>
  </div>`;
}

function _formatDateTime(value) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }

  const raw = String(value).trim();
  if (!raw) {
    return "-";
  }


  // Ako je format 'YYYY-MM-DD HH:mm:ss' bez vremenske zone, dodaj 'Z' (UTC)
  let normalized = raw.replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(normalized)) {
    normalized += "Z";
  }
  let date = new Date(normalized);

  if (!Number.isFinite(date.getTime()) && /^\d+$/.test(raw)) {
    const numeric = Number(raw);
    const ms = raw.length <= 10 ? numeric * 1000 : numeric;
    date = new Date(ms);
  }

  if (!Number.isFinite(date.getTime())) {
    return raw;
  }

  // Prikaz u lokalnom vremenu korisnika
  return date.toLocaleString("sr-RS", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function _buildTooltip(v) {
  const plate = v.licenceplate || v.registration || v.label || v.id || "-";
  const gpsGMT = _formatDateTime(v.gpsGMT);
  const lastDriveStatusRaw =
    v.gmtLastDriveStatusChange ??
    v.lastDriveStatusChange ??
    v.LastDriveStatusChange ??
    v.gmtlastdrivestatuschange;
  const lastDriveStatusChange = _formatDateTime(lastDriveStatusRaw);

  return `<div class="vehicle-tooltip-content">
    <strong class="vehicle-tooltip-title">${plate}</strong>
    <div class="vehicle-tooltip-grid">
      <span class="vehicle-tooltip-label">Poslednja promena:</span>
      <span class="vehicle-tooltip-value">${gpsGMT}</span>
      <span class="vehicle-tooltip-label">Poslednji status:</span>
      <span class="vehicle-tooltip-value">${lastDriveStatusChange}</span>
    </div>
  </div>`;
}

/**
 * Pretplaćuje se na Firebase i u realnom vremenu dodaje/ažurira/uklanja markere.
 * @param {L.Map} map
 */
function addVehicles(map) {
  if (db) {
    // Firebase je konfigurisan — real-time listener
    db.ref("vehicles").on("value", (snapshot) => {
      const data = snapshot.val() || {};
      console.log("[Vehicle] Firebase podaci primljeni:", data);
      const vehicles = Object.values(data);
      console.log("[Vehicle] Broj vozila iz Firebase:", vehicles.length);
      if (vehicles.length === 0) {
        console.warn("[Vehicle] Firebase je prazan — nema markera za prikaz.");
      }
      _syncMarkers(map, vehicles);
    }, (err) => {
      console.error("[Vehicle] Firebase greška:", err.message);
      _syncMarkers(map, []);
    });
  } else {
    // Fallback: statični podaci
    console.log("[Vehicle] Firebase nije konfigurisan — koriste se statični podaci.");
    _syncMarkers(map, STATIC_VEHICLES);
  }
}

function _syncMarkers(map, vehicles) {
  vehicles.forEach((vehicle) => {
    const latlng = [vehicle.lat, vehicle.lng];
    const markerColor = vehicle.color || "#0ea5e9";
    const markerLabel = vehicle.label || vehicle.licenceplate || vehicle.registration || vehicle.id;
    const gpsVelocity = vehicle.gpsVelocity;
    const status = vehicle.status;
    _vehicleDataCache.set(vehicle.id, vehicle);
    // Sync hidden state from Firebase data
    if (vehicle.hidden === true) _hiddenVehicles.add(vehicle.id);
    else _hiddenVehicles.delete(vehicle.id);
    const isHidden = _hiddenVehicles.has(vehicle.id);
    if (_vehicleMarkers.has(vehicle.id)) {
      const marker = _vehicleMarkers.get(vehicle.id);
      marker.setLatLng(latlng);
      marker.setIcon(createVehicleIcon(markerColor, markerLabel, gpsVelocity, status));
      marker.setTooltipContent(_buildTooltip(vehicle));
      if (isHidden) { if (map.hasLayer(marker)) marker.remove(); }
      else          { if (!map.hasLayer(marker)) marker.addTo(map); }
    } else {
      const marker = L.marker(latlng, { icon: createVehicleIcon(markerColor, markerLabel, gpsVelocity, status), zIndexOffset: -100 })
        .bindTooltip(_buildTooltip(vehicle), {
          direction: "top",
          offset: [0, -42],
          opacity: 1,
          className: "vehicle-tooltip"
        });
      _vehicleMarkers.set(vehicle.id, marker);
      if (!isHidden) marker.addTo(map);
    }
  });

  // Ukloni markere čija vozila više ne postoje
  _vehicleMarkers.forEach((marker, id) => {
    if (!vehicles.find((v) => v.id === id)) {
      marker.remove();
      _vehicleMarkers.delete(id);
      _vehicleDataCache.delete(id);
    }
  });
}

function refreshAllVehicleIcons() {
  _vehicleMarkers.forEach((marker, id) => {
    const v = _vehicleDataCache.get(id);
    if (!v) return;
    const markerColor = v.color || "#0ea5e9";
    const markerLabel = v.label || v.licenceplate || v.registration || v.id;
    marker.setIcon(createVehicleIcon(markerColor, markerLabel, v.gpsVelocity, v.status));
  });
}
window.refreshAllVehicleIcons = refreshAllVehicleIcons;

function toggleVehicleVisibility(id) {
  const marker = _vehicleMarkers.get(id);
  const nowHidden = !_hiddenVehicles.has(id);
  if (nowHidden) {
    _hiddenVehicles.add(id);
    if (marker && marker._map) marker.remove();
  } else {
    _hiddenVehicles.delete(id);
    const data = _vehicleDataCache.get(id);
    if (marker && data && !marker._map) {
      const map = window._leafletMap;
      if (map) marker.addTo(map);
    }
  }
  return nowHidden; // true = now hidden
}
window.toggleVehicleVisibility = toggleVehicleVisibility;

/**
 * Centrira mapu tako da budu vidljiva sva vozila odjednom.
 * @param {L.Map} map
 */
function fitAllVehicles(map) {
  if (!map || _vehicleMarkers.size === 0) {
    console.warn("[Vehicle] Nema vozila za prikaz.");
    return;
  }

  const bounds = L.latLngBounds();
  let count = 0;

  _vehicleMarkers.forEach((marker, id) => {
    if (!_hiddenVehicles.has(id)) {
      bounds.extend(marker.getLatLng());
      count++;
    }
  });

  if (count === 0) {
    console.warn("[Vehicle] Nema vidljivih vozila za centriranje.");
    return;
  }

  map.fitBounds(bounds, { padding: [50, 50], maxZoom: 13 });
  console.log(`[Vehicle] Mapa centrirana - prikazano ${count} vozila.`);
}
