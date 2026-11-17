/* Milk Truck Live — Firebase Compat dashboard
 * Requires the Firebase compat scripts and Leaflet loaded by index.html.
 * Firebase credentials are entered in the Settings dialog.
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const CONFIG_KEY = "milkTruckDashboardConfigV1";
  const SOUND_KEY = "milkTruckSoundEnabled";
  const DEVICE_TRAIL_KEY = "milkTruckDeviceLocationHistoryV1";

  const RISK = {
    SAFE: {
      label: "SAFE",
      message: "Temperature is below 6°C. Normal monitoring.",
      css: "good"
    },
    MONITORING: {
      label: "MONITORING",
      message: "Temperature is at or above 6°C. Monitoring the current reading.",
      css: "warn"
    },
    WARNING: {
      label: "WARNING",
      message: "Temperature rose by at least 0.4°C between consecutive samples while in the 6°C to below 7.5°C range.",
      css: "warn"
    },
    ALERT: {
      label: "ALERT",
      message: "Current temperature is at least 7.5°C.",
      css: "warn"
    },
    CRITICAL: {
      label: "CRITICAL",
      message: "Current temperature is at least 9°C.",
      css: "bad"
    },
    SENSOR_ERROR: {
      label: "SENSOR ERROR",
      message: "The temperature sensor is not providing a valid reading.",
      css: "bad"
    }
  };

  let firebaseApp = null;
  let auth = null;
  let db = null;
  let latestRef = null;
  let historyRef = null;
  let latest = null;
  let historyRecords = [];
  let currentRisk = null;

  let map = null;
  let truckMarker = null;
  let phoneMarker = null;
  let truckTrail = null;
  let deviceTrailLine = null;
  let deviceTrail = [];
  let phoneLocationMode = false;

  let deferredInstallPrompt = null;
  let audioContext = null;
  let soundEnabled = localStorage.getItem(SOUND_KEY) === "true";
  let soundLoopTimer = null;
  let soundTimeouts = [];
  let activeOscillators = new Set();
  let lastRiskKey = "";
  let lastNotifiedRiskKey = "";
  let lastMovementState = "Unknown";

  const dialog = $("settingsDialog");

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value;
  }

  function safe(value, fallback = "—") {
    return value === undefined || value === null || value === ""
      ? fallback
      : value;
  }

  function normalizeTimestamp(value) {
    if (value === undefined || value === null || value === "") return NaN;

    if (typeof value === "string" && !/^\d+(\.\d+)?$/.test(value)) {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : NaN;
    }

    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return NaN;
    return number < 1e12 ? number * 1000 : number;
  }

  function formatTime(value) {
    const ms = normalizeTimestamp(value);
    return Number.isFinite(ms)
      ? new Date(ms).toLocaleString("en-IN", {
          timeZone: "Asia/Kolkata",
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false
        })
      : "—";
  }

  function setConnection(message, kind = "muted") {
    const el = $("connection");
    if (!el) return;
    el.textContent = message;
    el.className = `pill ${kind}`;
  }

  function readConfig() {
    try {
      return JSON.parse(localStorage.getItem(CONFIG_KEY) || "null");
    } catch {
      return null;
    }
  }

  function saveConfig(config) {
    // Do not store the Firebase password in localStorage.
    const safeConfig = {
      apiKey: config.apiKey,
      databaseURL: config.databaseURL,
      truckId: config.truckId,
      email: config.email
    };
    localStorage.setItem(CONFIG_KEY, JSON.stringify(safeConfig));
  }

  function configFromForm() {
    return {
      apiKey: $("apiKey").value.trim(),
      databaseURL: $("dbUrl").value.trim().replace(/\/+$/, ""),
      truckId: $("truckId").value.trim(),
      email: $("email").value.trim(),
      password: $("password").value
    };
  }

  function fillForm(config = {}) {
    $("apiKey").value = config.apiKey || "";
    $("dbUrl").value = config.databaseURL ||
      "https://milk-truck-default-rtdb.asia-southeast1.firebasedatabase.app";
    $("truckId").value = config.truckId || "milkTruck01";
    $("email").value = config.email || "";
    $("password").value = "";
  }

  function stopFirebaseListeners() {
    try {
      if (latestRef) latestRef.off();
      if (historyRef) historyRef.off();
    } catch (error) {
      console.warn("Could not detach Firebase listeners:", error);
    }
    latestRef = null;
    historyRef = null;
  }

  function waitForAuthState(firebaseAuth) {
    return new Promise((resolve, reject) => {
      const unsubscribe = firebaseAuth.onAuthStateChanged(
        (user) => {
          unsubscribe();
          resolve(user);
        },
        (error) => {
          unsubscribe();
          reject(error);
        }
      );
    });
  }

  async function connect(config, options = {}) {
    const { password = "", showErrors = true } = options;

    if (!config?.apiKey || !config?.databaseURL ||
        !config?.truckId || !config?.email) {
      setConnection("Configuration needed", "muted");
      if (dialog && !dialog.open) dialog.showModal();
      return;
    }

    if (!window.firebase) {
      setConnection("Firebase SDK unavailable", "bad");
      setText("uploadStatus", "Firebase compat scripts did not load.");
      return;
    }

    stopFirebaseListeners();
    setConnection("Connecting…", "muted");
    setText("uploadStatus", "Signing in to Firebase…");

    try {
      const appName = "milkTruckDashboard";
      const existing = firebase.apps.find((app) => app.name === appName);
      if (existing) {
        await existing.delete();
      }

      firebaseApp = firebase.initializeApp({
        apiKey: config.apiKey,
        databaseURL: config.databaseURL
      }, appName);

      auth = firebaseApp.auth();
      await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);

      let user = await waitForAuthState(auth);
      if (!user) {
        if (!password) {
          setConnection("Sign-in required", "warn");
          setText("uploadStatus", "Enter your Firebase password in Settings to sign in.");
          if (dialog && !dialog.open) {
            fillForm(config);
            dialog.showModal();
          }
          return;
        }
        await auth.signInWithEmailAndPassword(config.email, password);
      } else if (user.email && user.email.toLowerCase() !== config.email.toLowerCase()) {
        await auth.signOut();
        if (!password) {
          setConnection("Sign-in required", "warn");
          setText("uploadStatus", "The saved Firebase account differs. Enter its password in Settings.");
          if (dialog && !dialog.open) {
            fillForm(config);
            dialog.showModal();
          }
          return;
        }
        await auth.signInWithEmailAndPassword(config.email, password);
      }

      db = firebaseApp.database();

      setText("truckLabel", config.truckId);
      latestRef = db.ref(`trucks/${config.truckId}/latest`);
      historyRef = db.ref(`trucks/${config.truckId}/history`);

      latestRef.on("value", (snapshot) => {
        latest = snapshot.val();
        if (!latest) {
          setText("uploadStatus", "No latest record found for this truck.");
          setText("tempStatus", "Waiting for device data");
          return;
        }
        renderLatest(latest);
        setText("uploadStatus", "Live updates received");
        setConnection("Firebase connected", "good");
      }, (error) => {
        console.error("Latest record listener:", error);
        setConnection("Read denied", "bad");
        setText("uploadStatus", error.message);
      });

      historyRef.limitToLast(500).on("value", renderHistory, (error) => {
        console.warn("History listener:", error);
      });

      setConnection("Firebase connected", "good");
      setText("uploadStatus", "Listening for live updates");
      if (dialog?.open) dialog.close();
    } catch (error) {
      console.error("Firebase connection failed:", error);
      setConnection("Connection failed", "bad");
      setText("uploadStatus", error.message || "Check Firebase settings.");
      if (showErrors) {
        alert(
          "Firebase connection failed:\n" +
          (error.message || error.code || "Unknown error") +
          "\n\nCheck the Web API key, Authentication email/password, database URL, and Realtime Database rules."
        );
      }
    }
  }

  function timestampMs(record) {
    return normalizeTimestamp(record?.timestamp);
  }

  function validTemperatureRecord(record) {
    const temperature = Number(record?.temperatureC);
    return record &&
      record.temperatureValid !== false &&
      record.temperatureC !== null &&
      record.temperatureC !== undefined &&
      record.temperatureC !== "" &&
      Number.isFinite(temperature) &&
      Number.isFinite(timestampMs(record));
  }

  function getSortedTemperatureRecords(records) {
    return (records || [])
      .filter(validTemperatureRecord)
      .map((record) => ({
        temperature: Number(record.temperatureC),
        timestamp: timestampMs(record)
      }))
      .sort((a, b) => a.timestamp - b.timestamp)
      .filter((record, index, array) =>
        index === 0 || record.timestamp !== array[index - 1].timestamp
      );
  }

  // Current status depends ONLY on the latest valid temperature reading.
  // Historical exposure is deliberately calculated separately below.
  function classifyCurrentTemperature(record, previousRecord = null) {
    if (!validTemperatureRecord(record)) {
      return {
        level: "SENSOR_ERROR",
        temperature: NaN,
        rise: 0,
        timestamp: NaN
      };
    }

    const temperature = Number(record.temperatureC);
    const previousTemperature = validTemperatureRecord(previousRecord)
      ? Number(previousRecord.temperatureC)
      : NaN;
    const rise = Number.isFinite(previousTemperature)
      ? temperature - previousTemperature
      : 0;

    let level = "SAFE";
    if (temperature >= 9) {
      level = "CRITICAL";
    } else if (temperature >= 7.5) {
      level = "ALERT";
    } else if (
      temperature >= 6 &&
      temperature < 7.5 &&
      Number.isFinite(previousTemperature) &&
      previousTemperature >= 6 &&
      rise >= 0.4
    ) {
      level = "WARNING";
    } else if (temperature >= 6) {
      level = "MONITORING";
    }

    return {
      level,
      temperature,
      rise,
      timestamp: timestampMs(record)
    };
  }

  // Exposure is a separate historical metric. It is not allowed to keep
  // the CURRENT temperature badge stuck at ALERT/CRITICAL after cooling.
  function calculateExposure(records) {
    const sorted = getSortedTemperatureRecords(records);
    let exposureMs = 0;

    for (let index = 1; index < sorted.length; index++) {
      const before = sorted[index - 1];
      const after = sorted[index];
      const gap = after.timestamp - before.timestamp;

      // Count only consecutive readings >=6°C, no more than 10 minutes apart.
      if (
        before.temperature >= 6 &&
        after.temperature >= 6 &&
        gap > 0 &&
        gap <= 10 * 60 * 1000
      ) {
        exposureMs += gap;
      }
    }

    let level = "SAFE";
    if (exposureMs >= 30 * 60 * 1000) {
      level = "CRITICAL";
    } else if (exposureMs >= 10 * 60 * 1000) {
      level = "ALERT";
    } else if (exposureMs > 0) {
      level = "MONITORING";
    }

    return { level, exposureMs };
  }

  function severityRank(level) {
    return ({
      SAFE: 0,
      MONITORING: 1,
      WARNING: 2,
      ALERT: 3,
      CRITICAL: 4,
      SENSOR_ERROR: 5
    })[level] ?? 0;
  }

  function stopSoundLoop() {
    if (soundLoopTimer) clearInterval(soundLoopTimer);
    soundLoopTimer = null;

    soundTimeouts.forEach((timer) => clearTimeout(timer));
    soundTimeouts = [];

    activeOscillators.forEach((oscillator) => {
      try { oscillator.stop(); } catch (_) {}
      try { oscillator.disconnect(); } catch (_) {}
    });
    activeOscillators.clear();
  }

  function scheduleSound(callback, delayMs) {
    const timer = setTimeout(() => {
      soundTimeouts = soundTimeouts.filter((item) => item !== timer);
      callback();
    }, delayMs);
    soundTimeouts.push(timer);
    return timer;
  }

  function playTone(frequency, durationMs, volume = 0.12) {
    if (!soundEnabled || !currentRisk ||
        !["WARNING", "ALERT", "CRITICAL"].includes(currentRisk.level)) return;

    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;

      audioContext = audioContext || new AudioContextClass();
      if (audioContext.state === "suspended") {
        audioContext.resume().catch((error) => console.warn("Audio resume:", error));
      }

      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();

      activeOscillators.add(oscillator);
      oscillator.onended = () => {
        activeOscillators.delete(oscillator);
        try { oscillator.disconnect(); } catch (_) {}
      };

      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(volume, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(
        0.001,
        audioContext.currentTime + durationMs / 1000
      );

      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start();
      oscillator.stop(audioContext.currentTime + durationMs / 1000);
    } catch (error) {
      console.warn("Dashboard audio unavailable:", error);
    }
  }

  function playRiskSound(level) {
    if (!soundEnabled || !["WARNING", "ALERT", "CRITICAL"].includes(level)) {
      stopSoundLoop();
      return;
    }

    stopSoundLoop();

    const pattern = () => {
      // Re-check the live current status before every tone.
      if (!soundEnabled || !currentRisk ||
          currentRisk.level !== level ||
          !["WARNING", "ALERT", "CRITICAL"].includes(currentRisk.level)) {
        stopSoundLoop();
        return;
      }

      if (level === "WARNING") {
        playTone(720, 180);
      } else if (level === "ALERT") {
        playTone(850, 180);
        scheduleSound(() => playTone(850, 180), 280);
      } else if (level === "CRITICAL") {
        playTone(980, 260);
        scheduleSound(() => playTone(760, 260), 330);
        scheduleSound(() => playTone(980, 260), 660);
      }
    };

    pattern();
    if (level === "ALERT" || level === "CRITICAL") {
      soundLoopTimer = setInterval(pattern, level === "CRITICAL" ? 2200 : 4500);
    }
  }

  async function sendBrowserNotification(title, body) {
    if (!("Notification" in window) || Notification.permission !== "granted") {
      console.info("Milk Truck alert:", title, body);
      return false;
    }

    const options = {
      body,
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-192.png",
      tag: "milk-truck-temperature-alert",
      renotify: true,
      requireInteraction: true
    };

    try {
      const registration = "serviceWorker" in navigator
        ? await navigator.serviceWorker.getRegistration()
        : null;

      if (registration?.showNotification) {
        await registration.showNotification(title, options);
      } else {
        new Notification(title, options);
      }
      return true;
    } catch (error) {
      console.warn("Notification could not be displayed:", error);
      return false;
    }
  }

  function updateRiskUI(records, latestRecord) {
    const combined = (records || []).slice();
    if (latestRecord) combined.push(latestRecord);

    const sorted = getSortedTemperatureRecords(combined);
    const latestValid = sorted.length ? sorted[sorted.length - 1] : null;
    const previousValid = sorted.length > 1 ? sorted[sorted.length - 2] : null;

    const current = latestValid
      ? classifyCurrentTemperature(
          {
            temperatureC: latestValid.temperature,
            timestamp: latestValid.timestamp,
            temperatureValid: true
          },
          previousValid
            ? {
                temperatureC: previousValid.temperature,
                timestamp: previousValid.timestamp,
                temperatureValid: true
              }
            : null
        )
      : { level: "SENSOR_ERROR", temperature: NaN, rise: 0, timestamp: NaN };

    // Alerts and sound are based ONLY on the latest current temperature status.
    currentRisk = current;

    const currentMeta = RISK[current.level] || RISK.SENSOR_ERROR;
    let statusText = currentMeta.label;
    if (current.level === "WARNING") {
      statusText = `WARNING · rise +${current.rise.toFixed(2)}°C/sample`;
    } else if (current.level === "MONITORING") {
      statusText = "MONITORING · current temperature ≥6°C";
    }

    setText("tempStatus", statusText);
    setText("tempBadge", currentMeta.label);

    const alertBox = $("alertBox");
    if (alertBox) {
      const currentLine = `${currentMeta.label}: ${currentMeta.message}` +
        (Number.isFinite(current.temperature)
          ? ` Current: ${current.temperature.toFixed(2)}°C.`
          : "");
      alertBox.className = `alert ${currentMeta.css}`;
      alertBox.textContent = currentLine;
    }

    const riskDot = $("tempDot");
    if (riskDot) {
      riskDot.className = "dot " +
        (current.level === "SAFE" ? "good" :
          current.level === "MONITORING" || current.level === "WARNING" ? "warn" : "bad");
    }

    const soundRisk = ["WARNING", "ALERT", "CRITICAL"].includes(current.level);
    if (!soundRisk) {
      // SAFE/MONITORING/SENSOR_ERROR: stop intervals, queued tones, and tones already playing.
      stopSoundLoop();
      lastRiskKey = current.level;
      lastNotifiedRiskKey = "";
      return;
    }

    if (current.level !== lastRiskKey) {
      if (lastNotifiedRiskKey !== current.level) {
        sendBrowserNotification(
          `MilkGuard ${current.level}: ${Number.isFinite(current.temperature) ? current.temperature.toFixed(2) : "—"}°C`,
          `Current temperature status: ${current.level}.`
        );
        lastNotifiedRiskKey = current.level;
      }
      playRiskSound(current.level);
      lastRiskKey = current.level;
    }
  }

  function updateSoundButton() {
    const button = $("soundToggle");
    if (!button) return;
    button.textContent = soundEnabled ? "🔊 Sound enabled" : "🔇 Sound disabled";
    button.classList.toggle("sound-on", soundEnabled);
    button.setAttribute("aria-pressed", String(soundEnabled));
  }

  function validCoordinates(latitude, longitude) {
    const lat = Number(latitude);
    const lng = Number(longitude);
    return Number.isFinite(lat) && Number.isFinite(lng) &&
      Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  }

  function ensureMap(latitude, longitude) {
    if (!window.L) {
      setText("locationNote", "Map library did not load. Use Open map to view coordinates.");
      return;
    }

    $("mapPlaceholder").style.display = "none";
    $("map").style.display = "block";

    if (!map) {
      map = L.map("map").setView([latitude, longitude], 15);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors"
      }).addTo(map);
    }

    setTimeout(() => map.invalidateSize(), 100);
  }

  function updateTruckMap(latitude, longitude) {
    if (!validCoordinates(latitude, longitude)) return;
    ensureMap(latitude, longitude);
    if (!map) return;

    const point = [Number(latitude), Number(longitude)];
    if (!truckMarker) {
      truckMarker = L.marker(point).addTo(map).bindPopup("🚚 Milk truck GPS");
    } else {
      truckMarker.setLatLng(point);
    }

    map.setView(point, Math.max(map.getZoom(), 14));
    $("openMap").href = `https://maps.google.com/?q=${point[0]},${point[1]}`;
    $("openMap").style.pointerEvents = "auto";
  }

  function loadDeviceTrail() {
    try {
      const parsed = JSON.parse(localStorage.getItem(DEVICE_TRAIL_KEY) || "[]");
      deviceTrail = Array.isArray(parsed) ? parsed : [];
    } catch {
      deviceTrail = [];
    }
  }

  function saveDeviceTrailPoint(latitude, longitude, accuracy) {
    const point = {
      latitude,
      longitude,
      accuracy: accuracy ?? null,
      timestamp: Date.now()
    };

    const previous = deviceTrail[deviceTrail.length - 1];
    if (
      !previous ||
      Math.abs(previous.latitude - latitude) > 0.00001 ||
      Math.abs(previous.longitude - longitude) > 0.00001 ||
      point.timestamp - previous.timestamp > 60000
    ) {
      deviceTrail.push(point);
      deviceTrail = deviceTrail.slice(-300);
      try {
        localStorage.setItem(DEVICE_TRAIL_KEY, JSON.stringify(deviceTrail));
      } catch (error) {
        console.warn("Could not save device GPS trail:", error);
      }
      renderDeviceTrail();
    }
  }

  function renderDeviceTrail() {
    if (!map || !window.L || !deviceTrail.length) return;
    const points = deviceTrail.map((point) => [
      point.latitude,
      point.longitude
    ]);
    if (deviceTrailLine) deviceTrailLine.remove();
    deviceTrailLine = L.polyline(points, {
      color: "#5de1d0",
      weight: 4,
      opacity: 0.8
    }).addTo(map);
  }

  function distanceKm(a, b) {
    const radians = (degrees) => degrees * Math.PI / 180;
    const dLat = radians(b.latitude - a.latitude);
    const dLng = radians(b.longitude - a.longitude);
    const lat1 = radians(a.latitude);
    const lat2 = radians(b.latitude);
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  function updateDeviceMovement(latitude, longitude, timestamp) {
    const previous = deviceTrail[deviceTrail.length - 1];
    if (previous && timestamp > previous.timestamp) {
      const distance = distanceKm(previous, { latitude, longitude });
      const hours = (timestamp - previous.timestamp) / 3600000;
      const speed = hours > 0 ? distance / hours : 0;
      lastMovementState = speed >= 3 ? "Running" : "Standing";
    } else if (!previous) {
      lastMovementState = "Collecting GPS";
    }
    setText("movementStatus", lastMovementState);
  }

  function requestPhoneGPS() {
    if (!navigator.geolocation) {
      setText("locationNote", "This browser does not support location services.");
      return;
    }

    if (!window.isSecureContext) {
      setText("locationNote", "Phone GPS requires HTTPS or localhost.");
      return;
    }

    setText("locationNote", "Requesting this device's GPS…");

    navigator.geolocation.getCurrentPosition(async (position) => {
      const latitude = position.coords.latitude;
      const longitude = position.coords.longitude;
      const timestamp = Date.now();

      phoneLocationMode = true;
      updateDeviceMovement(latitude, longitude, timestamp);
      saveDeviceTrailPoint(latitude, longitude, position.coords.accuracy);

      setText("gpsStatus", "Phone GPS fix");
      setText("coordinates", `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`);
      setText("locationSource", "Phone GPS");
      $("gpsDot").className = "dot good";
      setText("locationNote", "Showing this device's GPS, not necessarily the truck's location.");

      ensureMap(latitude, longitude);
      if (map) {
        const point = [latitude, longitude];
        if (!phoneMarker) {
          phoneMarker = L.marker(point).addTo(map).bindPopup("📱 Dashboard device GPS");
        } else {
          phoneMarker.setLatLng(point);
        }
        map.setView(point, Math.max(map.getZoom(), 14));
        renderDeviceTrail();
      }

      $("openMap").href = `https://maps.google.com/?q=${latitude},${longitude}`;
      $("openMap").style.pointerEvents = "auto";

      // Keep phone/device GPS separate from the ESP32 truck GPS data.
      if (db) {
        try {
          const truckId = readConfig()?.truckId || "milkTruck01";
          const record = {
            latitude,
            longitude,
            accuracyMeters: position.coords.accuracy ?? null,
            timestamp,
            locationName: "Dashboard device GPS"
          };
          await db.ref(`trucks/${truckId}/deviceGpsLocation`).set(record);
          await db.ref(`trucks/${truckId}/deviceGpsLocationHistory`).push(record);
          setText("locationNote", "Phone GPS shown. Device location saved separately in Firebase; truck GPS remains separate.");
        } catch (error) {
          console.warn("Phone GPS Firebase save failed:", error);
          setText("locationNote", "Phone GPS shown, but Firebase could not save the device location.");
        }
      }
    }, (error) => {
      setText("gpsStatus", "Unavailable");
      $("gpsDot").className = "dot bad";
      setText(
        "locationNote",
        error.code === 1
          ? "Location permission denied. Allow location access in browser settings."
          : "Phone GPS unavailable. Check location services and try again."
      );
    }, {
      enableHighAccuracy: true,
      timeout: 20000,
      maximumAge: 5000
    });
  }

  function renderLatest(record) {
    const temperature = Number(record.temperatureC);
    const validTemperature =
      record.temperatureValid !== false &&
      record.temperatureC !== null &&
      record.temperatureC !== undefined &&
      record.temperatureC !== "" &&
      Number.isFinite(temperature);

    setText(
      "temperature",
      validTemperature ? `${temperature.toFixed(2)}°C` : "Sensor error"
    );

    updateRiskUI(historyRecords, validTemperature ? record : null);

    const hasTruckGPS =
      record.gpsFix === true &&
      validCoordinates(record.latitude, record.longitude);

    if (!phoneLocationMode) {
      if (hasTruckGPS) {
        setText("gpsStatus", "Truck GPS fix");
        setText("coordinates",
          `${Number(record.latitude).toFixed(6)}, ${Number(record.longitude).toFixed(6)}`
        );
        setText("locationSource", "ESP32 GPS");
        $("gpsDot").className = "dot good";
        setText("locationNote", "Showing the GPS coordinates reported by the ESP32 truck device.");
        updateTruckMap(record.latitude, record.longitude);
      } else {
        setText("gpsStatus", "Searching");
        setText("coordinates", "Truck coordinates unavailable");
        setText("locationSource", "ESP32 GPS");
        $("gpsDot").className = "dot bad";
        setText("locationNote", "Waiting for a valid GPS fix from the ESP32.");
      }
    }

    const speed = Number(record.speedKmph);
    setText("speed", Number.isFinite(speed) ? speed.toFixed(1) : "—");
    setText("lastUpdate", formatTime(record.timestamp));
    setText("wifiStatus", record.wifiConnected === true ? "Connected" :
      record.wifiConnected === false ? "Offline" : "Unknown");
    setText("sensorStatus", validTemperature ? "OK" : "Error");
    setText("satellites", safe(record.satellites, "0"));

    if (record.movementStatus) {
      setText("movementStatus", record.movementStatus);
      lastMovementState = String(record.movementStatus);
    } else if (Number.isFinite(speed)) {
      lastMovementState = speed >= 3 ? "Running" : "Standing";
      setText("movementStatus", lastMovementState);
    }
  }

  function drawTemperatureChart(records) {
    const canvas = $("temperatureChart");
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const width = canvas.clientWidth || 600;
    const height = 260;
    const ratio = window.devicePixelRatio || 1;

    canvas.width = width * ratio;
    canvas.height = height * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const values = (records || [])
      .filter((record) =>
        Number.isFinite(Number(record.temperatureC)) &&
        Number.isFinite(timestampMs(record))
      )
      .slice(-30);

    if (!values.length) {
      context.fillStyle = "#94a9bf";
      context.font = "14px system-ui";
      context.fillText("Temperature history will appear after records load.", 16, 32);
      setText("chartSummary", "No readings");
      return;
    }

    const temperatures = values.map((record) => Number(record.temperatureC));
    const min = Math.min(...temperatures, 6) - 1;
    const max = Math.max(...temperatures, 6) + 1;
    const left = 44;
    const right = 12;
    const top = 16;
    const bottom = 36;
    const chartWidth = Math.max(1, width - left - right);
    const chartHeight = height - top - bottom;

    context.font = "11px system-ui";
    context.strokeStyle = "#2a4057";
    context.fillStyle = "#94a9bf";
    context.lineWidth = 1;

    for (let index = 0; index < 5; index++) {
      const y = top + chartHeight * index / 4;
      context.beginPath();
      context.moveTo(left, y);
      context.lineTo(width - right, y);
      context.stroke();
      context.fillText(
        (max - (max - min) * index / 4).toFixed(1),
        3,
        y + 4
      );
    }

    // 6°C reference threshold.
    const thresholdY = top + chartHeight * (max - 6) / (max - min);
    context.setLineDash([5, 4]);
    context.strokeStyle = "#ffca70";
    context.beginPath();
    context.moveTo(left, thresholdY);
    context.lineTo(width - right, thresholdY);
    context.stroke();
    context.setLineDash([]);

    context.strokeStyle = "#5de1d0";
    context.lineWidth = 2.5;
    context.beginPath();

    temperatures.forEach((temperature, index) => {
      const x = left + (
        values.length === 1
          ? chartWidth / 2
          : chartWidth * index / (values.length - 1)
      );
      const y = top + chartHeight * (max - temperature) / (max - min);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });

    context.stroke();
    context.fillStyle = "#70a7ff";

    temperatures.forEach((temperature, index) => {
      const x = left + (
        values.length === 1
          ? chartWidth / 2
          : chartWidth * index / (values.length - 1)
      );
      const y = top + chartHeight * (max - temperature) / (max - min);
      context.beginPath();
      context.arc(x, y, 3, 0, Math.PI * 2);
      context.fill();
    });

    context.fillStyle = "#94a9bf";
    const firstLabel = formatTime(values[0].timestamp);
    const lastLabel = formatTime(values[values.length - 1].timestamp);
    context.fillText(firstLabel, left, height - 9);
    context.fillText(
      lastLabel,
      Math.max(left, width - right - context.measureText(lastLabel).width),
      height - 9
    );

    setText(
      "chartSummary",
      `Latest ${temperatures[temperatures.length - 1].toFixed(2)}°C · ${values.length} readings`
    );
  }

  function statusForHistory(record, allRecords) {
    const sorted = getSortedTemperatureRecords(allRecords);
    const recordTime = timestampMs(record);
    const index = sorted.findIndex((item) => item.timestamp === recordTime);
    const previous = index > 0
      ? {
          temperatureC: sorted[index - 1].temperature,
          timestamp: sorted[index - 1].timestamp,
          temperatureValid: true
        }
      : null;

    const status = classifyCurrentTemperature(record, previous);
    return status.level === "MONITORING" ? "MONITORING (≥6°C)" : status.level;
  }

  function renderHistory(snapshot) {
    const data = snapshot.val();
    const records = data && typeof data === "object"
      ? Object.entries(data)
          .map(([key, value]) => ({ key, ...(value || {}) }))
          .filter((record) => Number.isFinite(timestampMs(record)))
          .sort((a, b) => timestampMs(a) - timestampMs(b))
      : [];

    historyRecords = records;

    const body = $("historyRows");
    body.replaceChildren();

    const displayRecords = records.slice(-20).reverse();

    if (!displayRecords.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 4;
      cell.textContent = "No history records found.";
      row.appendChild(cell);
      body.appendChild(row);
    } else {
      displayRecords.forEach((record) => {
        const row = document.createElement("tr");
        const recordTime = timestampMs(record);
        const recordsUpToThisPoint = records.filter(
          (item) => timestampMs(item) <= recordTime
        );

        const gpsAvailable =
          record.gpsFix === true &&
          validCoordinates(record.latitude, record.longitude);

        const gpsText = gpsAvailable
          ? `${Number(record.latitude).toFixed(5)}, ${Number(record.longitude).toFixed(5)}`
          : "—";

        const cells = [
          formatTime(record.timestamp),
          Number.isFinite(Number(record.temperatureC))
            ? `${Number(record.temperatureC).toFixed(2)}°C`
            : "—",
          gpsText,
          statusForHistory(record, recordsUpToThisPoint)
        ];

        cells.forEach((value) => {
          const cell = document.createElement("td");
          cell.textContent = value;
          row.appendChild(cell);
        });

        body.appendChild(row);
      });
    }

    drawTemperatureChart(records.slice(-120));

    if (latest) {
      updateRiskUI(historyRecords, latest);
    }
  }

  function addChatMessage(message, sender) {
    const bubble = document.createElement("div");
    bubble.className = `bubble ${sender}`;
    bubble.textContent = message;
    $("chatLog").appendChild(bubble);
    $("chatLog").scrollTop = $("chatLog").scrollHeight;
  }

  function assistantReply(input) {
    const query = input.toLowerCase();

    if (/temperature issue|temp issue|any temperature|temperature problem/.test(query)) {
      if (!latest || latest.temperatureC == null) {
        return "No valid temperature reading is available yet. Check the DS18B20 sensor and the Firebase latest record.";
      }
      const risk = currentRisk;
      return `Current temperature: ${Number(latest.temperatureC).toFixed(2)}°C. Current status: ${risk?.level || "UNKNOWN"}. Sound alerts use only this current status.`;
    }

    if (/location history|track.*location|route history/.test(query)) {
      return "The dashboard stores phone GPS trail points locally on this browser. ESP32 truck GPS is read from the truck's latest/history records when those records contain valid coordinates. Phone GPS is saved separately under deviceGpsLocation and is not treated as truck GPS.";
    }

    if (/standing|running|moving|truck status/.test(query)) {
      if (latest && Number.isFinite(Number(latest.speedKmph))) {
        const speed = Number(latest.speedKmph);
        return `ESP32 reported truck speed: ${speed.toFixed(1)} km/h. Estimated movement: ${speed >= 3 ? "Running" : "Standing"}.`;
      }
      return `Movement status: ${lastMovementState}. Truck movement is most reliable when the ESP32 uploads GPS speed or changing truck coordinates.`;
    }

    if (/temp|temperature|cold|milk/.test(query)) {
      if (!latest) {
        return "I have not received a truck record yet. Check Firebase and ensure the ESP32 uploads to /trucks/<truckId>/latest.";
      }
      const risk = currentRisk;
      const value = Number.isFinite(Number(latest.temperatureC))
        ? `${Number(latest.temperatureC).toFixed(2)}°C`
        : "unavailable";
      return `Latest temperature: ${value}. Current status: ${risk?.level || "UNKNOWN"}. Sound alerts use only this current status.`;
    }

    if (/gps|location|map|coordinate|satellite/.test(query)) {
      if (!latest) return "No ESP32 truck record is loaded yet.";
      const hasGps = latest.gpsFix === true &&
        validCoordinates(latest.latitude, latest.longitude);
      return hasGps
        ? `Truck GPS fix available. Latitude ${latest.latitude}, longitude ${latest.longitude}; satellites: ${safe(latest.satellites, "unknown")}.`
        : "The latest ESP32 record has no valid GPS fix. Check antenna placement and wait for the GPS module to obtain a satellite fix.";
    }

    if (/wifi|internet|offline|connect/.test(query)) {
      return `Dashboard Firebase connection: ${db ? "connected" : "not connected"}. ESP32 Wi-Fi status: ${latest?.wifiConnected === true ? "connected" : latest?.wifiConnected === false ? "offline" : "unknown"}. Check hotspot range, SSID/password, and ESP32 Serial Monitor.`;
    }

    if (/alert|alarm|threshold|warning|risk/.test(query)) {
      return "Current temperature rules: SAFE below 6°C; MONITORING from 6°C to below 7.5°C; WARNING in that range if the temperature rises at least 0.4°C between samples; ALERT from 7.5°C to below 9°C; CRITICAL at 9°C or above. Sound alerts depend only on the latest current temperature status and stop when it returns to SAFE or MONITORING.";
    }

    if (/update|not working|troubleshoot|error|failed|problem/.test(query)) {
      return "Troubleshooting: (1) check ESP32 Serial Monitor; (2) verify /trucks/<truckId>/latest in Firebase; (3) confirm the dashboard truck ID and Firebase project; (4) check Authentication and database rules; (5) inspect the browser console for errors.";
    }

    if (/help|what can you do|hello|hi\b/.test(query)) {
      return "Hi! I can explain temperature, GPS, truck movement, Wi-Fi, alerts, Firebase uploads, and dashboard troubleshooting. I use built-in rules and do not call an external AI service.";
    }

    return "Try asking: “What is the temperature?”, “Is GPS working?”, “Is there a temperature issue?”, or “Why is data not updating?”";
  }

  function enableSound() {
    const button = $("soundToggle");
    button.addEventListener("click", async () => {
      soundEnabled = !soundEnabled;
      localStorage.setItem(SOUND_KEY, String(soundEnabled));

      if (soundEnabled) {
        try {
          const AudioContextClass = window.AudioContext || window.webkitAudioContext;
          if (!AudioContextClass) throw new Error("Web Audio is not supported.");

          audioContext = audioContext || new AudioContextClass();
          if (audioContext.state === "suspended") await audioContext.resume();

          // Short test tone confirms that sound has been enabled.
          playTone(880, 180, 0.2);
          setTimeout(() => playTone(660, 180, 0.2), 240);

          if (currentRisk && ["WARNING", "ALERT", "CRITICAL"].includes(currentRisk.level)) {
            scheduleSound(() => {
              if (currentRisk && ["WARNING", "ALERT", "CRITICAL"].includes(currentRisk.level)) {
                playRiskSound(currentRisk.level);
              }
            }, 500);
          }
        } catch (error) {
          soundEnabled = false;
          localStorage.setItem(SOUND_KEY, "false");
          alert(`Could not enable sound: ${error.message}`);
        }
      } else {
        stopSoundLoop();
      }

      updateSoundButton();
    });

    updateSoundButton();
  }

  function enableNotifications() {
    $("enableNotifications").addEventListener("click", async () => {
      const button = $("enableNotifications");

      if (!("Notification" in window)) {
        button.textContent = "Notifications unsupported";
        alert("This browser does not support notifications. Try an updated Chrome or Edge.");
        return;
      }

      if (!window.isSecureContext) {
        alert("Notifications require HTTPS or localhost. Do not open the website as a file:// page.");
        return;
      }

      try {
        const permission = await Notification.requestPermission();

        if (permission === "granted") {
          button.textContent = "🔔 Notifications: ON";
          const registration = "serviceWorker" in navigator
            ? await navigator.serviceWorker.ready
            : null;

          if (registration?.showNotification) {
            await registration.showNotification("Milk Truck Live notifications enabled", {
              body: "The dashboard can now show temperature risk notifications.",
              icon: "./icons/icon-192.png",
              tag: "milkguard-notification-test"
            });
          } else {
            new Notification("Milk Truck Live notifications enabled", {
              body: "The dashboard can now show temperature risk notifications.",
              icon: "./icons/icon-192.png"
            });
          }
        } else {
          button.textContent = permission === "denied"
            ? "Notifications blocked"
            : "🔔 Enable browser notifications";

          alert(permission === "denied"
            ? "Notifications are blocked for this site. Allow them in browser site settings, then reload."
            : "Notification permission was not granted.");
        }
      } catch (error) {
        console.warn("Notification permission error:", error);
        alert(`Could not enable notifications: ${error.message}`);
      }
    });

    if ("Notification" in window && Notification.permission === "granted") {
      $("enableNotifications").textContent = "🔔 Notifications: ON";
    }
  }

  function setupChat() {
    $("chatForm").addEventListener("submit", (event) => {
      event.preventDefault();
      const input = $("chatInput").value.trim();
      if (!input) return;

      addChatMessage(input, "user");
      addChatMessage(assistantReply(input), "bot");
      $("chatInput").value = "";
    });

    document.querySelectorAll("[data-prompt]").forEach((button) => {
      button.addEventListener("click", () => {
        $("chatInput").value = button.dataset.prompt || "";
        $("chatForm").requestSubmit();
      });
    });
  }

  function setupSettings() {
    $("settingsBtn").addEventListener("click", () => {
      fillForm(readConfig() || {});
      dialog.showModal();
    });

    $("settingsForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const config = configFromForm();

      if (!config.password) {
        alert("Enter your Firebase password to connect. For security, this app does not save the password in localStorage.");
        $("password").focus();
        return;
      }

      saveConfig(config);
      await connect(config, { password: config.password });
    });

    $("clearSettings").addEventListener("click", async () => {
      localStorage.removeItem(CONFIG_KEY);
      stopFirebaseListeners();

      try {
        if (auth) await auth.signOut();
        if (firebaseApp) await firebaseApp.delete();
      } catch (error) {
        console.warn("Firebase sign-out:", error);
      }

      firebaseApp = null;
      auth = null;
      db = null;
      latest = null;
      historyRecords = [];

      fillForm();
      setConnection("Settings cleared", "muted");
      setText("uploadStatus", "Reconnect using Firebase settings.");
      setText("temperature", "—");
      setText("gpsStatus", "Unknown");
      setText("coordinates", "Coordinates unavailable");
    });

    $("refreshBtn").addEventListener("click", async () => {
      const config = readConfig();
      if (!config) {
        fillForm();
        dialog.showModal();
        return;
      }
      await connect(config, { password: "" , showErrors: false });
    });
  }

  function setupMapAndGps() {
    $("mobileGpsBtn").addEventListener("click", requestPhoneGPS);
  }

  function setupPwa() {
    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      deferredInstallPrompt = event;
      $("installBtn").hidden = false;
    });

    $("installBtn").addEventListener("click", async () => {
      if (!deferredInstallPrompt) return;

      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      $("installBtn").hidden = true;
    });

    if ("serviceWorker" in navigator && location.protocol !== "file:") {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("./sw.js")
          .catch((error) => console.warn("Service worker registration failed:", error));
      });
    }
  }

  function setupOnlineHandling() {
    window.addEventListener("online", async () => {
      const config = readConfig();
      if (config) {
        await connect(config, { password: "", showErrors: false });
      }
    });

    window.addEventListener("offline", () => {
      setConnection("Internet offline", "bad");
      setText("uploadStatus", "Waiting for internet connection.");
    });
  }

  function setupChartResize() {
    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => drawTemperatureChart(historyRecords), 120);
    });
  }

  function initialize() {
    if (!dialog) {
      console.error("settingsDialog is missing from index.html");
      return;
    }

    loadDeviceTrail();
    enableSound();
    enableNotifications();
    setupChat();
    setupSettings();
    setupMapAndGps();
    setupPwa();
    setupOnlineHandling();
    setupChartResize();

    const savedConfig = readConfig();
    if (savedConfig) {
      fillForm(savedConfig);
      connect(savedConfig, { password: "", showErrors: false });
    } else {
      fillForm();
      setConnection("Setup required", "muted");
      setTimeout(() => {
        if (!dialog.open) dialog.showModal();
      }, 400);
    }

    // Prefer ESP32 truck GPS by default. Phone GPS is opt-in via Refresh GPS.
    setText("locationSource", "ESP32 GPS");
    setText("locationNote", "Waiting for truck GPS coordinates from the ESP32.");
    $("map").style.display = "none";
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize);
  } else {
    initialize();
  }
})();