"use strict";

(function (global) {

  // ── Audio unlock (browser autoplay policy requires prior user gesture) ─────
  let _audioCtx = null;
  let _audioUnlocked = false;

  function _ensureAudioCtx() {
    if (!_audioCtx && _audioUnlocked) {
      _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return _audioCtx;
  }

  function _unlockAudio() {
    if (_audioUnlocked) return;
    _audioUnlocked = true;
    try {
      if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (_audioCtx.state === "suspended") _audioCtx.resume();
    } catch (_) {}
  }

  // Unlock on first user interaction
  ["click", "touchstart", "keydown", "pointerdown"].forEach(ev =>
    document.addEventListener(ev, _unlockAudio, { once: false, passive: true })
  );

  async function _playSound(url) {
    try {
      const ctx = _ensureAudioCtx();
      if (!ctx) { await new Audio(url).play(); return; }
      if (ctx.state === "suspended") await ctx.resume();
      const res = await fetch(url);
      const buf = await res.arrayBuffer();
      const decoded = await ctx.decodeAudioData(buf);
      const src = ctx.createBufferSource();
      src.buffer = decoded;
      src.connect(ctx.destination);
      // Return a Promise that resolves when playback ends
      return new Promise(resolve => {
        src.onended = resolve;
        src.start(0);
      });
    } catch (_) {
      try { await new Audio(url).play(); } catch (__) {}
    }
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let _pinsCache    = {};        // pinId → pin data (live Firebase subscription)
  let _fbRef        = null;      // Firebase ref for .off()
  let _proxInterval  = null;
  let _staleInterval = null;
  let _checkInterval = null;
  let _checkAlignTimeout = null;
  // ── Sound throttle (10s cooldown per play; same type in cooldown → ignored;
  //    different type in cooldown → queued; timer has priority in queue) ──────
  const _COOLDOWN     = 10_000;
  let   _soundTimer   = null;   // active setTimeout handle
  let   _currentType  = null;   // type of the sound currently in cooldown
  const _pendingQueue = [];     // [{url, type}] waiting to play

  function _playNow(url, type) {
    _currentType = type;
    _playSound(url);
    if (_soundTimer) clearTimeout(_soundTimer);
    _soundTimer = setTimeout(() => {
      _soundTimer  = null;
      _currentType = null;
      _drainPending();
    }, _COOLDOWN);
  }

  function _drainPending() {
    if (_pendingQueue.length === 0) return;
    // Timer always has priority
    const timerIdx = _pendingQueue.findIndex(e => e.type === "timer");
    const idx = timerIdx >= 0 ? timerIdx : 0;
    const { url, type } = _pendingQueue.splice(idx, 1)[0];
    _playNow(url, type);
  }

  function _scheduleSound(url, type) {
    if (!_soundTimer) {
      _playNow(url, type);
      return;
    }
    // In cooldown: same type as playing → ignore; already queued → ignore
    if (type === _currentType) return;
    if (_pendingQueue.some(e => e.type === type)) return;
    _pendingQueue.push({ url, type });
  }

  function _tryPlayProxSound()  { _scheduleSound("proximity.wav", "prox");  }
  function _tryPlayTimerSound() { _scheduleSound("timer.wav",     "timer"); }

  // Plays alarm.wav sequentially `times` times; returns a cancel function that
  // immediately stops the currently playing audio and prevents further repeats.
  function _playAlarmRepeat(times, url = "alarm.wav") {
    let cancelled = false;
    let currentSrc = null;   // AudioBufferSourceNode currently playing
    let currentAudio = null; // fallback Audio element

    (async function loop(n) {
      if (cancelled || n <= 0) return;
      try {
        const ctx = _ensureAudioCtx();
        if (!ctx) {
          // Fallback: HTML Audio — store ref so we can stop it
          const a = new Audio(url);
          currentAudio = a;
          await a.play().catch(() => {});
          await new Promise(resolve => { a.onended = resolve; a.onerror = resolve; });
          currentAudio = null;
        } else {
          if (ctx.state === "suspended") await ctx.resume();
          const res = await fetch(url);
          const buf = await res.arrayBuffer();
          const decoded = await ctx.decodeAudioData(buf);
          if (cancelled) return;
          const src = ctx.createBufferSource();
          src.buffer = decoded;
          src.connect(ctx.destination);
          currentSrc = src;
          await new Promise(resolve => { src.onended = resolve; src.start(0); });
          currentSrc = null;
        }
      } catch (_) {}
      loop(n - 1);
    })(times);

    return function cancel() {
      cancelled = true;
      if (currentSrc)   { try { currentSrc.stop(); }   catch (_) {} currentSrc   = null; }
      if (currentAudio) { try { currentAudio.pause(); currentAudio.currentTime = 0; } catch (_) {} currentAudio = null; }
    };
  }

  // Fired-set keys prevent repeat alerts within the same session / same minute
  const _firedProx   = new Set(); // "pinId:vehicleId"
  const _firedAlarm  = new Set(); // "pinId:alarmtime:YYYY-MM-DD"
  const _firedTajmer = new Set(); // "pinId:tajmermin"

  // ── Haversine distance (km) ────────────────────────────────────────────────
  function _haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const toRad = x => x * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2
            + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // ── In-app notification dialog (top-right) ────────────────────────────────
  function _fire(title, body, color, pinId, durationSec, onDismiss) {
    let wrap = document.getElementById("notif-dialog-wrap");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.id = "notif-dialog-wrap";
      document.body.appendChild(wrap);
    }

    const accent = color || "#4a9eff";

    const card = document.createElement("div");
    card.className = "notif-card";
    card.style.setProperty("--notif-accent", accent);

    const bar = document.createElement("div");
    bar.className = "notif-card-bar";

    const header = document.createElement("div");
    header.className = "notif-card-header";

    const titleEl = document.createElement("span");
    titleEl.className = "notif-card-title";
    titleEl.textContent = title;

    const closeBtn = document.createElement("button");
    closeBtn.className = "notif-card-close";
    closeBtn.innerHTML = "&#x2715;";
    closeBtn.addEventListener("click", () => { _dismissCard(card); if (onDismiss) onDismiss(); });

    header.appendChild(titleEl);
    header.appendChild(closeBtn);

    const bodyEl = document.createElement("div");
    bodyEl.className = "notif-card-body";
    bodyEl.textContent = body;

    if (pinId) {
      card.style.cursor = "pointer";
      card.addEventListener("click", e => {
        if (e.target === closeBtn) return;
        const pinsApi = global.pinsApi;
        if (!pinsApi) return;
        const entry = pinsApi.getActivePins?.().get(pinId);
        if (entry) {
          const map = global._leafletMap;
          if (map) map.flyTo([entry.data.lat, entry.data.lng], Math.max(map.getZoom(), 14), { duration: 0.5 });
        }
      });
    }

    card.appendChild(bar);
    card.appendChild(header);
    card.appendChild(bodyEl);
    wrap.appendChild(card);

    const durMs = (durationSec === 0) ? 0 : ((durationSec != null ? durationSec : 10) * 1000);
    if (durMs > 0) setTimeout(() => { _dismissCard(card); if (onDismiss) onDismiss(); }, durMs);
  }

  function _dismissCard(card) {
    if (!card.isConnected) return;
    // Phase 1: slide out to the right (0.3s)
    card.classList.add("notif-card-out");
    setTimeout(() => {
      // Phase 2: collapse height so cards below shift up smoothly (0.22s)
      card.style.transition = "max-height 0.22s ease, margin 0.22s ease, padding 0.22s ease, border-width 0.22s ease, gap 0.22s ease";
      card.style.overflow   = "hidden";
      card.style.maxHeight  = card.offsetHeight + "px";
      // Force reflow so transition starts from current height
      card.offsetHeight; // eslint-disable-line no-unused-expressions
      card.style.maxHeight    = "0";
      card.style.marginTop    = "0";
      card.style.marginBottom = "0";
      card.style.paddingTop   = "0";
      card.style.paddingBottom = "0";
      card.style.borderTopWidth    = "0";
      card.style.borderBottomWidth = "0";
      setTimeout(() => card.remove(), 240);
    }, 300);
  }

  // ── Proximity check ────────────────────────────────────────────────────────
  function checkProximity() {
    const vehicles = typeof _vehicleDataCache !== "undefined" ? _vehicleDataCache : null;
    if (!vehicles || vehicles.size === 0) return;

    Object.values(_pinsCache).forEach(pin => {
      if (!pin.upozorenje || !pin.lat || !pin.lng || !pin.vehicleId) return;
      if (pin.tipHidden === true) return;
      const threshold = Number(pin.upozorenjekm) || 3;

      const vehicleId = pin.vehicleId;
      const vehicle   = vehicles.get(vehicleId);
      if (!vehicle || !vehicle.lat || !vehicle.lng) return;

      const dist = _haversineKm(pin.lat, pin.lng, vehicle.lat, vehicle.lng);
      const key  = `${pin.id}:${vehicleId}`;

      if (dist < threshold) {
          if (!_firedProx.has(key)) {
            _firedProx.add(key);
            const vLbl  = vehicle.label || vehicle.licenceplate || vehicleId;
            const pLbl  = (pin.label || "").trim();
            const shape = pin.shape || "square";
            const msg   = shape === "diamond"
              ? (pLbl ? `Vozilo ${vLbl} se približava lokaciji ${pLbl}` : `Vozilo ${vLbl} se približava lokaciji`)
              : (pLbl ? `Vozilo ${vLbl} će uskoro biti na lokaciji ${pLbl}` : `Vozilo ${vLbl} će uskoro biti na lokaciji`);
            const _t = global.notifToggles || {};
            console.group(`%c🔵 BLIZINA  pin: ${pin.id}  vozilo: ${vehicleId}  dist: ${dist.toFixed(3)} km`, "color:#38bdf8;font-weight:bold");
            console.log("toggles →", { proxCard: _t.proxCard, proxSound: _t.proxSound });
            console.log("poruka  →", msg);
            if (_t.proxCard  === true) { console.log("%c  ✅ kartica: PALI",  "color:#4ade80"); _fire("Upozorenje o blizini", msg, pin.color || vehicle.color, pin.id, (global.notifCardSec || {}).prox ?? 10); }
            else                       { console.log("%c  🚫 kartica: ugasena", "color:#f87171"); }
            global.pinsApi?.pulsePin(pin.id);
            if (_t.proxSound === true) { console.log("%c  ✅ zvuk:    PALI",  "color:#4ade80"); _tryPlayProxSound(); }
            else                       { console.log("%c  🚫 zvuk:    ugasen", "color:#f87171"); }
            console.groupEnd();
          }
        }
    });
  }

  // ── Alarm check (fires once per pin per day at the set HH:MM) ─────────────
  function checkAlarms() {
    const now      = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const nowHHMM  = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

    Object.values(_pinsCache).forEach(pin => {
      if (!pin.alarm || !pin.alarmtime) return;
      if (pin.tipHidden === true) return;

      // Skip pins outside their visible date range
      const pFrom = pin.visibleFrom || "";
      const pTo   = pin.visibleTo   || "";
      if (pFrom && pTo && (todayStr < pFrom || todayStr > pTo)) return;

      const key = `${pin.id}:${pin.alarmtime}:${todayStr}`;
      if (pin.alarmtime === nowHHMM && !_firedAlarm.has(key)) {
        _firedAlarm.add(key);
        _pruneDatedKeys(_firedAlarm, todayStr);
        const pLbl = pin.label || pin.id;
        // Alarm uvijek pali i karticui i zvuk (bez togglea)
        console.group(`%c🟡 ALARM  pin: ${pin.id}  (${pLbl})  vrijeme: ${pin.alarmtime}`, "color:#facc15;font-weight:bold");
        console.log("%c  ✅ kartica: PALI (uvijek)", "color:#4ade80");
        console.log("%c  ✅ zvuk:    PALI (uvijek)", "color:#4ade80");
        console.groupEnd();
        const _cancelAlarm = _playAlarmRepeat(3);
        _fire(
          "Alarm",
          `Pin "${pLbl}" — postavljeni alarm za ${pin.alarmtime}`,
          pin.color,
          pin.id,
          0,
          _cancelAlarm
        );
      }
    });
  }

  // ── Timer check (tajmer — fires once when createdAt + tajmermin elapses) ───
  function checkTimers() {
    const now = Date.now();

    Object.values(_pinsCache).forEach(pin => {
      if (!pin.tajmer || !pin.tajmerStart || !pin.tajmermin) return;
      if (pin.tipHidden === true) return;
      const minutes = Number(pin.tajmermin);
      if (!minutes) return;
      const tajmerStart = new Date(pin.tajmerStart).getTime();
      if (isNaN(tajmerStart)) return;

      const expiresAt = tajmerStart + minutes * 60_000;
      const key = `${pin.id}:${pin.tajmerStart}:${minutes}`;

      if (now >= expiresAt && now - expiresAt <= 60_000 && !_firedTajmer.has(key)) {
        _firedTajmer.add(key);
        const pLbl = (pin.label || "").trim();
        const body = pLbl
          ? `Tajmer za lokaciju ${pLbl} je istekao`
          : `Tajmer je istekao`;
        const remaining = Math.round((expiresAt - tajmerStart) / 60_000);
        const _t = global.notifToggles || {};
        console.group(`%c🟠 TAJMER  pin: ${pin.id}  (${pLbl || "bez naziva"})  postavljeno: ${remaining} min`, "color:#fb923c;font-weight:bold");
        console.log("isteklo:", new Date(expiresAt).toLocaleTimeString());
        console.log("toggles →", { tajmerCard: _t.tajmerCard, tajmerSound: _t.tajmerSound });
        if (_t.tajmerCard  === true) { console.log("%c  ✅ kartica: PALI",  "color:#4ade80"); }
        else                         { console.log("%c  🚫 kartica: ugasena", "color:#f87171"); }
        if (_t.tajmerSound === true) { console.log("%c  ✅ zvuk:    PALI",  "color:#4ade80"); }
        else                         { console.log("%c  🚫 zvuk:    ugasen", "color:#f87171"); }
        console.groupEnd();
        if (_t.tajmerCard  === true) _fire("Tajmer", body, pin.color, pin.id, (global.notifCardSec || {}).tajmer ?? 10);
        if (_t.tajmerSound === true) _tryPlayTimerSound();
      }
    });
  }

  // ── Prune old dated alarm keys (keep only today's) ────────────────────────
  function _pruneDatedKeys(set, todayStr) {
    for (const k of set) {
      // Keys ending with a date that isn't today → safe to remove
      const match = k.match(/:(\d{4}-\d{2}-\d{2})$/);
      if (match && match[1] !== todayStr) set.delete(k);
    }
  }

  // ── Stale-vehicle check (pin at same location without status change) ────────
  // Tracks which pin+vehicle combos are already stale (pulsing)
  const _staleActive    = new Set();  // "pinId:vehicleId" — currently pulsing
  const _firedStale     = new Set();  // "pinId:vehicleId" — notif fired
  const _staleDismissed = new Set();  // "pinId:vehicleId" — user dismissed; don't re-trigger until condition clears

  function checkStale() {
    const vehicles = typeof _vehicleDataCache !== "undefined" ? _vehicleDataCache : null;
    if (!vehicles || vehicles.size === 0) return;
    const staleMin = Number(global.userStaleMin || 0);
    if (!staleMin) return;
    const now = Date.now();

    Object.values(_pinsCache).forEach(pin => {
      if (!pin.upozorenje || !pin.vehicleId || !pin.lat || !pin.lng) return;
      if (pin.tipHidden === true) return;
      const vehicle = vehicles.get(pin.vehicleId);
      if (!vehicle || !vehicle.lat || !vehicle.lng) return;

      // Vehicle must currently be within the pin's proximity radius
      const threshold = Number(pin.upozorenjekm) || 3;
      const dist = _haversineKm(pin.lat, pin.lng, vehicle.lat, vehicle.lng);
      if (dist > threshold) {
        // Left the area — stop pulsing if it was active
        const key = `${pin.id}:${pin.vehicleId}`;
        if (_staleActive.has(key)) {
          _staleActive.delete(key);
          _firedStale.delete(key);
          global.pinsApi?.stopStalePin(pin.id);
        }
        return;
      }

      const key = `${pin.id}:${pin.vehicleId}`;

      // Determine last-status-change timestamp
      const rawTs =
        vehicle.gmtLastDriveStatusChange ??
        vehicle.lastDriveStatusChange ??
        vehicle.LastDriveStatusChange ??
        vehicle.gmtlastdrivestatuschange ??
        vehicle.gpsGMT;
      if (!rawTs) return;
      const lastChange = new Date(rawTs).getTime();
      if (isNaN(lastChange)) return;

      const elapsedMin = (now - lastChange) / 60_000;
      const isStale = elapsedMin >= staleMin;

      if (isStale) {
        // Start pulsing if not already and not dismissed
        if (!_staleActive.has(key) && !_staleDismissed.has(key)) {
          _staleActive.add(key);
          global.pinsApi?.pulseStalePin(pin.id);
        }
        // Fire notification once per key (skip if already dismissed this cycle)
        if (!_firedStale.has(key) && !_staleDismissed.has(key)) {
          _firedStale.add(key);
          const pLbl = (pin.label || "").trim() || pin.id;
          const vLbl = vehicle.label || vehicle.licenceplate || pin.vehicleId;
          const totalMin = Math.round(elapsedMin);
          const h = Math.floor(totalMin / 60);
          const m = totalMin % 60;
          const duration = h > 0
            ? `${h} ${h === 1 ? "sat" : h < 5 ? "sata" : "sati"}${m > 0 ? ` i ${m} ${m === 1 ? "minut" : m < 5 ? "minuta" : "minuta"}` : ""}`
            : `${m} ${m === 1 ? "minut" : "minuta"}`;
          const _dismissKey = key;
          const _pinId = pin.id;
          const _cancelStale = _playAlarmRepeat(1, "status.wav");
          _fire(
            "Vozilo na lokaciji",
            `Vozilo ${vLbl} je na lokaciji ${pLbl} duže od ${duration}`,
            pin.color || vehicle.color,
            pin.id,
            0,
            () => {
              // User dismissed — stop sound, stop pulse and mark dismissed
              _cancelStale();
              _staleActive.delete(_dismissKey);
              _staleDismissed.add(_dismissKey);
              global.pinsApi?.stopStalePin(_pinId);
            }
          );
        }
      } else {
        // No longer stale — fully reset so it can re-trigger if vehicle returns
        if (_staleActive.has(key) || _firedStale.has(key) || _staleDismissed.has(key)) {
          _staleActive.delete(key);
          _firedStale.delete(key);
          _staleDismissed.delete(key);
          global.pinsApi?.stopStalePin(pin.id);
        }
      }
    });
  }

  // ── Firebase live subscription to pins ────────────────────────────────────
  function _subscribe() {
    const db = global.db;
    if (!db) {
      console.warn("[Notif] Firebase nije dostupan — notifikacije neće raditi.");
      return;
    }
    _fbRef = db.ref("pins");
    _fbRef.on("value", snap => {
      const all = snap.val() || {};
      _pinsCache = {};
      Object.values(all).forEach(pin => {
        if (pin && !pin.deletedAt && pin.id) _pinsCache[pin.id] = pin;
      });
    }, err => {
      console.error("[Notif] Greška pri praćenju pinova:", err.message);
    });
  }

  function _unsubscribe() {
    if (_fbRef) { _fbRef.off("value"); _fbRef = null; }
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  function start() {
    _subscribe();

    // Proximity — check every 30 s
    _proxInterval  = setInterval(checkProximity, 30_000);
    // Stale-vehicle check — every 60 s
    _staleInterval = setInterval(checkStale, 60_000);

    // Alarm + timer — align first check to the next full minute boundary
    const msToNextMin = (60 - new Date().getSeconds()) * 1000
                      - new Date().getMilliseconds();
    _checkAlignTimeout = setTimeout(() => {
      checkAlarms();
      checkTimers();
      _checkInterval = setInterval(() => {
        checkAlarms();
        checkTimers();
      }, 60_000);
    }, msToNextMin);

    // Immediate pass after pins have had time to load
    setTimeout(() => {
      checkProximity();
      checkTimers();
      checkStale();
    }, 2500);
  }

  function stop() {
    clearInterval(_proxInterval);
    clearInterval(_staleInterval);
    clearInterval(_checkInterval);
    clearTimeout(_checkAlignTimeout);
    _unsubscribe();
    _pinsCache = {};
    _firedProx.clear();
    _firedAlarm.clear();
    _firedTajmer.clear();
    _firedStale.clear();
    _staleActive.clear();
    _staleDismissed.clear();
  }

  global.notificationApi = { start, stop, checkProximity, checkAlarms, checkTimers, checkStale };

})(window);
