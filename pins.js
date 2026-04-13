"use strict";

(function bootstrapPins(global) {
  function initPins(map) {
    if (!map || typeof L === "undefined") {
      return null;
    }

    const pinsDialog      = document.getElementById("pins-dialog");
    const dlgTitle        = document.getElementById("pins-dialog-title");
    const dlgClose        = document.getElementById("pins-dialog-close");
    const inputLabel      = document.getElementById("pins-input-label");
    const inputNote       = document.getElementById("pins-input-note");
    const inputFrom       = document.getElementById("pins-input-from");
    const inputTo         = document.getElementById("pins-input-to");
    const inputWeekSelect = document.getElementById("pins-week-select");
    const inputUpozorenje       = document.getElementById("pins-check-upozorenje");
    const inputUpozorjenjeKm    = document.getElementById("pins-check-upozorenje-km");
    const inputAlarm            = document.getElementById("pins-check-alarm");
    const inputTajmer           = document.getElementById("pins-check-tajmer");
    const inputTajmerMin        = document.getElementById("pins-check-tajmer-min");
    const shapePicker     = null; // replaced by type picker
    const typePicker      = document.getElementById("pins-type-picker");
    const vehicleTrigger   = document.getElementById("pins-vehicle-trigger");
    const vehicleDot        = document.getElementById("pins-vehicle-dot");
    const vehicleLabel      = document.getElementById("pins-vehicle-label");
    const vehicleDropdown   = document.getElementById("pins-vehicle-dropdown");
    const btnSave         = document.getElementById("pins-btn-save");
    const btnDelete       = document.getElementById("pins-btn-delete");

    const pinsLayer = L.layerGroup().addTo(map);
    const activePins = new Map(); // pinId -> { data, marker, tipHidden }

    let _filterFrom = null; // "YYYY-MM-DD" or null
    let _filterTo   = null;
    let defaultProximityKm      = 3;
    let defaultTajmerMin         = 30;
    let defaultProximityEnabled  = true;
    let defaultTajmerEnabled     = true;

    // (Alarm time picker uklonjen)

    // ── Checkbox visibility toggles ──────────────────────────────────────────
    const _tajmerExtras = document.getElementById("pins-tajmer-extras");
    const _alarmExtras  = document.getElementById("pins-alarm-extras");
    function _syncUpozorenjeVis() {
      if (!inputUpozorjenjeKm) return;
      const checked = !!inputUpozorenje?.checked;
      inputUpozorjenjeKm.disabled = !checked;
      inputUpozorjenjeKm.value = checked ? (inputUpozorjenjeKm.value || defaultProximityKm) : "";
    }
    function _syncTajmerVis(forceDefault) {
      if (!inputTajmerMin) return;
      const checked = !!inputTajmer?.checked;
      inputTajmerMin.disabled = !checked;
      // Always use the latest defaultTajmerMin from settings if checked
      if (checked) {
        if (forceDefault || !inputTajmerMin.value || Number(inputTajmerMin.value) === _syncTajmerVis._lastDefault) {
          inputTajmerMin.value = defaultTajmerMin;
        }
      } else {
        inputTajmerMin.value = "";
      }
      _syncTajmerVis._lastDefault = defaultTajmerMin;
    }
    // (Alarm UI sync uklonjen)
    if (inputUpozorenje) inputUpozorenje.addEventListener("change", _syncUpozorenjeVis);
    if (inputTajmer) inputTajmer.addEventListener("change", () => _syncTajmerVis(true));
    // (Alarm event listener uklonjen)
    // ── End checkbox visibility toggles ─────────────────────────────────────

    function isPinInRange(data) {
      if (!_filterFrom && !_filterTo) return true;
      const pFrom = data.visibleFrom || "";
      const pTo   = data.visibleTo   || "";
      if (!pFrom && !pTo) return true;
      const f = _filterFrom || "0000-00-00";
      const t = _filterTo   || "9999-99-99";
      return pFrom <= t && pTo >= f;
    }

    function clearAllPins() {
      // Remove all markers from the map and clear the activePins map
      activePins.forEach(({ marker }) => {
        if (pinsLayer.hasLayer(marker)) pinsLayer.removeLayer(marker);
      });
      activePins.clear();
    }

    async function applyDateFilter(from, to) {
      _filterFrom = from || null;
      _filterTo   = to   || null;
      clearAllPins();
      await loadPins(_filterFrom, _filterTo);
    }

    let dialogMode    = "add"; // "add" | "edit"
    let editingPinId  = null;
    let pendingLatLng = null;
    let selectedPinType = "utovar";
    let selectedColor = "#6b7280";
    let selectedVehicleId = null;
    let vehicleColorMap = {}; // vehicleId -> color
    let vehicleLabelMap = {}; // vehicleId -> label

    const PIN_TYPES = Object.freeze([
      { key: "utovar",      label: "Nalog za utovar" },
      { key: "poi",         label: "Tačka interesovanja" },
      { key: "placeholder", label: "Stop" }
    ]);
    const DEFAULT_TYPE_SHAPES = { utovar: "square", poi: "circle", placeholder: "diamond" };
    let pinTypeShapes = { ...DEFAULT_TYPE_SHAPES };

    function getShapeForType(type) {
      return pinTypeShapes[type] || "square";
    }

    // ── SVG ──────────────────────────────────────────────────────────────────

    function darkenColor(hex, amount = 0.45) {
      const c = String(hex || "#6b7280").trim().replace(/^#/, "");
      const full = c.length === 3 ? c.split("").map(x => x+x).join("") : c;
      const r = Math.round(parseInt(full.slice(0,2),16) * amount);
      const g = Math.round(parseInt(full.slice(2,4),16) * amount);
      const b = Math.round(parseInt(full.slice(4,6),16) * amount);
      return `#${r.toString(16).padStart(2,"0")}${g.toString(16).padStart(2,"0")}${b.toString(16).padStart(2,"0")}`;
    }

    function createShapeSvg(shape, color, label) {
      const c = String(color || "#6b7280").trim() || "#6b7280";
      const gid = `pg${Math.random().toString(36).slice(2, 7)}`;
      const lbl = String(label || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const txt = lbl ? `<text x="16" y="16" text-anchor="middle" dominant-baseline="central" font-family="sans-serif" font-size="13" font-weight="bold" fill="#fff" stroke="#000" stroke-width="1.2" paint-order="stroke" pointer-events="none">${lbl}</text>` : "";
      const defs = `<defs>
        <linearGradient id="${gid}" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%"   stop-color="#fff" stop-opacity="0.52"/>
          <stop offset="45%"  stop-color="#fff" stop-opacity="0.08"/>
          <stop offset="100%" stop-color="#000" stop-opacity="0.32"/>
        </linearGradient>
      </defs>`;
      if (shape === "circle") {
        return `<svg viewBox="0 0 32 32" overflow="visible" aria-hidden="true" focusable="false">${defs}
          <g class="pin-shape-layer">
          <circle cx="16" cy="16" r="12" fill="#000"/>
          <circle cx="16" cy="16" r="11" fill="#fff"/>
          <circle cx="16" cy="16" r="9"  fill="#000"/>
          </g>
          <circle cx="16" cy="16" r="8"  fill="${c}"/>
          <circle cx="16" cy="16" r="8"  fill="url(#${gid})"/>${txt}
        </svg>`;
      }
      if (shape === "diamond") {
        return `<svg viewBox="0 0 32 32" overflow="visible" aria-hidden="true" focusable="false">${defs}
          <g class="pin-shape-layer">
          <path d="M16 -1 L33 16 L16 33 L-1 16 Z"       fill="#000"/>
          <path d="M16 0.4 L31.6 16 L16 31.6 L0.4 16 Z" fill="#fff"/>
          <path d="M16 3.3 L28.7 16 L16 28.7 L3.3 16 Z" fill="#000"/>
          </g>
          <path d="M16 4.7 L27.3 16 L16 27.3 L4.7 16 Z" fill="${c}"/>
          <path d="M16 4.7 L27.3 16 L16 27.3 L4.7 16 Z" fill="url(#${gid})"/>${txt}
        </svg>`;
      }
      return `<svg viewBox="0 0 32 32" overflow="visible" aria-hidden="true" focusable="false">${defs}
        <g class="pin-shape-layer">
        <rect x="4"  y="4"  width="24" height="24" fill="#000"/>
        <rect x="5"  y="5"  width="22" height="22" fill="#fff"/>
        <rect x="7"  y="7"  width="18" height="18" fill="#000"/>
        </g>
        <rect x="8"  y="8"  width="16" height="16" fill="${c}"/>
        <rect x="8"  y="8"  width="16" height="16" fill="url(#${gid})"/>${txt}
      </svg>`;
    }

    // ── Zoom-based sizing ─────────────────────────────────────────────────────

    // Tier 0 = small (zoom < 10), Tier 1 = medium (zoom 10-13), Tier 2 = large (zoom > 13)
    const PIN_SIZES = [
      { size: 18, anchor: 9  },
      { size: 25, anchor: 12 },
      { size: 32, anchor: 16 },
      { size: 41, anchor: 20 }
    ];

    function getPinTier() {
      const z = map.getZoom();
      if (z < 6)  return 0;
      if (z <= 8) return 1;
      if (z <= 12) return 2;
      return 3;
    }

    // Mapping from marker scale to pin list scale
    function markerScaleToPinListScale(markerScale) {
      // Accepts numbers like 1, 1.1, ..., 1.5
      const mapping = {
        1: 1,
        1.1: 1.05,
        1.2: 1.1,
        1.3: 1.15,
        1.4: 1.2,
        1.5: 1.25
      };
      // Use string keys for exact match, fallback to 1
      return mapping[String(markerScale)] || 1;
    }

    function createPinIcon(shape, color, label) {
      const validShapes = ["square", "circle", "diamond"];
      const s = validShapes.includes(shape) ? shape : "square";
      const t = PIN_SIZES[getPinTier()];
      const scale = window.markerSizeScale || 1;
      const scaledSize   = Math.round(t.size   * scale);
      const scaledAnchor = Math.round(t.anchor * scale);
      const safeLabel = label
        ? String(label).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        : "";
      // pill font-size matches SVG text size at current pin scale
      const txtPx = Math.round(13 * scaledSize / 32);
      const pillHtml = safeLabel && safeLabel.length > 2
        ? `<span class="custom-pin-pill" style="font-size:${txtPx}px;padding:${Math.round(txtPx*0.18)}px ${Math.round(txtPx*0.25)}px">${safeLabel}</span>`
        : "";
      return L.divIcon({
        className: "custom-pin-wrap",
        html: `<div class="custom-pin-outer${safeLabel && safeLabel.length > 2 ? " has-label" : ""}">${pillHtml}<span class="custom-pin custom-pin-${s}">${createShapeSvg(s, color, label)}</span></div>`,
        iconSize: [scaledSize, scaledSize],
        iconAnchor: [scaledAnchor, scaledAnchor]
      });
    }

    // ── Type picker ───────────────────────────────────────────────────────────

    function refreshTypePicker(activeType, color) {
      if (!typePicker) return;
      typePicker.querySelectorAll(".pins-type-btn").forEach((btn) => {
        const ptype = btn.dataset.ptype;
        btn.classList.toggle("active", ptype === activeType);
        const prev = btn.querySelector(".pins-type-preview");
        if (prev) prev.innerHTML = createShapeSvg(getShapeForType(ptype), color);
      });
    }

    if (typePicker) {
      typePicker.addEventListener("click", (e) => {
        const btn = e.target.closest(".pins-type-btn");
        if (!btn) return;
        selectedPinType = btn.dataset.ptype;
        refreshTypePicker(selectedPinType, selectedColor);
      });
    }

    // ── Settings section ──────────────────────────────────────────────────────

    function initSettingsSection() {
      const container = document.getElementById("pin-type-shapes-settings");
      if (!container) return;
      container.innerHTML = "";
      const shapeList = ["square", "circle", "diamond"];
      const shapeLabel = { square: "Kvadrat", circle: "Krug", diamond: "Dijamant" };
      PIN_TYPES.forEach(({ key, label }) => {
        const row = document.createElement("div");
        row.className = "pts-row";
        const pickerBtns = shapeList.map(s => {
          const isActive = (pinTypeShapes[key] || "square") === s;
          return `<button type="button" class="pts-shape-btn${isActive ? " active" : ""}" data-ptype="${key}" data-shape="${s}" title="${shapeLabel[s]}">${createShapeSvg(s, "#4a9eff")}</button>`;
        }).join("");
        row.innerHTML = `<span class="pts-label">${label}</span><div class="pts-shape-pick">${pickerBtns}</div>`;
        container.appendChild(row);
      });
      container.addEventListener("click", async (e) => {
        const btn = e.target.closest(".pts-shape-btn");
        if (!btn) return;
        const { ptype, shape } = btn.dataset;
        if (!ptype || !shape) return;
        pinTypeShapes[ptype] = shape;
        container.querySelectorAll(`.pts-shape-btn[data-ptype="${ptype}"]`).forEach(b => {
          b.classList.toggle("active", b.dataset.shape === shape);
        });
        try {
          await getDb()?.ref("settings/pinTypeShapes").update({ [ptype]: shape });
        } catch (err) {
          console.warn("[Pins] Greška pri čuvanju oblika:", err.message);
        }
        refreshTypePicker(selectedPinType, selectedColor);
        refreshAllPins();
      });
    }

    function updateVehicleTrigger() {
      if (!vehicleDot || !vehicleLabel) return;
      if (selectedVehicleId) {
        vehicleDot.style.background = vehicleColorMap[selectedVehicleId] || "#6b7280";
        vehicleLabel.textContent = vehicleLabelMap[selectedVehicleId] || selectedVehicleId;
      } else {
        vehicleDot.style.background = "#94a3b8";
        vehicleLabel.textContent = "— Bez vozila —";
      }
    }

    function closeVehicleDropdown() {
      if (vehicleTrigger) vehicleTrigger.classList.remove("open");
    }

    function selectVehicleItem(vid) {
      selectedVehicleId = vid || null;
      selectedColor = selectedVehicleId ? (vehicleColorMap[selectedVehicleId] || "#6b7280") : "#6b7280";
      vehicleDropdown?.querySelectorAll(".pins-vehicle-item").forEach((el) => {
        el.classList.toggle("selected", el.dataset.vid === (vid || ""));
      });
      updateVehicleTrigger();
      refreshTypePicker(selectedPinType, selectedColor);
      closeVehicleDropdown();
    }

    if (vehicleTrigger) {
      vehicleTrigger.addEventListener("click", (e) => {
        e.stopPropagation();
        const isHidden = vehicleDropdown?.hidden;
        closeVehicleDropdown();
        if (isHidden) {
          vehicleDropdown.hidden = false;
          vehicleTrigger.classList.add("open");
        }
      });
    }

    document.addEventListener("click", (e) => {
      if (vehicleDropdown && !vehicleDropdown.hidden) {
        if (!vehicleDropdown.contains(e.target) && e.target !== vehicleTrigger && !vehicleTrigger?.contains(e.target)) {
          closeVehicleDropdown();
        }
      }
    });

    async function loadVehiclesForPicker(activeVehicleId) {
      if (!vehicleDropdown) return;
      vehicleDropdown.innerHTML = "";
      vehicleColorMap = {};
      vehicleLabelMap = {};
      selectedVehicleId = activeVehicleId || null;
      // "Bez vozila" item
      const noItem = document.createElement("div");
      noItem.className = "pins-vehicle-item" + (!activeVehicleId ? " selected" : "");
      noItem.dataset.vid = "";
      noItem.innerHTML = `<span class="pins-vehicle-dot" style="background:#94a3b8"></span><span>— Bez vozila —</span>`;
      noItem.addEventListener("click", () => selectVehicleItem(null));
      vehicleDropdown.appendChild(noItem);
      const db = getDb();
      if (!db) {
        updateVehicleTrigger();
        refreshTypePicker(selectedPinType, selectedColor);
        return;
      }
      try {
        const snapshot = await db.ref("vehicles").once("value");
        const vehicles = snapshot.val() || {};
        Object.entries(vehicles).forEach(([id, v]) => {
          if (!v) return;
          vehicleColorMap[id] = v.color || "#6b7280";
          vehicleLabelMap[id] = v.label || v.licenceplate || "";
          const item = document.createElement("div");
          item.className = "pins-vehicle-item" + (id === activeVehicleId ? " selected" : "");
          item.dataset.vid = id;
          const lbl = vehicleLabelMap[id] || id;
          item.innerHTML = `<span class="pins-vehicle-dot" style="background:${vehicleColorMap[id]}"></span><span>${lbl}</span>`;
          item.addEventListener("click", () => selectVehicleItem(id));
          vehicleDropdown.appendChild(item);
        });
        selectedColor = activeVehicleId ? (vehicleColorMap[activeVehicleId] || "#6b7280") : "#6b7280";
        updateVehicleTrigger();
        refreshTypePicker(selectedPinType, selectedColor);
        const selectedEl = vehicleDropdown.querySelector(".pins-vehicle-item.selected");
        if (selectedEl) selectedEl.scrollIntoView({ block: "nearest" });
      } catch (err) {
        console.warn("[Pins] Greška pri učitavanju vozila za picker:", err.message);
      }
    }

    // ── Pin type shapes from Firebase ───────────────────────────────────

    async function loadPinTypeShapes() {
      const db = getDb();
      if (db) {
        try {
          const snap = await db.ref("settings/pinTypeShapes").once("value");
          const saved = snap.val() || {};
          pinTypeShapes = { ...DEFAULT_TYPE_SHAPES, ...saved };
          {
            const _uid = window.currentUid;
            const _sRef = _uid ? db.ref(`userSettings/${_uid}`) : db.ref("settings");
            const _snap = await _sRef.once("value");
            const _s = _snap.val() || {};
            if (_s.proximityKm        != null) defaultProximityKm      = _s.proximityKm;
            if (_s.alarmMin           != null) defaultTajmerMin        = _s.alarmMin;
            if (_s.proximityEnabled   != null) defaultProximityEnabled = !!_s.proximityEnabled;
            if (_s.tajmerEnabled      != null) defaultTajmerEnabled    = !!_s.tajmerEnabled;
          }
        } catch (err) {
          console.warn("[Pins] Greška pri učitavanju oblika pinova:", err.message);
        }
      }
      initSettingsSection();
      refreshTypePicker(selectedPinType, selectedColor);
      // Update tajmer min input if present
      if (typeof _syncTajmerVis === "function") _syncTajmerVis(true);
        // Ensure tajmer min input uses latest default when opening dialog
        function openAddDialog(latlng) {
          // ...existing code...
          if (inputTajmer) inputTajmer.checked = false;
          if (typeof _syncTajmerVis === "function") _syncTajmerVis(true);
          // ...existing code...
        }
        function openEditDialog(pinId) {
          // ...existing code...
          if (typeof _syncTajmerVis === "function") _syncTajmerVis(true);
          // ...existing code...
        }
    }

    // ── Dialog helpers ────────────────────────────────────────────────────────

    function todayStr() {
      return new Date().toISOString().slice(0, 10);
    }

    function weekBoundsStr() {
      const now = new Date();
      const day = now.getDay(); // 0=Sun, 1=Mon ... 6=Sat
      const diffToMon = (day === 0 ? -6 : 1 - day);
      const mon = new Date(now);
      mon.setDate(now.getDate() + diffToMon);
      const sun = new Date(mon);
      sun.setDate(mon.getDate() + 6);
      const fmt = (d) => d.toISOString().slice(0, 10);
      return { from: fmt(mon), to: fmt(sun) };
    }

    // Returns Monday date of ISO week `week` in `year`
    function isoWeekToMonday(year, week) {
      const jan4 = new Date(year, 0, 4);
      const day = jan4.getDay() || 7;
      const mon = new Date(jan4);
      mon.setDate(jan4.getDate() - (day - 1) + (week - 1) * 7);
      return mon;
    }

    function getISOWeek(date) {
      const target = new Date(date.valueOf());
      const dayNr = (target.getDay() + 6) % 7;
      target.setDate(target.getDate() - dayNr + 3);
      const jan4 = new Date(target.getFullYear(), 0, 4);
      const diff = (target - jan4) / 86400000;
      return 1 + Math.round(diff / 7);
    }

    function populateWeekSelect(selectFromDate) {
      if (!inputWeekSelect) return;
      const now = new Date();
      const options = [];
      for (let w = -8; w <= 16; w++) {
        const d = new Date(now);
        d.setDate(now.getDate() + w * 7);
        const isoWeek = getISOWeek(d);
        const y = d.getFullYear();
        const mon = isoWeekToMonday(y, isoWeek);
        const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
        const fmt = (dt) => dt.toISOString().slice(0, 10);
        const value = `${y}-W${String(isoWeek).padStart(2, "0")}`;
        if (!options.find(o => o.value === value)) {
          options.push({ value, label: `N${isoWeek}  (${fmt(mon).slice(5)} – ${fmt(sun).slice(5)})`, from: fmt(mon), to: fmt(sun) });
        }
      }
      options.sort((a, b) => a.value.localeCompare(b.value));
      inputWeekSelect.innerHTML = options
        .map(o => `<option value="${o.value}" data-from="${o.from}" data-to="${o.to}">${o.label}</option>`)
        .join("");
      // Ako je prosleđen datum, pokušaj da selektuješ nedelju koja pokriva taj datum
      let target = selectFromDate || weekBoundsStr().from;
      let match = options.find(o => o.from === target) || options.find(o => o.from === weekBoundsStr().from);
      if (match) inputWeekSelect.value = match.value;
      else inputWeekSelect.value = "";
    }

    if (inputWeekSelect) {
      inputWeekSelect.addEventListener("change", () => {
        const sel = inputWeekSelect.options[inputWeekSelect.selectedIndex];
        if (inputFrom) inputFrom.value = sel.dataset.from;
        if (inputTo)   inputTo.value   = sel.dataset.to;
      });
    }

    async function reloadUserSettings() {
      let proxEnabled = true, alarmEnabled = true, proxKm = 3, alarmMin = 30;
      const db = getDb();
      if (db) {
        try {
          const _uid = window.currentUid;
          const _sRef = _uid ? db.ref(`userSettings/${_uid}`) : db.ref("settings");
          const _snap = await _sRef.once("value");
          const _s = _snap.val() || {};
          if (_s.proximityEnabled != null) proxEnabled  = !!_s.proximityEnabled;
          if (_s.tajmerEnabled    != null) alarmEnabled = !!_s.tajmerEnabled;
          if (_s.proximityKm      != null) proxKm       = _s.proximityKm;
          if (_s.alarmMin         != null) alarmMin     = _s.alarmMin;
        } catch (e) {}
      }
      defaultProximityKm = proxKm;
      defaultTajmerMin = alarmMin;
      defaultProximityEnabled = proxEnabled;
      defaultTajmerEnabled = alarmEnabled;
      return { proxEnabled, alarmEnabled, proxKm, alarmMin };
    }

    async function openAddDialog(latlng) {
      dialogMode    = "add";
      editingPinId  = null;
      pendingLatLng = latlng;
      const wb = weekBoundsStr();
      if (dlgTitle)   dlgTitle.textContent = "Novi pin";
      if (inputLabel) inputLabel.value     = "";
      if (inputNote)  inputNote.value      = "";
      if (inputFrom)  inputFrom.value      = wb.from;
      if (inputTo)    inputTo.value        = wb.to;
      populateWeekSelect(wb.from); // uvek selektuje trenutnu nedelju
      if (btnDelete)  btnDelete.hidden     = true;
      if (btnSave)    btnSave.textContent  = "Dodaj";

      // Always reload user settings before showing dialog
      const { proxEnabled, alarmEnabled, proxKm, alarmMin } = await reloadUserSettings();

      if (inputUpozorenje)    inputUpozorenje.checked    = proxEnabled;
      if (inputUpozorjenjeKm) inputUpozorjenjeKm.value   = proxKm;
      if (inputTajmer)    inputTajmer.checked    = alarmEnabled;
      if (inputTajmerMin) inputTajmerMin.value   = alarmEnabled ? alarmMin : "";
      if (inputAlarm)     inputAlarm.checked     = false;
      _syncUpozorenjeVis(); _syncTajmerVis();
      selectedPinType = "utovar";
      selectedColor = "#6b7280";
      loadVehiclesForPicker(null);
      refreshTypePicker(selectedPinType, selectedColor);
      pinsDialog?.showModal();
    }

    async function openEditDialog(pinId) {
      const entry = activePins.get(pinId);
      if (!entry || !pinsDialog) return;
      // Always reload user settings before showing dialog
      await reloadUserSettings();
      const d = entry.data;
      dialogMode    = "edit";
      editingPinId  = pinId;
      pendingLatLng = null;
      if (dlgTitle)   dlgTitle.textContent = "Uredi pin";
      if (inputLabel) inputLabel.value     = d.label       || "";
      if (inputNote)  inputNote.value      = d.note        || "";
      if (inputFrom)  inputFrom.value      = d.visibleFrom || todayStr();
      if (inputTo)    inputTo.value        = d.visibleTo   || todayStr();
      // Ako je period tačno jedna nedelja, selektuj nedelju, inače prazno
      let weekFrom = d.visibleFrom;
      let weekTo = d.visibleTo;
      let weekLen = 0;
      if (weekFrom && weekTo) {
        const dtFrom = new Date(weekFrom);
        const dtTo = new Date(weekTo);
        weekLen = Math.round((dtTo - dtFrom) / 86400000) + 1;
      }
      if (weekFrom && weekTo && weekLen === 7) {
        populateWeekSelect(weekFrom);
      } else {
        populateWeekSelect("");
      }
      if (btnDelete)  btnDelete.hidden     = false;
      if (btnSave)    btnSave.textContent  = "Sačuvaj";
      if (inputUpozorenje)    inputUpozorenje.checked    = !!d.upozorenje;
      if (inputUpozorjenjeKm) inputUpozorjenjeKm.value   = d.upozorenjekm ?? defaultProximityKm;
      if (inputAlarm)     inputAlarm.checked     = !!d.alarm;
      if (inputTajmer)    inputTajmer.checked    = !!d.tajmer;
      if (inputTajmerMin) inputTajmerMin.value   = d.tajmer ? (d.tajmermin ?? defaultTajmerMin) : "";
      _syncUpozorenjeVis(); _syncTajmerVis();
      selectedPinType = d.pinType || "utovar";
      selectedColor = d.color || "#6b7280";
      loadVehiclesForPicker(d.vehicleId || null);
      refreshTypePicker(selectedPinType, selectedColor);
      pinsDialog.showModal();
    }

    function closeDialog() {
      pinsDialog?.close();
      dialogMode    = "add";
      editingPinId  = null;
      pendingLatLng = null;
    }

    if (dlgClose)   dlgClose.addEventListener("click", closeDialog);
    if (pinsDialog) pinsDialog.addEventListener("click", (e) => { if (e.target === pinsDialog) closeDialog(); });

    // ── Firebase ──────────────────────────────────────────────────────────────

    function getDb() { return global.db || null; }

    function generatePinId() {
      return `pin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }

    function fbSet(pinId, data) {
      const db = getDb();
      if (!db) return Promise.reject(new Error("Firebase nije dostupan"));
      return db.ref(`pins/${pinId}`).set(data);
    }

    function fbPatch(pinId, patch) {
      const db = getDb();
      if (!db) return Promise.reject(new Error("Firebase nije dostupan"));
      return db.ref(`pins/${pinId}`).update(patch);
    }

    // ── Tooltip helpers ───────────────────────────────────────────────────────

    // Zoom tiers: >=9 full (label+note), 7-8 label only, <=6 hidden
    const TIP_ZOOM_FULL   = 9;
    const TIP_ZOOM_LABEL  = 7;

    function buildTooltipContent(data, labelOnly) {
      const lbl  = String(data.label || "").trim();
      const note = String(data.note  || "").trim();
      if (!lbl && !note) return null;
      let html = "";
      if (lbl)  html += `<div class="pin-tip-label">${lbl.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}</div>`;
      if (note && !labelOnly) {
        const safeNote = note
          .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/\n/g, "<br>");
        html += `<div class="pin-tip-note">${safeNote}</div>`;
      }
      return html || null;
    }

    function chooseTipDirection(latlng) { // kept for potential external use
      return "right";
    }

    function recomputeAllTooltips() {
      const zoom = map.getZoom();
      const labelOnly = zoom < TIP_ZOOM_FULL;

      if (zoom < TIP_ZOOM_LABEL) {
        activePins.forEach(({ marker }) => {
          if (marker.getTooltip()) marker.unbindTooltip();
        });
        return;
      }

      const GAP = 17;
      const TW  = 96; // estimated tooltip width
      const TH  = 26; // estimated tooltip height
      const DIRS    = ["right", "top", "left", "bottom"];
      const BASE_OFFSETS = {
        right:  [ GAP,  0],
        top:    [   0, -GAP],
        left:   [-GAP,  0],
        bottom: [   0,  GAP]
      };

      // Compute horizontal offset for right/left directions.
      // Tooltip arrow must clear the pill rect, not just the SVG square.
      // offset[0] = pillWidth/2 + GAP_AFTER_PILL (pill is centered on anchor)
      const GAP_AFTER = -3; // px gap between pill edge and tooltip arrow
      function hOffset(data) {
        if (!data.vehicleLabel || data.vehicleLabel.length <= 2) {
          // No pill: tooltip just clears the SVG square
          const t = PIN_SIZES[getPinTier()];
          const scale = window.markerSizeScale || 1;
          return Math.round(t.size * scale / 2) + GAP_AFTER;
        }
        const t = PIN_SIZES[getPinTier()];
        const scale = window.markerSizeScale || 1;
        const scaledSize = Math.round(t.size * scale);
        const txtPx = Math.round(13 * scaledSize / 32);
        const paddingH = Math.round(txtPx * 0.25);
        // Bold uppercase character width ≈ 0.75× font size
        const pillW = data.vehicleLabel.length * txtPx * 0.75 + 2 * paddingH;
        return Math.round(Math.max(scaledSize, pillW) / 2) + GAP_AFTER;
      }

      function pinOffsets(data) {
        const ho = hOffset(data);
        return {
          right:  [ ho,  0],
          top:    [  0, -GAP],
          left:   [-ho,  0],
          bottom: [  0,  GAP]
        };
      }

      // First unbind tooltips from hidden/filtered-out pins
      activePins.forEach(({ data, marker, tipHidden }) => {
        if (tipHidden || !isPinInRange(data)) {
          if (marker.getTooltip()) marker.unbindTooltip();
        }
      });

      // Only consider visible (in-range) pins for slot assignment
      const pins = [...activePins.values()]
        .filter(e => isPinInRange(e.data) && !e.tipHidden)
        .sort(
        (a, b) => b.data.lat - a.data.lat || a.data.lng - b.data.lng
      );

      const assigned = []; // { tx, ty } tooltip anchor points already taken

      pins.forEach(({ data, marker }) => {
        const content = buildTooltipContent(data, labelOnly);
        if (!content) {
          if (marker.getTooltip()) marker.unbindTooltip();
          return;
        }

        const offsets = pinOffsets(data);
        const pt = map.latLngToContainerPoint([data.lat, data.lng]);
        let chosenDir = DIRS[0];
        let minCollisions = Infinity;

        for (const dir of DIRS) {
          const [ox, oy] = offsets[dir];
          const tx = pt.x + ox;
          const ty = pt.y + oy;
          let collisions = 0;
          for (const slot of assigned) {
            if (Math.abs(tx - slot.tx) < TW && Math.abs(ty - slot.ty) < TH) collisions++;
          }
          if (collisions === 0) { chosenDir = dir; break; }
          if (collisions < minCollisions) { minCollisions = collisions; chosenDir = dir; }
        }

        const chosenOffset = offsets[chosenDir];
        assigned.push({ tx: pt.x + chosenOffset[0], ty: pt.y + chosenOffset[1] });

        const existing = marker.getTooltip();
        const sameConfig = existing
          && existing.options.direction === chosenDir
          && existing.options.offset[0] === chosenOffset[0]
          && existing.options.offset[1] === chosenOffset[1];
        if (sameConfig) {
          marker.setTooltipContent(content);
        } else {
          if (existing) marker.unbindTooltip();
          marker.bindTooltip(content, {
            permanent: true,
            direction: chosenDir,
            offset: chosenOffset,
            opacity: 1,
            className: "pin-tooltip"
          });
        }
      });
    }

    // ── Marker rendering ──────────────────────────────────────────────────────

    function renderPinMarker(pinData) {
      // Ako marker za ovaj pin već postoji, preskoči
      if (activePins.has(pinData.id)) return;
      const marker = L.marker([pinData.lat, pinData.lng], {
        icon: createPinIcon(pinData.shape, pinData.color, pinData.vehicleLabel || ""),
        keyboard: false,
        draggable: true,
        zIndexOffset: 500
      });

      function buildTooltipContent(data) {
        const lbl  = String(data.label || "").trim();
        const note = String(data.note  || "").trim();
        if (!lbl && !note) return null;
        const safeNote = note
          .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/\n/g, "<br>");
        let html = "";
        if (lbl)  html += `<div class="pin-tip-label">${lbl.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}</div>`;
        if (note) html += `<div class="pin-tip-note">${safeNote}</div>`;
        return html;
      }

      marker._buildPinTooltip = buildTooltipContent;

      marker.on("dragend", async () => {
        const pos = marker.getLatLng();
        const patch = { lat: pos.lat, lng: pos.lng };
        try {
          await fbPatch(pinData.id, patch);
          pinData.lat = pos.lat;
          pinData.lng = pos.lng;
        } catch (err) {
          console.error("[Pins] Greška pri pomeranju pina:", err.message);
          marker.setLatLng([pinData.lat, pinData.lng]);
        }
      });

      marker.on("contextmenu", (e) => {
        L.DomEvent.stopPropagation(e);
        e.originalEvent?.preventDefault();
        openEditDialog(pinData.id);
      });

      marker.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        const entry = activePins.get(pinData.id);
        if (!entry) return;
        entry.tipHidden = !entry.tipHidden;
        // Reorder within vehicle group
        const vid = (entry.data.vehicleId || "").toLowerCase();
        const group = [...activePins.values()]
          .filter(e => isPinInRange(e.data) && (e.data.vehicleId || "").toLowerCase() === vid)
          .sort((a, b) => a.listOrder - b.listOrder);
        const visible = group.filter(e => !e.tipHidden);
        const hidden  = group.filter(e =>  e.tipHidden);
        if (entry.tipHidden) {
          // hidden → goes to top of hidden section (just below all active)
          const otherHidden = hidden.filter(e => e.data.id !== pinData.id);
          [...visible, entry, ...otherHidden].forEach((e, i) => { e.listOrder = i; });
        } else {
          // shown → goes to bottom of active section (just above hidden)
          const otherVisible = visible.filter(e => e.data.id !== pinData.id);
          [...otherVisible, entry, ...hidden].forEach((e, i) => { e.listOrder = i; });
        }
        marker.setOpacity(entry.tipHidden ? 0.6 : 1);
        const iconColor = entry.tipHidden ? darkenColor(pinData.color) : (pinData.color || "#6b7280");
        marker.setIcon(createPinIcon(pinData.shape, iconColor, pinData.vehicleLabel || ""));
        fbPatch(pinData.id, { tipHidden: entry.tipHidden }).catch(() => {});
        if (entry.tipHidden) {
          // Stop both pulse types when textbox is hidden
          if (_pulsingPins.has(pinData.id)) {
            _pulsingPins.delete(pinData.id);
            _pulseStartTime.delete(pinData.id);
            if (marker._icon) marker._icon.classList.remove("pin-prox-pulse");
          }
          if (_stalePulsingPins.has(pinData.id)) {
            _stalePulsingPins.delete(pinData.id);
            _stalePulseStart.delete(pinData.id);
            if (marker._icon) marker._icon.classList.remove("pin-stale-pulse");
          }
        }
        recomputeAllTooltips();
        refreshPinsList();
      });

      marker.addTo(pinsLayer);
      const initTipHidden = pinData.tipHidden === true;
      activePins.set(pinData.id, { data: pinData, marker, tipHidden: initTipHidden, listOrder: pinData.sortOrder ?? 0 });
      if (initTipHidden) {
        marker.setOpacity(0.6);
        marker.setIcon(createPinIcon(pinData.shape, darkenColor(pinData.color), pinData.vehicleLabel || ""));
      }
      // Hide immediately if out of current filter range
      if (!isPinInRange(pinData)) pinsLayer.removeLayer(marker);
    }

    function removeFromMap(pinId) {
      const entry = activePins.get(pinId);
      if (!entry) return;
      entry.marker.remove();
      activePins.delete(pinId);
    }

    // ── Save ──────────────────────────────────────────────────────────────────

    function collectForm() {
      const vehicleId = selectedVehicleId || null;
      return {
        label:        (inputLabel?.value || "").trim().slice(0, 80),
        note:         (inputNote?.value  || "").trim().slice(0, 200),
        visibleFrom:  inputFrom?.value  || todayStr(),
        visibleTo:    inputTo?.value    || todayStr(),
        pinType:      selectedPinType,
        shape:        getShapeForType(selectedPinType),
        color:        vehicleId ? selectedColor : "#6b7280",
        vehicleId:    vehicleId || null,
        vehicleLabel: vehicleId ? (vehicleLabelMap[vehicleId] || "") : "",
        upozorenje:    !!(inputUpozorenje?.checked),
        upozorenjekm:  parseInt(inputUpozorjenjeKm?.value, 10) || defaultProximityKm,
        alarm:         !!(inputAlarm?.checked),
        tajmer:        !!(inputTajmer?.checked),
        tajmermin:     parseInt(inputTajmerMin?.value, 10) || defaultTajmerMin
      };
    }

    if (btnSave) {
      btnSave.addEventListener("click", async () => {
        btnSave.disabled = true;
        try {
          const form = collectForm();

          if (dialogMode === "add" && pendingLatLng) {
            const pinId   = generatePinId();
            const nowIso = new Date().toISOString();
            const pinData = {
              id:         pinId,
              createdAt:  nowIso,
              tajmerStart: form.tajmer ? nowIso : null,
              lat:        pendingLatLng.lat,
              lng:        pendingLatLng.lng,
              deletedAt:  null,
              ...form
            };
            await fbSet(pinId, pinData);
            renderPinMarker(pinData);
            recomputeAllTooltips();
            refreshPinsList();
            closeDialog();

          } else if (dialogMode === "edit" && editingPinId) {
            // If timer is being enabled now, or already enabled, set tajmerStart accordingly
            const entry = activePins.get(editingPinId);
            let patch = { ...form };
            if (entry) {
              const wasTajmer = !!entry.data.tajmer;
              const nowTajmer = !!form.tajmer;
              if (nowTajmer && !wasTajmer) {
                // Timer is being enabled now, set tajmerStart
                patch.tajmerStart = new Date().toISOString();
                entry.data.tajmerStart = patch.tajmerStart;
              } else if (nowTajmer && wasTajmer) {
                // Timer remains enabled, keep previous tajmerStart
                patch.tajmerStart = entry.data.tajmerStart || new Date().toISOString();
              } else {
                // Timer is disabled, clear tajmerStart
                patch.tajmerStart = null;
                entry.data.tajmerStart = null;
              }
              Object.assign(entry.data, form);
              entry.marker.setIcon(createPinIcon(form.shape, form.color, form.vehicleLabel || ""));
              recomputeAllTooltips();
              refreshPinsList();
            }
            await fbPatch(editingPinId, patch);
            closeDialog();
          }
        } catch (err) {
          console.error("[Pins] Greška pri čuvanju:", err.message);
          alert("Greška pri čuvanju: " + err.message);
        } finally {
          btnSave.disabled = false;
        }
      });
    }

    // ── Soft delete ───────────────────────────────────────────────────────────

    if (btnDelete) {
      btnDelete.addEventListener("click", async () => {
        if (!editingPinId) return;
        if (!confirm("Obrisati pin?\nPin ostaje u bazi podataka i može se pregledati tamo.")) return;
        btnDelete.disabled = true;
        try {
          await fbPatch(editingPinId, { deletedAt: new Date().toISOString() });
          removeFromMap(editingPinId);
          refreshPinsList();
          closeDialog();
        } catch (err) {
          console.error("[Pins] Greška pri brisanju:", err.message);
          alert("Greška pri brisanju: " + err.message);
        } finally {
          btnDelete.disabled = false;
        }
      });
    }

    // ── Map right-click → add ─────────────────────────────────────────────────

    map.on("contextmenu", (event) => {
      event.originalEvent?.preventDefault();
      openAddDialog(event.latlng);
    });

    // ── Load from Firebase ────────────────────────────────────────────────────

    /**
     * Učitava pinove iz Firebase-a filtrirane po datumu (visibleFrom/visibleTo) i ograničava na 150.
     * @param {string} from - Početni datum (YYYY-MM-DD)
     * @param {string} to - Krajnji datum (YYYY-MM-DD)
     */
    async function loadPins(from, to) {
      const db = getDb();
      if (!db) {
        console.warn("[Pins] Firebase nije dostupan pri učitavanju pinova.");
        return;
      }
      try {
        // Prvo: po visibleFrom
        let query = db.ref("pins").orderByChild("visibleFrom");
        if (from) query = query.startAt(from);
        if (to) query = query.endAt(to);
        query = query.limitToFirst(150);
        const snapshot = await query.once("value");
        let pins = snapshot.val() || {};
        // Drugo: dodatni filter po visibleTo (jer Firebase query može filtrirati samo po jednom polju)
        pins = Object.values(pins).filter(pin => {
          if (!pin || pin.deletedAt || !pin.lat || !pin.lng) return false;
          // Pin je u opsegu ako mu se period preklapa sa filterom
          const pFrom = pin.visibleFrom || "0000-00-00";
          const pTo   = pin.visibleTo   || "9999-99-99";
          const f = from || "0000-00-00";
          const t = to   || "9999-99-99";
          return pFrom <= t && pTo >= f;
        });
        let count = 0;
        pins.forEach((pin) => {
          renderPinMarker(pin);
          count++;
        });
        recomputeAllTooltips();
        refreshPinsList();
        console.log(`[Pins] Učitano ${count} filtriranih pinova.`);
      } catch (err) {
        console.error("[Pins] Greška pri učitavanju:", err.message);
      }
    }
    // ── Zoom resize listener ──────────────────────────────────────────────────
    let _lastPinTier = -1;
    map.on("zoomend", () => {
      const tier = getPinTier();
      const tierChanged = tier !== _lastPinTier;
      if (tierChanged) {
        _lastPinTier = tier;
        activePins.forEach(({ data, marker, tipHidden }) => {
          const iconColor = tipHidden ? darkenColor(data.color) : (data.color || "#6b7280");
          marker.setIcon(createPinIcon(data.shape, iconColor, data.vehicleLabel || ""));
          _reapplyPulse(marker, data.id);
        });
      }
      recomputeAllTooltips();
    });

    // ── INIT: učitaj pinove na startu i na promenu filtera ───────────────
    // Prvo učitavanje pinova
    (async function initialLoad() {
      await loadPins(_filterFrom, _filterTo);
    })();

    // Ako postoji UI za promenu filtera, zakači event da pozove applyDateFilter
    if (inputFrom && inputTo) {
      inputFrom.addEventListener("change", () => applyDateFilter(inputFrom.value, inputTo.value));
      inputTo.addEventListener("change", () => applyDateFilter(inputFrom.value, inputTo.value));
    }
    if (inputWeekSelect) {
      inputWeekSelect.addEventListener("change", () => {
        const sel = inputWeekSelect.options[inputWeekSelect.selectedIndex];
        applyDateFilter(sel.dataset.from, sel.dataset.to);
      });
    }
    // ── Public helpers for external refresh ──────────────────────────────────

    const _pulsingPins = new Set();        // pinIds currently pulsing
    const _pulseStartTime = new Map();    // pinId → Date.now() when pulse began

    function _reapplyPulse(marker, pinId) {
      if (_pulsingPins.has(pinId) && marker._icon) {
        const elapsed = Date.now() - (_pulseStartTime.get(pinId) || Date.now());
        const delay   = -(elapsed % 3000);
        marker._icon.style.setProperty('--pulse-delay', delay + 'ms');
        marker._icon.classList.add("pin-prox-pulse");
      }
    }

    function pulsePin(pinId) {
      _pulsingPins.add(pinId);
      _pulseStartTime.set(pinId, Date.now());
      const entry = activePins.get(pinId);
      if (entry && entry.marker._icon) {
        entry.marker._icon.style.setProperty('--pulse-delay', '0ms');
        entry.marker._icon.classList.add("pin-prox-pulse");
      }
      // Also pulse the list item
      const listItem = document.querySelector(`.pins-list-item[data-pin-id="${pinId}"]`);
      if (listItem) {
        listItem.style.setProperty('--pulse-delay', '0ms');
        listItem.classList.add('pin-prox-pulse');
      }
      // Stop after 1 hour
      setTimeout(() => {
        _pulsingPins.delete(pinId);
        _pulseStartTime.delete(pinId);
        const e = activePins.get(pinId);
        if (e && e.marker._icon) e.marker._icon.classList.remove("pin-prox-pulse");
        const li = document.querySelector(`.pins-list-item[data-pin-id="${pinId}"]`);
        if (li) li.classList.remove('pin-prox-pulse');
      }, 3_600_000);
    }

    // ── Stale-pin pulse (white ↔ red) ─────────────────────────────────────────
    const _stalePulsingPins  = new Set();
    const _stalePulseStart   = new Map();

    function _reapplyStalePulse(marker, pinId) {
      if (_stalePulsingPins.has(pinId) && marker._icon) {
        const elapsed = Date.now() - (_stalePulseStart.get(pinId) || Date.now());
        const delay   = -(elapsed % 3000);
        marker._icon.style.setProperty('--pulse-delay', delay + 'ms');
        marker._icon.classList.add("pin-stale-pulse");
      }
    }

    function pulseStalePin(pinId) {
      _stalePulsingPins.add(pinId);
      _stalePulseStart.set(pinId, Date.now());
      const entry = activePins.get(pinId);
      if (entry && entry.marker._icon) {
        entry.marker._icon.style.setProperty('--pulse-delay', '0ms');
        entry.marker._icon.classList.add("pin-stale-pulse");
      }
      const listItem = document.querySelector(`.pins-list-item[data-pin-id="${pinId}"]`);
      if (listItem) {
        listItem.style.setProperty('--pulse-delay', '0ms');
        listItem.classList.add('pin-stale-pulse');
      }
    }

    function stopStalePin(pinId) {
      _stalePulsingPins.delete(pinId);
      _stalePulseStart.delete(pinId);
      const entry = activePins.get(pinId);
      if (entry && entry.marker._icon) entry.marker._icon.classList.remove("pin-stale-pulse");
      const li = document.querySelector(`.pins-list-item[data-pin-id="${pinId}"]`);
      if (li) li.classList.remove('pin-stale-pulse');
    }

    function refreshAllPins() {
      activePins.forEach(({ data, marker, tipHidden }) => {
        if (data.pinType) data.shape = getShapeForType(data.pinType);
        const iconColor = tipHidden ? darkenColor(data.color) : (data.color || "#6b7280");
        marker.setIcon(createPinIcon(data.shape, iconColor, data.vehicleLabel || ""));
        _reapplyPulse(marker, data.id);
        _reapplyStalePulse(marker, data.id);
      });
    }

    function updateVehicleCache(vehicleId, color, label) {      if (!vehicleId) return;
      if (color !== undefined) vehicleColorMap[vehicleId] = color;
      if (label !== undefined) vehicleLabelMap[vehicleId] = label;
      // Update all pins referencing this vehicle
      activePins.forEach(({ data, marker, tipHidden }) => {
        if (data.vehicleId !== vehicleId) return;
        if (color !== undefined) data.color = color;
        if (label !== undefined) data.vehicleLabel = label;
        if (data.pinType) data.shape = getShapeForType(data.pinType);
        const iconColor = tipHidden ? darkenColor(data.color) : (data.color || "#6b7280");
        marker.setIcon(createPinIcon(data.shape, iconColor, data.vehicleLabel || ""));
        _reapplyPulse(marker, data.id);
      });
      refreshPinsList();
    }

    // ── Pins list panel ───────────────────────────────────────────────────────

    // Helper: set panel width to minimal needed for all data
    async function setPinsListPanelToAutoWidth() {
      const panel = document.getElementById("pins-list-panel");
      const content = document.getElementById("pins-list-content");
      let minWidth = 120;
      if (panel && content) {
        // Wait for layout
        await new Promise(r => setTimeout(r, 0));
        // Pronađi najdesniji .pli-note u svim redovima
        let right = 0;
        const notes = content.querySelectorAll(".pli-note");
        notes.forEach(note => {
          const rect = note.getBoundingClientRect();
          if (rect.right > right) right = rect.right;
        });
        if (right > 0) {
          const panelLeft = panel.getBoundingClientRect().left;
          minWidth = Math.max(120, Math.ceil(right - panelLeft) - 25 + 8); // 8px padding, 25px prikrivanje
        }
        panel.style.width = minWidth + "px";
        panel._userResized = true;
      }
      return minWidth;
    }

    function refreshPinsList() {
      const panel   = document.getElementById("pins-list-panel");
      const content = document.getElementById("pins-list-content");
      if (!panel || !content) return;

      // Init resize handle once
      if (!panel.querySelector(".pli-resize-handle")) {
        const handle = document.createElement("div");
        handle.className = "pli-resize-handle";
        panel.appendChild(handle);
        let startX, startW;
        handle.addEventListener("mousedown", e => {
          startX = e.clientX;
          startW = panel.offsetWidth;
          handle.classList.add("dragging");
          e.preventDefault();
          function onMove(ev) {
            const newWidth = Math.max(120, startW + ev.clientX - startX);
            panel.style.width = newWidth + "px";
            panel._userResized = true;
            // Save width to Firebase userSettings
            const db = getDb();
            const _uid = window.currentUid;
            if (db && _uid) {
              db.ref(`userSettings/${_uid}/pinsListWidth`).set(newWidth).catch(() => {});
            }
          }
          function onUp() {
            handle.classList.remove("dragging");
            document.removeEventListener("mousemove", onMove);
          }
          document.addEventListener("mousemove", onMove);
          document.addEventListener("mouseup", onUp, { once: true });
        });

        // Double click resets width to default
        handle.addEventListener("dblclick", async (e) => {
          const minWidth = await setPinsListPanelToAutoWidth();
          // Save this width to Firebase userSettings
          const db = getDb();
          const _uid = window.currentUid;
          if (db && _uid) {
            try { await db.ref(`userSettings/${_uid}/pinsListWidth`).set(minWidth); } catch (e) {}
          }
        });
      }
    // On app start, load pins list width from Firebase userSettings
    (async function loadPinsListWidth() {
      const panel = document.getElementById("pins-list-panel");
      const db = getDb && getDb();
      const _uid = window.currentUid;
      if (panel && db && _uid) {
        try {
          const snap = await db.ref(`userSettings/${_uid}/pinsListWidth`).once("value");
          const w = snap.val();
          if (w && !isNaN(w)) {
            panel.style.width = w + "px";
            panel._userResized = true;
          } else {
            // Nema podešene širine, koristi helper
            await setPinsListPanelToAutoWidth();
          }
        } catch (e) {}
      }
    })();

      // Click delegation (once)
      if (!content._hoverInited) {
        content._hoverInited = true;
        content.addEventListener("click", e => {
          const item = e.target.closest(".pins-list-item");
          if (!item) return;
          const entry = activePins.get(item.dataset.pinId);
          if (entry) map.flyTo([entry.data.lat, entry.data.lng], Math.max(map.getZoom(), 10), { duration: 0.5 });
        });
      }

      function miniPinSvg(shape, color, label) {
        const c = String(color || "#6b7280");
        const gid = `ml${Math.random().toString(36).slice(2, 6)}`;
        const lbl = String(label || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        // Use mapped scale for pin list
        const markerScale = window.markerSizeScale || 1;
        const pinListScale = markerScaleToPinListScale(markerScale);
        // Default SVG size is 32, scale accordingly
        const baseSize = 30;
        const svgSize = Math.round(baseSize * pinListScale);
        const txtPx = Math.round(13 * pinListScale);
        const txt = lbl ? `<text x="16" y="16" text-anchor="middle" dominant-baseline="central" font-family="sans-serif" font-size="${txtPx}" font-weight="bold" fill="#fff" stroke="#000" stroke-width="1.2" paint-order="stroke" pointer-events="none">${lbl}</text>` : "";
        const defs = `<defs><linearGradient id="${gid}" x1="0%" y1="0%" x2="100%" y2="100%">`
          + `<stop offset="0%" stop-color="#fff" stop-opacity="0.52"/>`
          + `<stop offset="45%" stop-color="#fff" stop-opacity="0.08"/>`
          + `<stop offset="100%" stop-color="#000" stop-opacity="0.32"/>`
          + `</linearGradient></defs>`;
        if (shape === "circle") return `<svg viewBox="0 0 32 32" width="${svgSize}" height="${svgSize}" aria-hidden="true">${defs}`
          + `<g class="pin-shape-layer"><circle cx="16" cy="16" r="12" fill="#000"/><circle cx="16" cy="16" r="11" fill="#fff"/><circle cx="16" cy="16" r="9" fill="#000"/></g>`
          + `<circle cx="16" cy="16" r="8" fill="${c}"/><circle cx="16" cy="16" r="8" fill="url(#${gid})"/>${txt}</svg>`;
        if (shape === "diamond") return `<svg viewBox="0 0 32 32" width="${svgSize}" height="${svgSize}" aria-hidden="true">${defs}`
          + `<g class="pin-shape-layer"><path d="M16 -1 L33 16 L16 33 L-1 16 Z" fill="#000"/><path d="M16 0.4 L31.6 16 L16 31.6 L0.4 16 Z" fill="#fff"/><path d="M16 3.3 L28.7 16 L16 28.7 L3.3 16 Z" fill="#000"/></g>`
          + `<path d="M16 4.7 L27.3 16 L16 27.3 L4.7 16 Z" fill="${c}"/><path d="M16 4.7 L27.3 16 L16 27.3 L4.7 16 Z" fill="url(#${gid})"/>${txt}</svg>`;
        return `<svg viewBox="0 0 32 32" width="${svgSize}" height="${svgSize}" aria-hidden="true">${defs}`
          + `<g class="pin-shape-layer"><rect x="4" y="4" width="24" height="24" fill="#000"/><rect x="5" y="5" width="22" height="22" fill="#fff"/><rect x="7" y="7" width="18" height="18" fill="#000"/></g>`
          + `<rect x="8" y="8" width="16" height="16" fill="${c}"/><rect x="8" y="8" width="16" height="16" fill="url(#${gid})"/>${txt}</svg>`;
      }

      const visibleArr = [...activePins.values()].filter(e => isPinInRange(e.data));
      const visible = visibleArr.sort((a, b) => {
          const va = (a.data.vehicleId || "").toLowerCase();
          const vb = (b.data.vehicleId || "").toLowerCase();
          if (va !== vb) return va < vb ? -1 : 1;
          if (a.listOrder !== b.listOrder) return a.listOrder - b.listOrder;
          const la = (a.data.label || "").toLowerCase();
          const lb = (b.data.label || "").toLowerCase();
          return la < lb ? -1 : la > lb ? 1 : 0;
        });

      if (visible.length === 0) {
        content.innerHTML = `<div class="pins-list-empty" style="grid-column:1/-1">Nema vidljivih pinova</div>`;
        return;
      }

      // Set pin list scale CSS variable
      const markerScale = window.markerSizeScale || 1;
      const pinListScale = markerScaleToPinListScale(markerScale);
      panel.style.setProperty('--pinlist-scale', pinListScale);

      content.innerHTML = visible.map(e => {
        const d = e.data;
        const esc = s => String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
        const col   = d.color || "#6b7280";
        const shape = d.shape || "square";
        const lbl   = esc(d.label) || "—";
        const note  = esc(String(d.note || "").replace(/\r?\n/g, " "));
        const veh   = esc(d.vehicleLabel);
        const from  = esc(d.visibleFrom || "");
        const to    = esc(d.visibleTo   || "");
        const dates = from || to ? (from || "—") + " – " + (to || "—") : "";
        return `<div class="pins-list-item${e.tipHidden ? " pli-faded" : ""}" data-pin-id="${d.id}">`
          + `<span class="pli-icon">${miniPinSvg(shape, col, "")}</span>`
          + `<span class="pli-vehicle">${veh}</span>`
          + `<span class="pli-label">${lbl}</span>`
          + `<span class="pli-note">${note}</span>`
          + `<span class="pli-dates">${dates}</span>`
          + `<span class="pli-handle" title="Prevuci za promenu redosleda">⠿</span>`
          + `</div>`;
      }).join("");

      // Re-apply pulse class to list items for currently pulsing pins
      if (_pulsingPins.size > 0) {
        _pulsingPins.forEach(pid => {
          const item = content.querySelector(`.pins-list-item[data-pin-id="${pid}"]`);
          if (item) {
            const elapsed = Date.now() - (_pulseStartTime.get(pid) || Date.now());
            item.style.setProperty('--pulse-delay', -(elapsed % 3000) + 'ms');
            item.classList.add('pin-prox-pulse');
          }
        });
      }

      // Re-apply stale-pulse class to list items
      if (_stalePulsingPins.size > 0) {
        _stalePulsingPins.forEach(pid => {
          const item = content.querySelector(`.pins-list-item[data-pin-id="${pid}"]`);
          if (item) {
            const elapsed = Date.now() - (_stalePulseStart.get(pid) || Date.now());
            item.style.setProperty('--pulse-delay', -(elapsed % 3000) + 'ms');
            item.classList.add('pin-stale-pulse');
          }
        });
      }

      // ── Drag-to-reorder ──────────────────────────────────────────────────────

      // Auto-fit width to icon+label+vehicle+note (hide dates) unless user resized
      if (!panel._userResized) {
        panel.style.width = "max-content";
        requestAnimationFrame(() => {
          const lastNote = content.querySelector(".pli-note");
          if (lastNote) {
            const panelLeft = panel.getBoundingClientRect().left;
            const noteRight = lastNote.getBoundingClientRect().right;
            const rightPad  = -15;
            panel.style.width = Math.max(120, noteRight - panelLeft + rightPad) + "px";
          } else {
            panel.style.width = "";
          }
        });
      }

      // ── Drag-to-reorder ──────────────────────────────────────────────────────
      content.querySelectorAll(".pli-handle").forEach(handle => {
        handle.addEventListener("pointerdown", e => {
          const row = handle.parentElement;
          if (!row || !row.dataset.pinId) return;
          const dragPinId = row.dataset.pinId;
          handle.setPointerCapture(e.pointerId);
          row.classList.add("pli-dragging");
          e.preventDefault();
          e.stopPropagation();

          let marker = document.getElementById("pli-drop-marker");
          if (!marker) {
            marker = document.createElement("div");
            marker.id = "pli-drop-marker";
            marker.className = "pli-drop-marker";
            panel.appendChild(marker);
          }

          let dropPinId = null;
          let dropBelow = false;

          function onMove(ev) {
            const rows = [...content.querySelectorAll("[data-pin-id]")].filter(r => r !== row);
            let closest = null, closestDist = Infinity;
            rows.forEach(r => {
              const rect = r.getBoundingClientRect();
              const midY = rect.top + rect.height / 2;
              const dist = Math.abs(ev.clientY - midY);
              if (dist < closestDist) { closestDist = dist; closest = r; dropBelow = ev.clientY > midY; }
            });
            if (closest) {
              dropPinId = closest.dataset.pinId;
              const rect = closest.getBoundingClientRect();
              const panelRect = panel.getBoundingClientRect();
              marker.style.top = (dropBelow ? rect.bottom : rect.top) - panelRect.top + panel.scrollTop + "px";
              marker.style.display = "block";
            } else {
              dropPinId = null;
              marker.style.display = "none";
            }
          }

          function onUp() {
            handle.removeEventListener("pointermove", onMove);
            row.classList.remove("pli-dragging");
            marker.style.display = "none";

            if (!dropPinId || dropPinId === dragPinId) return;

            const ids      = visible.map(ev => ev.data.id);
            const fromIdx  = ids.indexOf(dragPinId);
            const toIdx    = ids.indexOf(dropPinId);
            if (fromIdx === -1 || toIdx === -1) return;

            ids.splice(fromIdx, 1);
            const newTo = ids.indexOf(dropPinId);
            ids.splice(dropBelow ? newTo + 1 : newTo, 0, dragPinId);

            const vehicleId = activePins.get(dragPinId)?.data.vehicleId || "";
            const groupIds  = ids.filter(id => (activePins.get(id)?.data.vehicleId || "") === vehicleId);

            const db = getDb();
            groupIds.forEach((id, idx) => {
              const entry = activePins.get(id);
              if (entry) { entry.data.sortOrder = idx; entry.listOrder = idx; }
              if (db) db.ref(`pins/${id}/sortOrder`).set(idx).catch(() => {});
            });

            refreshPinsList();
          }

          handle.addEventListener("pointermove", onMove);
          handle.addEventListener("pointerup", onUp, { once: true });
        });
      });
    }

    return { loadPins, loadPinTypeShapes, refreshSettings: initSettingsSection, refreshAllPins, refreshPinsList, updateVehicleCache, setDateFilter: applyDateFilter, pulsePin, pulseStalePin, stopStalePin, getActivePins: () => activePins };
  }

  global.initPins = initPins;
})(window);
