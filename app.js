/* Milk Truck Live dashboard. Firebase web config is entered by the user in Settings. */
(() => {
  const $ = id => document.getElementById(id);
  const STORAGE_KEY = "milkTruckDashboardConfigV1";
  let db = null, auth = null, latestRef = null, historyRef = null, latest = null;
  let map = null, marker = null, deferredInstall = null, phoneLocationMode = false;
  const dialog = $("settingsDialog");
  const safe = (v, fallback = "—") => v === undefined || v === null || v === "" ? fallback : v;
  const fmtTime = v => {
    if (!v) return "—";
    const d = new Date(Number(v) < 1e12 ? Number(v) * 1000 : Number(v));
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
  };
  const setConnection = (text, kind = "muted") => {
    $("connection").textContent = text;
    $("connection").className = "pill " + kind;
  };
  function configFromForm() {
    return {
      apiKey: $("apiKey").value.trim(),
      databaseURL: $("dbUrl").value.trim().replace(/\/+$/, ""),
      truckId: $("truckId").value.trim(),
      email: $("email").value.trim(),
      password: $("password").value
    };
  }
  function fillForm(c = {}) {
    $("apiKey").value = c.apiKey || "";
    $("dbUrl").value = c.databaseURL || "https://milk-truck-default-rtdb.asia-southeast1.firebasedatabase.app";
    $("truckId").value = c.truckId || "milkTruck01";
    $("email").value = c.email || "";
    $("password").value = c.password || "";
  }
  function readConfig() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); } catch { return null; }
  }
  function stopListeners() {
    try { if (latestRef) latestRef.off(); if (historyRef) historyRef.off(); } catch {}
    latestRef = historyRef = null; db = null;
  }
  async function connect(c) {
    if (!c?.apiKey || !c?.databaseURL || !c?.truckId || !c?.email || !c?.password) {
      setConnection("Configuration needed"); dialog.showModal(); return;
    }
    if (!window.firebase) { setConnection("Firebase SDK unavailable", "bad"); return; }
    try {
      stopListeners();
      const appName = "milkTruckDashboard";
      let app = firebase.apps.find(a => a.name === appName);
      if (app) await app.delete();
      app = firebase.initializeApp({apiKey:c.apiKey, databaseURL:c.databaseURL}, appName);
      auth = app.auth();
      await auth.signInWithEmailAndPassword(c.email, c.password);
      db = app.database();
      $("truckLabel").textContent = c.truckId;
      latestRef = db.ref(`trucks/${c.truckId}/latest`);
      historyRef = db.ref(`trucks/${c.truckId}/history`);
      latestRef.on("value", snap => {
        latest = snap.val();
        if (!latest) { $("uploadStatus").textContent = "No latest record found"; return; }
        renderLatest(latest);
      }, err => { setConnection("Read denied", "bad"); $("uploadStatus").textContent = err.message; });
      historyRef.limitToLast(20).on("value", renderHistory, err => console.warn("History read:", err.message));
      setConnection("Firebase connected", "good");
      $("uploadStatus").textContent = "Listening for live updates";
      if (dialog.open) dialog.close();
    } catch (e) {
      console.error(e);
      setConnection("Connection failed", "bad");
      $("uploadStatus").textContent = e.message || "Check credentials and database rules";
      alert("Firebase connection failed: " + (e.message || e.code || "Unknown error") + "\n\nCheck your Web API key, Firebase Authentication user, database URL, and database rules.");
    }
  }
  function renderLatest(d) {
    const t = Number(d.temperatureC);
    const valid = d.temperatureValid !== false && d.temperatureC !== null && Number.isFinite(t);
    $("temperature").textContent = valid ? `${t.toFixed(2)}°C` : "Sensor error";
    $("tempDot").className = "dot " + (valid ? (t >= 40 ? "bad" : t >= 35 ? "" : "good") : "bad");
    $("tempStatus").textContent = valid ? (d.temperatureStatus || (t >= 40 ? "ALARM" : t >= 35 ? "WARNING" : "NORMAL")) : "No valid temperature reading";
    $("tempBadge").textContent = safe(d.temperatureStatus, valid ? "NORMAL" : "SENSOR_ERROR");
    const hasTruckCoords = d.gpsFix && Number.isFinite(Number(d.latitude)) && Number.isFinite(Number(d.longitude));
    if (!phoneLocationMode) {
      $("gpsStatus").textContent = hasTruckCoords ? "Truck GPS fix" : "Searching";
      $("gpsDot").className = "dot " + (hasTruckCoords ? "good" : "bad");
      $("coordinates").textContent = hasTruckCoords ? `${Number(d.latitude).toFixed(6)}, ${Number(d.longitude).toFixed(6)}` : "Coordinates unavailable";
      $("locationSource").textContent = safe(d.locationSource);
      $("openMap").href = hasTruckCoords ? `https://maps.google.com/?q=${d.latitude},${d.longitude}` : "#";
      $("openMap").style.pointerEvents = hasTruckCoords ? "auto" : "none";
      $("locationNote").textContent = hasTruckCoords ? "Showing the truck's ESP32 GPS location." : "Truck GPS is not available. Tap “Use mobile GPS” to show this phone's location instead.";
      if (hasTruckCoords) updateMap(Number(d.latitude), Number(d.longitude));
    }
    $("speed").textContent = `${Number(d.speedKmph || 0).toFixed(1)}`;
    $("lastUpdate").textContent = fmtTime(d.timestamp);
    $("wifiStatus").textContent = d.wifiConnected ? "Connected" : "Offline";
    $("sensorStatus").textContent = valid ? "OK" : "Error";
    $("satellites").textContent = safe(d.satellites, "0");
    const alert = $("alertBox");
    if (!valid) { alert.className = "alert bad"; alert.textContent = "Temperature sensor is not providing a valid reading."; }
    else if (t >= 40) { alert.className = "alert bad"; alert.textContent = "ALARM: Temperature has reached the configured alarm threshold (40°C). Verify your approved cold-chain limits."; }
    else if (t >= 35) { alert.className = "alert warn"; alert.textContent = "WARNING: Temperature has reached the configured warning threshold (35°C)."; }
    else { alert.className = "alert good"; alert.textContent = "No temperature threshold alert. Confirm these prototype thresholds match your approved requirements."; }
  }
  function updateMap(lat, lng) {
    $("mapPlaceholder").style.display = "none";
    $("map").style.display = "block";
    if (!window.L) { $("mapPlaceholder").style.display = "grid"; $("mapPlaceholder").textContent = "Map library unavailable. Use Open map."; return; }
    if (!map) {
      map = L.map("map").setView([lat,lng], 15);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {maxZoom:19, attribution:'&copy; OpenStreetMap contributors'}).addTo(map);
      marker = L.marker([lat,lng]).addTo(map).bindPopup("Milk truck");
    } else { marker.setLatLng([lat,lng]); map.setView([lat,lng], Math.max(map.getZoom(), 14)); }
  }
  function renderHistory(snap) {
    const data = snap.val();
    const rows = [];
    if (data && typeof data === "object") {
      Object.entries(data).map(([key,val]) => ({key,...(val || {})}))
        .sort((a,b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
        .reverse().slice(0,12).forEach(d => {
          const tr = document.createElement("tr");
          [fmtTime(d.timestamp), d.temperatureC == null ? "—" : `${Number(d.temperatureC).toFixed(2)}°C`,
           d.gpsFix ? "Fix" : "No fix", safe(d.temperatureStatus, "—")].forEach(text => {
             const td = document.createElement("td"); td.textContent = text; tr.appendChild(td);
           });
          rows.push(tr);
        });
    }
    const body = $("historyRows"); body.replaceChildren();
    if (!rows.length) { const tr=document.createElement("tr"),td=document.createElement("td");td.colSpan=4;td.textContent="No history records found.";tr.appendChild(td);body.appendChild(tr);return; }
    rows.forEach(r => body.appendChild(r));
  }
  function addMessage(text, who) {
    const div = document.createElement("div"); div.className = `bubble ${who}`; div.textContent = text;
    $("chatLog").appendChild(div); $("chatLog").scrollTop = $("chatLog").scrollHeight;
  }
  function botReply(input) {
    const q = input.toLowerCase();
    if (/temp|temperature|cold|milk/.test(q)) {
      if (!latest) return "I haven't received a truck record yet. Check Firebase connection and make sure the ESP32 uploads to /trucks/<truckId>/latest.";
      return `Latest temperature: ${latest.temperatureC == null ? "unavailable" : Number(latest.temperatureC).toFixed(2) + "°C"}. Status: ${latest.temperatureStatus || "unknown"}. The 35°C warning and 40°C alarm are prototype settings, not validated milk-safety limits.`;
    }
    if (/gps|location|map|coordinate|satellite/.test(q)) {
      if (!latest) return "No truck record is loaded yet. Once the ESP32 uploads GPS fields, I can report the status.";
      return latest.gpsFix ? `GPS fix available. Latitude ${latest.latitude}, longitude ${latest.longitude}; satellites: ${latest.satellites ?? "unknown"}.` : "No valid GPS fix is in the latest record. Place the GPS antenna with a clear view of the sky and wait for a fix. A phone hotspot provides internet, not the phone's GPS coordinates.";
    }
    if (/wifi|internet|offline|connect/.test(q)) return `Dashboard connection: ${db ? "connected to Firebase" : "not connected"}. Latest device Wi-Fi field: ${latest?.wifiConnected ? "connected" : "not connected or no record"}. Check hotspot range, SSID/password, and Serial Monitor.`;
    if (/alert|alarm|threshold|warning/.test(q)) return "The dashboard displays the firmware's temperatureStatus and also highlights temperatures at 35°C (warning) and 40°C (alarm). These are configurable prototype thresholds; use limits approved for your specific milk transport process.";
    if (/update|not working|troubleshoot|error|failed|problem/.test(q)) return "Troubleshooting: (1) confirm Serial Monitor says “Latest record saved”; (2) check Firebase /trucks/<truckId>/latest; (3) ensure the website uses the same project, truck ID, and authenticated user; (4) inspect browser console and database rules if reads are denied.";
    if (/help|what can you do|hello|hi\b/.test(q)) return "I can explain temperature, GPS, alerts, Wi-Fi, Firebase upload troubleshooting, and how this dashboard works. I use built-in rules and do not call an external AI service.";
    return "I can help with temperature, GPS/location, Wi-Fi, alerts, Firebase writes, or dashboard troubleshooting. Try asking “What is the temperature?” or “Is GPS working?”";
  }
  $("mobileGpsBtn").addEventListener("click", () => {
    if (!("geolocation" in navigator)) {
      $("locationNote").textContent = "This browser does not support location services.";
      return;
    }
    if (location.protocol !== "https:" && location.hostname !== "localhost") {
      $("locationNote").textContent = "Phone GPS permission requires HTTPS. Deploy this website to Vercel and open its HTTPS URL.";
      return;
    }
    $("locationNote").textContent = "Requesting permission to use this phone's location…";
    navigator.geolocation.getCurrentPosition(pos => {
      const lat = pos.coords.latitude, lng = pos.coords.longitude;
      phoneLocationMode = true;
      $("gpsStatus").textContent = "Phone GPS fix";
      $("gpsDot").className = "dot good";
      $("coordinates").textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
      $("locationSource").textContent = "mobile-phone";
      $("openMap").href = `https://maps.google.com/?q=${lat},${lng}`;
      $("openMap").style.pointerEvents = "auto";
      $("locationNote").textContent = "Showing this phone's GPS location. This does not change the ESP32 truck location saved in Firebase.";
      updateMap(lat, lng);
      addMessage("Phone GPS location is now shown on the map. This is the phone's position, not necessarily the truck's position.", "bot");
    }, err => {
      $("locationNote").textContent = err.code === 1 ? "Location permission denied. Allow location access in your browser settings and try again." : "Could not get phone location. Check device location services and try again.";
    }, {enableHighAccuracy:true, timeout:15000, maximumAge:5000});
  });

  $("chatForm").addEventListener("submit", e => {
    e.preventDefault(); const input = $("chatInput").value.trim(); if (!input) return;
    addMessage(input, "user"); addMessage(botReply(input), "bot"); $("chatInput").value = "";
  });
  document.querySelectorAll("[data-prompt]").forEach(b => b.addEventListener("click", () => {
    $("chatInput").value = b.dataset.prompt; $("chatForm").requestSubmit();
  }));
  $("settingsBtn").addEventListener("click", () => { fillForm(readConfig() || {}); dialog.showModal(); });
  $("settingsForm").addEventListener("submit", async e => {
    e.preventDefault(); const c = configFromForm();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
    await connect(c);
  });
  $("clearSettings").addEventListener("click", () => {
    localStorage.removeItem(STORAGE_KEY); stopListeners(); fillForm(); setConnection("Settings cleared"); $("uploadStatus").textContent="Reconnect using Firebase settings"; 
  });
  $("refreshBtn").addEventListener("click", () => {
    const c = readConfig(); if (c) connect(c); else { fillForm(); dialog.showModal(); }
  });
  window.addEventListener("online", () => { const c=readConfig(); if(c) connect(c); });
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferredInstall=e; $("installBtn").hidden=false; });
  $("installBtn").addEventListener("click", async () => {
    if (!deferredInstall) return; deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall=null; $("installBtn").hidden=true;
  });
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(err => console.warn("PWA service worker:", err)));
  }
  const saved = readConfig();
  if (saved) { fillForm(saved); connect(saved); } else { fillForm(); setConnection("Setup required"); setTimeout(() => dialog.showModal(), 400); }
})();