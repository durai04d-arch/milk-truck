/* Milk Truck Live dashboard. Firebase web config is entered by the user in Settings. */
(() => {
  const $ = id => document.getElementById(id);
  const STORAGE_KEY = "milkTruckDashboardConfigV1";
  let db = null, auth = null, latestRef = null, historyRef = null, latest = null;
  let map = null, marker = null, deferredInstall = null, phoneLocationMode = true, gpsWatchId = null, lastTempAlertState = "";
  let currentDevicePosition = null, locationTrail = [], trailLine = null, lastMovementState = "Unknown";
  let historyRecords = [], currentRisk = null, lastRiskKey = "", audioContext = null, soundEnabled = false, soundLoopTimer = null;
  const LOCATION_HISTORY_KEY = "milkTruckDeviceLocationHistoryV1";
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
      historyRef.limitToLast(500).on("value", renderHistory, err => console.warn("History read:", err.message));
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

  const RISK = {
    SAFE: {label:"SAFE", message:"Temperature below 6°C. Normal monitoring.", css:"good"},
    MONITORING: {label:"MONITORING", message:"Temperature is at or above 6°C; watching trend and exposure duration.", css:"warn"},
    WARNING: {label:"WARNING", message:"Fast temperature rise detected (≥0.4°C per sample) while temperature is ≥6°C.", css:"warn"},
    ALERT: {label:"ALERT", message:"Temperature is 7.5–9°C or exposure at/above 6°C has reached 10 minutes.", css:"warn"},
    CRITICAL: {label:"CRITICAL", message:"Temperature is ≥9°C or exposure at/above 6°C has reached 30 minutes.", css:"bad"},
    SENSOR_ERROR: {label:"SENSOR ERROR", message:"Temperature sensor is not providing a valid reading.", css:"bad"}
  };
  function timestampMs(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return NaN;
    return n < 1e12 ? n * 1000 : n;
  }
  function classifyRisk(records) {
    const sorted = (records || [])
      .filter(r => r && r.temperatureC !== null && r.temperatureC !== undefined && r.temperatureC !== "" &&
                   Number.isFinite(Number(r.temperatureC)) && Number.isFinite(timestampMs(r.timestamp)))
      .map(r => ({t:Number(r.temperatureC), ms:timestampMs(r.timestamp)}))
      .sort((a,b) => a.ms-b.ms)
      .filter((r,i,a) => i === 0 || r.ms !== a[i-1].ms);
    if (!sorted.length) return {level:"SENSOR_ERROR", exposureMs:0, rise:0, temperature:NaN};
    const latestPoint = sorted[sorted.length-1];
    const previous = sorted.length > 1 ? sorted[sorted.length-2] : null;
    let exposureMs = 0;
    for (let i=1; i<sorted.length; i++) {
      const prev=sorted[i-1], cur=sorted[i], gap=cur.ms-prev.ms;
      // Only accumulate exposure across observed consecutive samples; a gap over 10 minutes
      // breaks continuity because the temperature during that gap is unknown.
      if (cur.t >= 6 && prev.t >= 6 && gap > 0 && gap <= 10*60*1000) exposureMs += gap;
    }
    const rise = previous ? latestPoint.t-previous.t : 0;
    let level = "SAFE";
    if (latestPoint.t >= 9 || exposureMs >= 30*60*1000) level = "CRITICAL";
    else if (latestPoint.t >= 7.5 || exposureMs >= 10*60*1000) level = "ALERT";
    else if (latestPoint.t >= 6 && latestPoint.t < 7.5 && previous && previous.t >= 6 && rise >= 0.4) level = "WARNING";
    else if (latestPoint.t >= 6) level = "MONITORING";
    return {level, exposureMs, rise, temperature:latestPoint.t, timestamp:latestPoint.ms};
  }
  function playTone(freq, durationMs, volume=0.12) {
    if (!soundEnabled) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioContext = audioContext || new Ctx();
      if (audioContext.state === "suspended") audioContext.resume();
      const osc=audioContext.createOscillator(), gain=audioContext.createGain();
      osc.type="sine"; osc.frequency.value=freq; gain.gain.value=volume;
      osc.connect(gain); gain.connect(audioContext.destination);
      osc.start(); osc.stop(audioContext.currentTime + durationMs/1000);
    } catch(e) { console.warn("Dashboard audio unavailable:", e); }
  }
  function stopSoundLoop() {
    if (soundLoopTimer) clearInterval(soundLoopTimer);
    soundLoopTimer = null;
  }
  function playRiskSound(level) {
    if (!soundEnabled) return;
    stopSoundLoop();
    const pattern = () => {
      if (level === "WARNING") { playTone(720,180); }
      else if (level === "ALERT") { playTone(850,180); setTimeout(()=>playTone(850,180),280); }
      else if (level === "CRITICAL") { playTone(980,260); setTimeout(()=>playTone(760,260),330); setTimeout(()=>playTone(980,260),660); }
    };
    pattern();
    if (level === "ALERT" || level === "CRITICAL") soundLoopTimer=setInterval(pattern, level==="CRITICAL" ? 2200 : 4500);
  }
  function updateRiskUI(records, latestRecord) {
    const all = (records || []).slice();
    if (latestRecord && latestRecord.timestamp != null) all.push(latestRecord);
    const result = classifyRisk(all);
    currentRisk = result;
    const meta = RISK[result.level] || RISK.SENSOR_ERROR;
    $("tempStatus").textContent = result.level === "MONITORING"
      ? `MONITORING · ≥6°C · exposure ${(result.exposureMs/60000).toFixed(1)} min`
      : result.level === "WARNING" ? `WARNING · rise +${result.rise.toFixed(2)}°C/sample`
      : result.level === "ALERT" ? `ALERT · exposure ${(result.exposureMs/60000).toFixed(1)} min`
      : result.level === "CRITICAL" ? `CRITICAL · exposure ${(result.exposureMs/60000).toFixed(1)} min`
      : meta.label;
    $("tempBadge").textContent = meta.label;
    const alert=$("alertBox");
    alert.className = `alert ${meta.css}`;
    alert.textContent = `${meta.label}: ${meta.message}` +
      (Number.isFinite(result.temperature) ? ` Current: ${result.temperature.toFixed(2)}°C.` : "");
    const riskKey = `${result.level}`;
    if (riskKey !== lastRiskKey) {
      if (["WARNING","ALERT","CRITICAL"].includes(result.level)) {
        notifyTemperature(`MilkGuard ${result.level}: ${result.temperature.toFixed(2)}°C`,
          `${meta.message} Exposure: ${(result.exposureMs/60000).toFixed(1)} minutes.`);
        playRiskSound(result.level);
      } else {
        stopSoundLoop();
        if (result.level === "SAFE") lastRiskKey = riskKey;
      }
      lastRiskKey = riskKey;
    }
    $("tempDot").className = "dot " + (result.level==="SAFE" ? "good" : result.level==="MONITORING" ? "" : "bad");
  }
  function updateSoundButton() {
    const btn=$("soundToggle");
    if (!btn) return;
    btn.textContent = soundEnabled ? "Sound alerts: ON" : "Enable sound alerts";
    btn.classList.toggle("sound-on", soundEnabled);
    btn.setAttribute("aria-pressed", String(soundEnabled));
  }

  async function notifyTemperature(title, body) {
    if (!("Notification" in window)) return;
    if (Notification.permission === "default") {
      try { await Notification.requestPermission(); } catch {}
    }
    if (Notification.permission === "granted") {
      try { new Notification(title, { body, icon: "./icons/icon-192.png", tag: "milk-truck-temperature-alert", renotify: true }); }
      catch (e) { console.warn("Browser notification unavailable:", e); }
    }
  }

  async function saveGpsLocationToFirebase(lat, lng, accuracy, timestamp) {
    if (!db) {
      $("locationNote").textContent = "GPS coordinates acquired, but Firebase is not connected; location was not saved.";
      return false;
    }
    const c = readConfig();
    const truckId = c && c.truckId ? c.truckId : "milkTruck01";
    const record = {
      latitude: Number(lat),
      longitude: Number(lng),
      accuracyMeters: accuracy == null ? null : Number(accuracy),
      timestamp: Number(timestamp || Date.now()),
      locationName: "GPS"
    };
    try {
      await db.ref(`trucks/${truckId}/gpsLocation`).set(record);
      await db.ref(`trucks/${truckId}/gpsLocationHistory`).push(record);
      $("locationNote").textContent = "GPS coordinates displayed and saved to Firebase.";
      return true;
    } catch (err) {
      console.warn("Could not save GPS location:", err);
      $("locationNote").textContent = "GPS coordinates are displayed, but Firebase could not save them. Check database rules.";
      return false;
    }
  }

  function loadLocationTrail() {
    try { locationTrail = JSON.parse(localStorage.getItem(LOCATION_HISTORY_KEY) || "[]"); } catch { locationTrail = []; }
    if (!Array.isArray(locationTrail)) locationTrail = [];
  }
  function saveLocationPoint(lat, lng, accuracy) {
    const point = {lat, lng, accuracy: accuracy || null, timestamp: Date.now()};
    const last = locationTrail[locationTrail.length - 1];
    if (!last || Math.abs(last.lat-lat) > 0.00001 || Math.abs(last.lng-lng) > 0.00001 || point.timestamp-last.timestamp > 60000) {
      locationTrail.push(point);
      locationTrail = locationTrail.slice(-500);
      try { localStorage.setItem(LOCATION_HISTORY_KEY, JSON.stringify(locationTrail)); } catch {}
      renderLocationTrail();
    }
  }
  function renderLocationTrail() {
    if (!map || !window.L || !locationTrail.length) return;
    const points = locationTrail.map(p => [p.lat,p.lng]);
    if (trailLine) trailLine.remove();
    trailLine = L.polyline(points, {color:"#5de1d0", weight:4, opacity:.8}).addTo(map);
  }
  function updateMovementStatus(lat, lng, timestamp) {
    const prev = locationTrail.length ? locationTrail[locationTrail.length-1] : null;
    if (prev && timestamp > prev.timestamp) {
      const rad = x => x*Math.PI/180;
      const dLat=rad(lat-prev.lat), dLng=rad(lng-prev.lng);
      const a=Math.sin(dLat/2)**2+Math.cos(rad(prev.lat))*Math.cos(rad(lat))*Math.sin(dLng/2)**2;
      const km=6371*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
      const hours=(timestamp-prev.timestamp)/3600000;
      const kmh=hours>0 ? km/hours : 0;
      lastMovementState = kmh >= 3 ? "Running" : "Standing";
    } else if (!prev) lastMovementState = "Collecting GPS";
    $("movementStatus").textContent = lastMovementState;
  }
  function drawTemperatureChart(history) {
    const canvas=$("temperatureChart"); if (!canvas) return;
    const ctx=canvas.getContext("2d"); if (!ctx) return;
    const w=canvas.clientWidth || 600, h=260, dpr=window.devicePixelRatio||1;
    canvas.width=w*dpr; canvas.height=h*dpr; ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,w,h);
    const values=(history||[]).filter(x=>Number.isFinite(Number(x.temperatureC))).slice(-30);
    if (!values.length) { ctx.fillStyle="#94a9bf"; ctx.font="14px system-ui"; ctx.fillText("Temperature history will appear after records load.",16,32); $("chartSummary").textContent="No readings"; return; }
    const temps=values.map(x=>Number(x.temperatureC)), min=Math.min(...temps,6)-1, max=Math.max(...temps,6)+1;
    const left=42,right=12,top=16,bottom=34, cw=w-left-right,ch=h-top-bottom;
    ctx.font="11px system-ui"; ctx.strokeStyle="#2a4057"; ctx.fillStyle="#94a9bf"; ctx.lineWidth=1;
    for(let i=0;i<5;i++){const y=top+ch*i/4;ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(w-right,y);ctx.stroke();ctx.fillText((max-(max-min)*i/4).toFixed(1),3,y+4);}
    const thresholdY=top+ch*(max-6)/(max-min);ctx.setLineDash([5,4]);ctx.strokeStyle="#ffca70";ctx.beginPath();ctx.moveTo(left,thresholdY);ctx.lineTo(w-right,thresholdY);ctx.stroke();ctx.setLineDash([]);
    ctx.strokeStyle="#5de1d0";ctx.lineWidth=2.5;ctx.beginPath();
    temps.forEach((t,i)=>{const x=left+(values.length===1?cw/2:cw*i/(values.length-1));const y=top+ch*(max-t)/(max-min);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);});
    ctx.stroke();ctx.fillStyle="#70a7ff";
    temps.forEach((t,i)=>{const x=left+(values.length===1?cw/2:cw*i/(values.length-1));const y=top+ch*(max-t)/(max-min);ctx.beginPath();ctx.arc(x,y,3,0,Math.PI*2);ctx.fill();});
    ctx.fillStyle="#94a9bf";ctx.fillText(fmtTime(values[0].timestamp),left,h-9);const last=values[values.length-1];const lastLabel=fmtTime(last.timestamp);ctx.fillText(lastLabel,Math.max(left,w-right-ctx.measureText(lastLabel).width),h-9);
    const latestTemp=temps[temps.length-1];$("chartSummary").textContent=`Latest ${latestTemp.toFixed(2)}°C · ${values.length} readings`;
  }

  function renderLatest(d) {
    const t = Number(d.temperatureC);
    const valid = d.temperatureValid !== false && d.temperatureC !== null && d.temperatureC !== undefined && d.temperatureC !== "" && Number.isFinite(t);
    $("temperature").textContent = valid ? `${t.toFixed(2)}°C` : "Sensor error";
    if (valid) updateRiskUI(historyRecords, d);
    else updateRiskUI([], null);

    const hasTruckCoords = d.gpsFix && Number.isFinite(Number(d.latitude)) && Number.isFinite(Number(d.longitude));
    if (!phoneLocationMode) {
      $("gpsStatus").textContent = hasTruckCoords ? "Truck GPS fix" : "Searching";
      $("gpsDot").className = "dot " + (hasTruckCoords ? "good" : "bad");
      $("coordinates").textContent = hasTruckCoords ? `${Number(d.latitude).toFixed(6)}, ${Number(d.longitude).toFixed(6)}` : "Coordinates unavailable";
      $("locationSource").textContent = "GPS";
      $("openMap").href = hasTruckCoords ? `https://maps.google.com/?q=${d.latitude},${d.longitude}` : "#";
      $("openMap").style.pointerEvents = hasTruckCoords ? "auto" : "none";
      $("locationNote").textContent = hasTruckCoords ? "Showing the truck GPS coordinates." : "Truck GPS is not available. Allow GPS access on this device.";
      if (hasTruckCoords) updateMap(Number(d.latitude), Number(d.longitude));
    }
    $("speed").textContent = `${Number(d.speedKmph || 0).toFixed(1)}`;
    $("lastUpdate").textContent = fmtTime(d.timestamp);
    $("wifiStatus").textContent = d.wifiConnected ? "Connected" : "Offline";
    $("sensorStatus").textContent = valid ? "OK" : "Error";
    $("satellites").textContent = safe(d.satellites, "0");
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
    renderLocationTrail();
  }
  function historyTemperatureStatus(d, priorRecords) {
    const result=classifyRisk([...(priorRecords || []), d]);
    return result.level === "MONITORING" ? "MONITORING (≥6°C)" : result.level;
  }

  function renderHistory(snap) {
    const data = snap.val();
    const allRecords = data && typeof data === "object"
      ? Object.entries(data).map(([key,val]) => ({key,...(val || {})})).sort((a,b)=>timestampMs(a.timestamp)-timestampMs(b.timestamp))
      : [];
    historyRecords = allRecords;
    const displayRecords = allRecords.slice(-20).reverse();
    const rows = [];
    displayRecords.forEach((d, index) => {
      const tr=document.createElement("tr");
      const recordHasGps=d.gpsFix && Number.isFinite(Number(d.latitude)) && Number.isFinite(Number(d.longitude));
      const gpsText=recordHasGps ? `${Number(d.latitude).toFixed(5)}, ${Number(d.longitude).toFixed(5)}` :
        (currentDevicePosition ? `${currentDevicePosition.lat.toFixed(5)}, ${currentDevicePosition.lng.toFixed(5)}` : "Waiting for GPS");
      const prior=allRecords.filter(r=>timestampMs(r.timestamp)<=timestampMs(d.timestamp));
      const status=historyTemperatureStatus(d, prior.slice(-500));
      [fmtTime(d.timestamp), d.temperatureC==null ? "—" : `${Number(d.temperatureC).toFixed(2)}°C`, gpsText, status].forEach(text=>{
        const td=document.createElement("td"); td.textContent=text; tr.appendChild(td);
      });
      rows.push(tr);
    });
    const body=$("historyRows"); body.replaceChildren();
    if (!rows.length) { const tr=document.createElement("tr"),td=document.createElement("td");td.colSpan=4;td.textContent="No history records found.";tr.appendChild(td);body.appendChild(tr); }
    else rows.forEach(r=>body.appendChild(r));
    drawTemperatureChart(allRecords.slice(-120));
    if (latest) updateRiskUI(historyRecords, latest);
  }
  function addMessage(text, who) {
    const div = document.createElement("div"); div.className = `bubble ${who}`; div.textContent = text;
    $("chatLog").appendChild(div); $("chatLog").scrollTop = $("chatLog").scrollHeight;
  }
  function botReply(input) {
    const q = input.toLowerCase();
    if (/temperature issue|temp issue|any temperature|temperature problem/.test(q)) {
      if (!latest || latest.temperatureC == null) return "No valid temperature reading is available yet. Check the DS18B20 sensor and Firebase latest record.";
      const t=Number(latest.temperatureC);
      const risk=currentRisk || classifyRisk(historyRecords.concat([latest]));
      return `Current temperature: ${t.toFixed(2)}°C. Risk level: ${risk.level}. Exposure at/above 6°C: ${(risk.exposureMs/60000).toFixed(1)} minutes. ${RISK[risk.level].message}`;
    }
    if (/location history|track.*location|route history/.test(q)) {
      return locationTrail.length ? `This browser has ${locationTrail.length} saved GPS points. The map draws the available location trail. Latest GPS coordinates and a history of GPS points are also saved in Firebase under trucks/${(readConfig()||{}).truckId || "milkTruck01"}/gpsLocation and gpsLocationHistory.` : "No location history has been collected yet. Allow GPS access, keep the dashboard open, and ensure Firebase is connected.";
    }
    if (/standing|running|moving|truck status/.test(q)) {
      return `Movement status: ${lastMovementState}. This is estimated from changes in the browser device's GPS position, so it describes the device carrying the dashboard, not necessarily the truck. Reliable truck status requires GPS coordinates/speed from the ESP32 or a device physically in the truck.`;
    }
    if (/temp|temperature|cold|milk/.test(q)) {
      if (!latest) return "I haven't received a truck record yet. Check Firebase connection and make sure the ESP32 uploads to /trucks/<truckId>/latest.";
      const risk=currentRisk || classifyRisk(historyRecords.concat([latest]));
      return `Latest temperature: ${latest.temperatureC == null ? "unavailable" : Number(latest.temperatureC).toFixed(2) + "°C"}. Rural MilkGuard risk: ${risk.level}. Exposure ≥6°C: ${(risk.exposureMs/60000).toFixed(1)} minutes. ${RISK[risk.level].message}`;
    }
    if (/gps|location|map|coordinate|satellite/.test(q)) {
      if (!latest) return "No truck record is loaded yet. Once the ESP32 uploads GPS fields, I can report the status.";
      return latest.gpsFix ? `GPS fix available. Latitude ${latest.latitude}, longitude ${latest.longitude}; satellites: ${latest.satellites ?? "unknown"}.` : "No valid GPS fix is in the latest record. Place the GPS antenna with a clear view of the sky and wait for a fix. A phone hotspot provides internet, not the phone's GPS coordinates.";
    }
    if (/wifi|internet|offline|connect/.test(q)) return `Dashboard connection: ${db ? "connected to Firebase" : "not connected"}. Latest device Wi-Fi field: ${latest?.wifiConnected ? "connected" : "not connected or no record"}. Check hotspot range, SSID/password, and Serial Monitor.`;
    if (/alert|alarm|threshold|warning|risk/.test(q)) return "Risk rules: SAFE below 6°C; WARNING at 6–7.5°C when the rise is at least 0.4°C per sample; ALERT at 7.5–9°C or after 10 minutes at/above 6°C; CRITICAL at/above 9°C or after 30 minutes at/above 6°C. Exposure resets when temperature falls below 6°C.";
    if (/update|not working|troubleshoot|error|failed|problem/.test(q)) return "Troubleshooting: (1) confirm Serial Monitor says “Latest record saved”; (2) check Firebase /trucks/<truckId>/latest; (3) ensure the website uses the same project, truck ID, and authenticated user; (4) inspect browser console and database rules if reads are denied.";
    if (/help|what can you do|hello|hi\b/.test(q)) return "I can explain temperature, GPS, alerts, Wi-Fi, Firebase upload troubleshooting, and how this dashboard works. I use built-in rules and do not call an external AI service.";
    return "I can help with temperature, GPS/location, Wi-Fi, alerts, Firebase writes, or dashboard troubleshooting. Try asking “What is the temperature?” or “Is GPS working?”";
  }
  function requestDeviceGPS() {
    if (!("geolocation" in navigator)) {
      $("locationNote").textContent = "This browser does not support GPS location services.";
      return;
    }
    if (location.protocol !== "https:" && location.hostname !== "localhost") {
      $("locationNote").textContent = "GPS permission requires HTTPS. Open this website using its secure HTTPS URL.";
      return;
    }
    $("locationNote").textContent = "Getting GPS coordinates…";
    navigator.geolocation.getCurrentPosition(pos => {
      const lat = pos.coords.latitude, lng = pos.coords.longitude;
      currentDevicePosition = {lat, lng, timestamp: Date.now()};
      updateMovementStatus(lat, lng, currentDevicePosition.timestamp);
      saveLocationPoint(lat, lng, pos.coords.accuracy);
      saveGpsLocationToFirebase(lat, lng, pos.coords.accuracy, currentDevicePosition.timestamp);
      phoneLocationMode = true;
      $("gpsStatus").textContent = "GPS fix";
      $("gpsDot").className = "dot good";
      $("coordinates").textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
      $("locationSource").textContent = "GPS";
      $("openMap").href = `https://maps.google.com/?q=${lat},${lng}`;
      $("openMap").style.pointerEvents = "auto";
      $("locationNote").textContent = "GPS coordinates are displayed on the map.";
      updateMap(lat, lng);
    }, err => {
      $("gpsStatus").textContent = "Searching";
      $("gpsDot").className = "dot bad";
      $("locationNote").textContent = err.code === 1
        ? "Location permission denied. Allow location access in your browser settings and refresh GPS."
        : "GPS coordinates unavailable. Check device location services and try again.";
    }, {enableHighAccuracy:true, timeout:20000, maximumAge:5000});
  }
  $("mobileGpsBtn").addEventListener("click", requestDeviceGPS);

  soundEnabled = localStorage.getItem("milkTruckSoundEnabled") === "true";
  updateSoundButton();
  $("soundToggle").addEventListener("click", async () => {
    soundEnabled = !soundEnabled;
    localStorage.setItem("milkTruckSoundEnabled", String(soundEnabled));
    if (soundEnabled) {
      const Ctx=window.AudioContext || window.webkitAudioContext;
      if (Ctx) { audioContext=audioContext || new Ctx(); try { await audioContext.resume(); } catch {} }
      playTone(620,100,0.08);
      if (currentRisk && ["WARNING","ALERT","CRITICAL"].includes(currentRisk.level)) playRiskSound(currentRisk.level);
    } else stopSoundLoop();
    updateSoundButton();
  });

  $("enableNotifications").addEventListener("click", async () => {
    if (!("Notification" in window)) return;
    try {
      const permission = await Notification.requestPermission();
      $("enableNotifications").textContent = permission === "granted" ? "Browser notifications enabled" : "Enable browser notifications";
      if (permission === "granted") new Notification("Milk Truck Live notifications enabled", {body:"You will be notified when a temperature alert is detected.", icon:"./icons/icon-192.png"});
    } catch (e) { console.warn("Notification permission:", e); }
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
  loadLocationTrail();
  const saved = readConfig();
  if (saved) { fillForm(saved); connect(saved); } else { fillForm(); setConnection("Setup required"); setTimeout(() => dialog.showModal(), 400); }
  // Automatically request the current device's GPS when the page starts.
  requestDeviceGPS();
})();