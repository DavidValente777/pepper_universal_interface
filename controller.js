// ─── Utilities ───────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function logError(source, message) {
  const time = new Date().toTimeString().slice(0, 8);
  document.getElementById("errorLogEmpty").style.display = "none";
  const el = document.createElement("div");
  el.className = "error-log-entry";
  el.textContent = `[${time}] ${source}: ${message}`;
  document.getElementById("errorLogEntries").prepend(el);

  const count = document.getElementById("errorLogEntries").children.length;
  document.getElementById("errorCount").textContent = count;
  document.getElementById("errorPlural").textContent = count === 1 ? "" : "s";
  const indicator = document.getElementById("errorIndicator");
  indicator.style.display = "";
  indicator.classList.remove("pulsing");
  void indicator.offsetWidth; // force reflow so animation restarts each time
  indicator.classList.add("pulsing");
}

function clearErrorLog() {
  document.getElementById("errorLogEntries").innerHTML = "";
  document.getElementById("errorLogEmpty").style.display = "";
  document.getElementById("errorIndicator").style.display = "none";
}

// ─── State ───────────────────────────────────────────────────────────────────

let currentFontSize = 110;
let currentColor = "#000000";
let currentImageData = null;
let timelineSteps = []; // [[block, ...], ...]: the blocks of a step start together
let playingStepIndex = -1; // step being played, -1 when idle
let draggedBlockId = null; // block being dragged in the timeline; null for any other drag (e.g. a file)
let isPlaying = false;
let playbackAborted = false;
let blockStates = {}; // block id -> { state: "playing"|"done"|"error"|"stopped", error }
let blockIdCounter = 0;
let isConnected = false;
let bridgeReconnecting = false; // bridge lost the robot and is reconnecting on its own
let connectInFlight = false; // a /connect request (manual or automatic) is running
let lastClientReconnect = 0;
let lastConnectedHostIp = null;
let lastConnectedPepperIp = null;

// ─── Robot Control ───────────────────────────────────────────────────────────

async function wakeUpRobot() {
  if (!isConnected) {
    alert("Connect to Pepper first.");
    return;
  }

  const btn = document.getElementById("wakeUpBtn");
  btn.disabled = true;
  btn.textContent = "Waking...";

  try {
    const response = await fetch("/wake-up", { method: "POST" });
    const result = await response.json();

    if (result.success) {
      updateRobotStatus("awake");
    } else {
      logError("Wake Up", result.error || "Unknown error");
    }
  } catch (error) {
    logError("Wake Up", error.message);
  }

  btn.disabled = false;
  btn.textContent = "Wake Up";
}

async function emergencyStop() {
  if (!isConnected) {
    alert("Connect to Pepper first.");
    return;
  }

  const btn = document.getElementById("emergencyStopBtn");
  btn.disabled = true;
  setDriveEnabled(false);

  try {
    const response = await fetch("/emergency-stop", { method: "POST" });
    const result = await response.json();

    if (result.success) {
      updateRobotStatus("resting");
    } else {
      logError("Emergency Stop", result.error || "Unknown error");
    }
  } catch (error) {
    logError("Emergency Stop", error.message);
  }

  btn.disabled = false;
}

function updateRobotStatus(status) {
  const indicator = document.getElementById("robotStatusIndicator");
  const text = document.getElementById("robotStatusText");

  indicator.className = "status-indicator";

  if (status === "awake") {
    indicator.classList.add("awake");
    text.textContent = "Awake";
  } else if (status === "resting") {
    indicator.classList.add("resting");
    text.textContent = "Resting";
  } else {
    text.textContent = "Unknown";
  }
}

// ─── Volume / Pitch / Brightness ─────────────────────────────────────────────

const SLIDERS = {
  volume: { slider: "volumeSlider", label: "volumeValue", endpoint: "/set-volume", format: (v) => v + "%" },
  pitch: { slider: "pitchSlider", label: "pitchValue", endpoint: "/set-pitch", format: (v) => v + "%" },
  brightness: { slider: "brightnessSlider", label: "brightnessValue", endpoint: "/set-brightness", format: (v) => v + "%" },
};
const sliderTimers = {};

function setSlidersEnabled(enabled) {
  Object.values(SLIDERS).forEach((cfg) => {
    document.getElementById(cfg.slider).disabled = !enabled;
    if (!enabled) document.getElementById(cfg.label).textContent = "–";
  });
}

async function loadRobotSettings() {
  try {
    const r = await fetch("/settings");
    const data = await r.json();
    if (!data.success) throw new Error(data.error || "Unknown error");
    if (typeof data.obstacleAvoidance === "boolean") {
      obstacleAvoidance = data.obstacleAvoidance;
      renderAvoidance();
      // e.g. the connection dropped while it was off: restore the safe default
      if (!obstacleAvoidance && !driveEnabled) setObstacleAvoidance(true);
    }
    Object.entries(SLIDERS).forEach(([key, cfg]) => {
      const slider = document.getElementById(cfg.slider);
      if (data[key] !== null && data[key] !== undefined) slider.value = data[key];
      document.getElementById(cfg.label).textContent = cfg.format(slider.value);
      slider.disabled = false;
    });
  } catch (error) {
    logError("Robot settings", error.message);
  }
}

async function sendSliderValue(key) {
  const cfg = SLIDERS[key];
  const value = parseInt(document.getElementById(cfg.slider).value);
  try {
    const r = await postJson(cfg.endpoint, { value });
    const result = await r.json();
    if (!result.success) logError(`Set ${key}`, result.error || "Unknown error");
  } catch (error) {
    logError(`Set ${key}`, error.message);
  }
}

// Live-update while dragging, but at most one request per 150 ms per slider
function onSliderInput(key) {
  const cfg = SLIDERS[key];
  document.getElementById(cfg.label).textContent = cfg.format(document.getElementById(cfg.slider).value);
  clearTimeout(sliderTimers[key]);
  sliderTimers[key] = setTimeout(() => sendSliderValue(key), 150);
}

function onConnected() {
  loadRobotSettings();
  loadMotionsFromRobot();
}

// ─── Connection ──────────────────────────────────────────────────────────────

function updateConnectionStatus(status, message) {
  const statusEl = document.getElementById("connectionStatus");
  const dotEl = statusEl.querySelector(".status-dot");
  const textEl = statusEl.querySelector("span:last-child");

  statusEl.className = "connection-status " + status;
  dotEl.className = "status-dot " + status;
  textEl.textContent = message;
}

function updateIpDisplay(hostIp, pepperIp) {
  const ipDisplay = document.getElementById("ipDisplay");
  if (hostIp && pepperIp) {
    document.getElementById("displayHostIp").textContent = hostIp;
    document.getElementById("displayPepperIp").textContent = pepperIp;
    ipDisplay.style.display = "flex";
  } else {
    ipDisplay.style.display = "none";
  }
}

function setConnectButton(connected) {
  const btn = document.getElementById("connectBtn");
  btn.textContent = connected ? "Disconnect" : "Connect";
  btn.classList.toggle("disconnect", connected);
}

// Remember the robot across page reloads and bridge restarts
const CONNECTION_STORAGE_KEY = "pepperConnection";

function saveConnection(hostIp, pepperIp, wanted) {
  try {
    localStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify({ hostIp, pepperIp, wanted }));
  } catch (e) {}
}

function loadConnection() {
  try {
    return JSON.parse(localStorage.getItem(CONNECTION_STORAGE_KEY)) || {};
  } catch (e) {
    return {};
  }
}

// Battery in the top bar: green above 50%, amber 20-50%, red below 20%
function updateBattery(level, charging) {
  const el = document.getElementById("batteryIndicator");
  if (!el) return; // a cached older controller.html has no indicator
  const known = typeof level === "number";
  el.textContent = known ? `🔋 ${level}%${charging ? " ⚡" : ""}` : "🔋 –";
  el.className = "battery-indicator " + (!known ? "unknown" : level > 50 ? "good" : level >= 20 ? "medium" : "low");
  el.title = known ? `Pepper's battery: ${level}%${charging ? ", charging" : ""}` : "Pepper's battery (not connected)";
}

function markDisconnected() {
  updateBattery(null);
  if (!isConnected) return;
  isConnected = false;
  setSlidersEnabled(false);
  setDriveEnabled(false);
}

function markConnected(hostIp, pepperIp, message) {
  lastConnectedHostIp = hostIp;
  lastConnectedPepperIp = pepperIp;
  saveConnection(hostIp, pepperIp, true);
  updateConnectionStatus("connected", message);
  updateIpDisplay(hostIp, pepperIp);
  setConnectButton(true);
  const wasConnected = isConnected;
  isConnected = true;
  if (!wasConnected) onConnected();
}

// Used when the bridge itself was restarted and no longer knows the robot
async function clientReconnect() {
  if (connectInFlight || Date.now() - lastClientReconnect < 10000) return;
  const { hostIp, pepperIp } = loadConnection();
  if (!hostIp || !pepperIp) return;
  connectInFlight = true;
  lastClientReconnect = Date.now();
  updateConnectionStatus("connecting", "Bridge restarted — reconnecting to Pepper automatically…");
  setConnectButton(true);
  try {
    const r = await postJson("/connect", { hostIp, pepperIp, reconnect: true });
    const result = await r.json();
    if (result.success && !loadConnection().wanted) {
      // Cancelled while this connect was in flight
      fetch("/disconnect", { method: "POST" }).catch(() => {});
    } else if (result.success) {
      markConnected(hostIp, pepperIp, "Connected to Pepper (reconnected automatically)");
    } else {
      updateConnectionStatus("connecting", `Reconnect failed (${result.error}) — retrying…`);
    }
  } catch (error) {
    updateConnectionStatus("error", "Can't reach the bridge server (bridge.py) — retrying…");
  }
  connectInFlight = false;
}

async function checkConnectionStatus() {
  if (connectInFlight) return; // a connect is running; its result updates the UI
  let data;
  try {
    const response = await fetch("/status");
    data = await response.json();
  } catch (error) {
    // The bridge process is down or unreachable; keep polling until it's back
    markDisconnected();
    bridgeReconnecting = false;
    if (loadConnection().wanted) {
      updateConnectionStatus("error", "Can't reach the bridge server (bridge.py) — retrying…");
    }
    return;
  }
  if (connectInFlight) return;

  if (data.connected) {
    if (typeof data.awake === "boolean") updateRobotStatus(data.awake ? "awake" : "resting");
    updateBattery(data.battery, data.charging);
    const recovered = bridgeReconnecting || !isConnected;
    bridgeReconnecting = false;
    document.getElementById("hostIp").value = data.hostIp || "";
    setPepperIp(data.pepperIp || "");
    markConnected(
      data.hostIp,
      data.pepperIp,
      recovered && lastConnectedPepperIp ? "Connected to Pepper (reconnected automatically)" : "Connected to Pepper",
    );
  } else if (data.reconnecting) {
    markDisconnected();
    bridgeReconnecting = true;
    const attempt = data.attempts ? ` (attempt ${data.attempts})` : "";
    const reason = data.lastError ? ` — ${data.lastError}` : "";
    updateConnectionStatus("connecting", `Connection lost — reconnecting automatically${attempt}${reason}`);
    updateIpDisplay(data.hostIp, data.pepperIp);
    setConnectButton(true); // lets the user cancel reconnecting
  } else if (!data.pepperIp && loadConnection().wanted) {
    markDisconnected();
    bridgeReconnecting = false;
    clientReconnect();
  } else {
    markDisconnected();
    bridgeReconnecting = false;
    updateConnectionStatus("disconnected", "Not connected — enter IP addresses above and click Connect");
    updateIpDisplay(null, null);
    setConnectButton(false);
  }
}

function getPepperIp() {
  return document.getElementById("pepperIp").value.trim();
}

function setPepperIp(ip) {
  document.getElementById("pepperIp").value = ip || "";
}

async function connect() {
  const hostIp = document.getElementById("hostIp").value.trim();
  const pepperIp = getPepperIp();

  if (!hostIp || !pepperIp) {
    alert("Please enter both IP addresses.");
    return;
  }

  const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (!ipRegex.test(hostIp) || !ipRegex.test(pepperIp)) {
    alert("Please enter valid IP addresses (e.g. 192.168.1.100).");
    return;
  }

  updateConnectionStatus("connecting", "Connecting to Pepper...");
  document.getElementById("connectBtn").disabled = true;
  connectInFlight = true;

  try {
    const result = await (await postJson("/connect", { hostIp, pepperIp })).json();

    if (result.success) {
      bridgeReconnecting = false;
      markConnected(hostIp, pepperIp, "Connected to Pepper");
    } else {
      saveConnection(hostIp, pepperIp, false);
      updateConnectionStatus("error", "Connection failed: " + result.error);
    }
  } catch (error) {
    updateConnectionStatus("error", "Connection error: " + error.message);
  }

  connectInFlight = false;
  document.getElementById("connectBtn").disabled = false;
}

async function disconnect() {
  setDriveEnabled(false);
  const { hostIp, pepperIp } = loadConnection();
  saveConnection(hostIp, pepperIp, false); // don't auto-reconnect after this
  try {
    await fetch("/disconnect", { method: "POST" });
    isConnected = false;
    bridgeReconnecting = false;
    setSlidersEnabled(false);
    updateConnectionStatus("disconnected", "Disconnected");
    updateIpDisplay(null, null);
    setConnectButton(false);
  } catch (error) {
    logError("Disconnect", error.message);
  }
}

function toggleConnection() {
  if (isConnected || bridgeReconnecting || connectInFlight) {
    disconnect();
  } else {
    connect();
  }
}

// ─── Startup ─────────────────────────────────────────────────────────────────

window.addEventListener("load", () => {
  // Pre-fill the last used addresses
  const saved = loadConnection();
  if (saved.hostIp && !document.getElementById("hostIp").value) document.getElementById("hostIp").value = saved.hostIp;
  if (saved.pepperIp && !getPepperIp()) setPepperIp(saved.pepperIp);
  checkConnectionStatus();
});

// Poll all the time (not only while connected) so drops, automatic
// reconnects and bridge restarts are always reflected
setInterval(checkConnectionStatus, 3000);

// ─── Instant Send ────────────────────────────────────────────────────────────

async function speak() {
  const text = document.getElementById("speechText").value.trim();
  if (!text) {
    alert("Enter text for Pepper to say.");
    return;
  }

  try {
    const response = await fetch("/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text }),
    });
    if (!response.ok) logError("Speech", await response.text());
  } catch (error) {
    logError("Speech", error.message);
  }
}

async function sendTextToTablet() {
  const text = document.getElementById("msg").value.trim();
  if (!text) return;

  const params = new URLSearchParams({
    text: text,
    fontSize: currentFontSize,
    color: currentColor,
  });

  try {
    const r = await fetch("/send?" + params.toString());
    if (!r.ok) logError("Text Display", await r.text());
  } catch (error) {
    logError("Text Display", error.message);
  }
}

// Removes everything from the tablet (text, image, video, webview)
async function clearScreen() {
  try {
    const r = await fetch("/clear-tablet", { method: "POST" });
    const result = await r.json();
    if (!result.success) logError("Clear Tablet", result.error || "Unknown error");
  } catch (error) {
    logError("Clear Tablet", error.message);
  }
}

// Pepper's tablet panel is 1280x800 physical pixels, so larger images are
// downscaled to fit it (keeping aspect ratio) before being sent. The tablet
// page then scales the image up/down to fill the screen.
const TABLET_W = 1280;
const TABLET_H = 800;

function loadImageForTablet(file, callback) {
  if (!file || !file.type.match(/image\/(jpeg|jpg|png)/)) {
    alert("Please select a JPG or PNG image.");
    return;
  }

  const img = new Image();
  img.onload = () => {
    let w = img.width,
      h = img.height;
    if (w > TABLET_W || h > TABLET_H) {
      const scale = Math.min(TABLET_W / w, TABLET_H / h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    // JPEG has no alpha: paint white first so transparent PNGs don't turn black
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    callback(canvas.toDataURL("image/jpeg", 0.85));
  };
  img.onerror = () => alert("Could not read that image file.");
  const reader = new FileReader();
  reader.onload = (e) => {
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function handleImageFile(file) {
  loadImageForTablet(file, (dataUrl) => {
    currentImageData = dataUrl;
    document.getElementById("previewImg").src = currentImageData;
    document.getElementById("dropZone").style.display = "none";
    document.getElementById("imagePreview").style.display = "block";
  });
}

async function sendImage() {
  if (!currentImageData) return;

  try {
    const response = await fetch("/send-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageData: currentImageData }),
    });
    if (!response.ok) logError("Image Display", await response.text());
  } catch (error) {
    logError("Image Display", error.message);
  }
}

function removeImage() {
  currentImageData = null;
  document.getElementById("imagePreview").style.display = "none";
  document.getElementById("imageInput").value = "";
  document.getElementById("dropZone").style.display = "";
}

async function playMotion() {
  const motionValue = motionPicker.value;

  if (!motionValue) {
    alert("Please select a motion first.");
    return;
  }

  try {
    const response = await fetch("/motion", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ motion: motionValue }),
    });
    if (!response.ok) logError("Motion", await response.text());
  } catch (error) {
    logError("Motion", error.message);
  }
}

async function stopMotion() {
  driveHeld.clear(); // the bridge also stops the wheels
  updateDriveUi();
  try {
    const response = await fetch("/stop-motion", { method: "POST" });
    if (!response.ok) logError("Stop Motion", await response.text());
  } catch (error) {
    logError("Stop Motion", error.message);
  }
}

// ─── Keyboard driving ────────────────────────────────────────────────────────

const DRIVE_KEYS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
const DRIVE_HEARTBEAT_MS = 200; // bridge stops the wheels after 600 ms of silence

let driveEnabled = false;
const driveHeld = new Set(); // arrow keys currently held (keyboard or on-screen pad)
let driveShift = false;
let driveInFlight = false;
let driveQueued = false;
let driveLastError = "";
let obstacleAvoidance = true;

// Q/E turn on the spot like ← → (without Shift); the on-screen pad has its
// own buttons for turning and sliding
const ROTATE_KEYS = { q: "RotateLeft", e: "RotateRight" };

function driveCommand() {
  const held = (key) => (driveHeld.has(key) ? 1 : 0);
  const clampUnit = (v) => Math.max(-1, Math.min(1, v));
  const arrowSide = held("ArrowLeft") - held("ArrowRight");
  return {
    x: held("ArrowUp") - held("ArrowDown"),
    y: clampUnit((driveShift ? arrowSide : 0) + held("SlideLeft") - held("SlideRight")),
    theta: clampUnit((driveShift ? 0 : arrowSide) + held("RotateLeft") - held("RotateRight")),
  };
}

function isMoving(cmd) {
  return cmd.x !== 0 || cmd.y !== 0 || cmd.theta !== 0;
}

function describeDrive(cmd) {
  const parts = [];
  if (cmd.x > 0) parts.push("forward");
  if (cmd.x < 0) parts.push("backward");
  if (cmd.y > 0) parts.push("sliding left");
  if (cmd.y < 0) parts.push("sliding right");
  if (cmd.theta > 0) parts.push("turning left");
  if (cmd.theta < 0) parts.push("turning right");
  return parts.join(" + ");
}

function setDriveStatus(state, text) {
  const el = document.getElementById("driveStatus");
  el.className = "drive-status " + state;
  el.textContent = text;
}

function updateDriveUi() {
  const cmd = driveCommand();
  document.querySelectorAll(".drive-key").forEach((btn) => {
    btn.classList.toggle("active", driveHeld.has(btn.dataset.key));
  });
  if (!driveEnabled) {
    setDriveStatus("off", "Off");
  } else if (driveLastError) {
    setDriveStatus("error", driveLastError);
  } else if (isMoving(cmd)) {
    setDriveStatus("moving", "Driving: " + describeDrive(cmd));
  } else {
    setDriveStatus("ready", "Ready — hold an arrow key or a pad button");
  }
}

// Sends the current command; never more than one request in flight
async function sendDrive() {
  if (driveInFlight) {
    driveQueued = true;
    return;
  }
  driveInFlight = true;
  // Belt and braces: once driving is switched off only a stop can be sent
  const cmd = driveEnabled ? driveCommand() : { x: 0, y: 0, theta: 0 };
  const speed = parseInt(document.getElementById("driveSpeedSlider").value) / 100;
  try {
    const r = await postJson("/drive", { ...cmd, speed });
    const result = await r.json();
    if (!result.success) throw new Error(result.error || "Unknown error");
    if (isMoving(cmd)) driveLastError = ""; // keep showing an error until a move succeeds
  } catch (error) {
    if (error.message !== driveLastError) logError("Drive", error.message);
    driveLastError = error.message;
    driveHeld.clear(); // don't keep retrying a failing move
  }
  driveInFlight = false;
  updateDriveUi();
  if (driveQueued) {
    driveQueued = false;
    sendDrive();
  }
}

function driveStop() {
  driveHeld.clear();
  updateDriveUi();
  if (driveEnabled) sendDrive();
}

function renderAvoidance() {
  const btn = document.getElementById("avoidanceToggleBtn");
  btn.textContent = "Obstacle avoidance: " + (obstacleAvoidance ? "ON" : "OFF");
  btn.classList.toggle("on", obstacleAvoidance);
  btn.setAttribute("aria-pressed", String(obstacleAvoidance));
  btn.disabled = !driveEnabled;
  document.getElementById("avoidanceWarning").hidden = obstacleAvoidance;
}

async function setObstacleAvoidance(enabled) {
  try {
    const result = await (await postJson("/set-obstacle-avoidance", { enabled })).json();
    if (!result.success) throw new Error(result.error || "Unknown error");
    obstacleAvoidance = enabled;
  } catch (error) {
    logError("Obstacle avoidance", error.message);
    if (!enabled) alert(error.message);
  }
  renderAvoidance();
}

function toggleObstacleAvoidance() {
  if (!driveEnabled) return;
  if (
    obstacleAvoidance &&
    !confirm("Turn OFF obstacle avoidance?\n\nPepper will drive into people, walls and objects without stopping. Only do this in a clear area.")
  ) {
    return;
  }
  setObstacleAvoidance(!obstacleAvoidance);
}

function setDriveEnabled(enabled) {
  if (enabled && !isConnected) {
    alert("Connect to Pepper first.");
    return;
  }
  const wasEnabled = driveEnabled;
  driveEnabled = enabled;
  driveHeld.clear();
  driveShift = false;
  driveLastError = "";
  const btn = document.getElementById("driveToggleBtn");
  btn.textContent = "Keyboard driving: " + (enabled ? "ON" : "OFF");
  btn.classList.toggle("on", enabled);
  btn.setAttribute("aria-pressed", String(enabled));
  document.getElementById("drivePanel").classList.toggle("enabled", enabled);
  if (enabled) {
    // Arrow keys would otherwise go to whatever field has focus
    if (document.activeElement) document.activeElement.blur();
  } else if (wasEnabled && isConnected) {
    fetch("/drive-stop", { method: "POST" }).catch(() => {});
    if (!obstacleAvoidance) setObstacleAvoidance(true); // "off" only lasts while driving
  }
  renderAvoidance();
  updateDriveUi();
}

// Arrow keys typed into a text field stay with that field
function isTypingTarget(el) {
  if (!el) return false;
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable) return true;
  return el.tagName === "INPUT" && !["range", "button", "checkbox", "color", "file"].includes(el.type);
}

function onDriveKeyDown(e) {
  if (!driveEnabled || isTypingTarget(e.target)) return;
  if (e.key === " " || e.key === "Escape") {
    e.preventDefault();
    driveStop();
    return;
  }
  const plainKey = !e.ctrlKey && !e.metaKey && !e.altKey; // leave browser shortcuts alone
  const rotateKey = plainKey && ROTATE_KEYS[e.key.toLowerCase()];
  if (e.key === "Shift") {
    driveShift = true;
  } else if (rotateKey) {
    e.preventDefault();
    if (driveHeld.has(rotateKey)) return; // key auto-repeat
    driveHeld.add(rotateKey);
  } else if (DRIVE_KEYS.includes(e.key)) {
    e.preventDefault(); // no page scrolling / slider changes while driving
    driveShift = e.shiftKey;
    if (driveHeld.has(e.key)) return; // key auto-repeat
    driveHeld.add(e.key);
  } else {
    return;
  }
  updateDriveUi();
  sendDrive();
}

function onDriveKeyUp(e) {
  if (!driveEnabled) return;
  const rotateKey = ROTATE_KEYS[e.key.toLowerCase()];
  if (e.key === "Shift") {
    driveShift = false;
  } else if (rotateKey) {
    e.preventDefault();
    if (!driveHeld.delete(rotateKey)) return;
  } else if (DRIVE_KEYS.includes(e.key)) {
    e.preventDefault();
    if (!driveHeld.delete(e.key)) return;
  } else {
    return;
  }
  updateDriveUi();
  sendDrive();
}

window.addEventListener("keydown", onDriveKeyDown, true);
window.addEventListener("keyup", onDriveKeyUp, true);
// Stop if the page loses focus (key-up events would be missed)
window.addEventListener("blur", () => driveEnabled && driveStop());
document.addEventListener("visibilitychange", () => document.hidden && driveEnabled && driveStop());

// Keep the watchdog fed while a key is held
setInterval(() => {
  if (driveEnabled && isMoving(driveCommand())) sendDrive();
}, DRIVE_HEARTBEAT_MS);

// ─── Camera feed ─────────────────────────────────────────────────────────────

// Frames are fetched one after another (never more than one in flight), so
// the frame rate adapts to the network and the robot's encoding speed
const CAMERA_RETRY_MS = 1000;
let cameraOn = false;
let cameraRun = 0; // bumps on every start/stop so an old loop ends itself
let cameraObjectUrl = null;

function setCameraStatus(text, isError) {
  const el = document.getElementById("cameraStatus");
  el.textContent = text;
  el.classList.toggle("error", !!isError);
}

function showCameraFrame(blob) {
  const img = document.getElementById("cameraImg");
  if (cameraObjectUrl) URL.revokeObjectURL(cameraObjectUrl);
  cameraObjectUrl = URL.createObjectURL(blob);
  img.src = cameraObjectUrl;
  img.hidden = false;
  document.getElementById("cameraPlaceholder").hidden = true;
}

function clearCameraFrame(text) {
  const img = document.getElementById("cameraImg");
  img.hidden = true;
  img.removeAttribute("src");
  if (cameraObjectUrl) URL.revokeObjectURL(cameraObjectUrl);
  cameraObjectUrl = null;
  const placeholder = document.getElementById("cameraPlaceholder");
  placeholder.textContent = text;
  placeholder.hidden = false;
}

async function cameraLoop(run) {
  let frames = 0;
  let since = performance.now();
  let lastError = "";
  while (cameraOn && run === cameraRun) {
    if (!isConnected) {
      setCameraStatus("Waiting for connection…");
      await new Promise((r) => setTimeout(r, CAMERA_RETRY_MS));
      continue;
    }
    const cam = document.getElementById("cameraSelect").value;
    try {
      const r = await fetch(`/camera?cam=${cam}&t=${Date.now()}`);
      if (!r.ok) {
        let message = `HTTP ${r.status}`;
        try {
          message = (await r.json()).error || message;
        } catch (e) {}
        throw new Error(message);
      }
      const blob = await r.blob();
      if (!cameraOn || run !== cameraRun) break;
      showCameraFrame(blob);
      lastError = "";
      frames += 1;
      const elapsed = performance.now() - since;
      if (elapsed >= 1000) {
        setCameraStatus(`${(frames / (elapsed / 1000)).toFixed(1)} fps`);
        frames = 0;
        since = performance.now();
      }
    } catch (error) {
      if (error.message !== lastError) logError("Camera", error.message);
      lastError = error.message;
      setCameraStatus(error.message, true);
      await new Promise((r) => setTimeout(r, CAMERA_RETRY_MS));
    }
  }
}

function setCameraEnabled(enabled) {
  cameraOn = enabled;
  cameraRun += 1;
  const btn = document.getElementById("cameraToggleBtn");
  btn.textContent = "Camera: " + (enabled ? "ON" : "OFF");
  btn.classList.toggle("on", enabled);
  btn.setAttribute("aria-pressed", String(enabled));
  if (enabled) {
    setCameraStatus("Starting…");
    clearCameraFrame("Connecting to camera…");
    cameraLoop(cameraRun);
  } else {
    setCameraStatus("");
    clearCameraFrame("Camera off");
    // Lets the bridge release the camera straight away
    if (isConnected) fetch("/camera-stop", { method: "POST" }).catch(() => {});
  }
}

// ─── Motion list from the robot ──────────────────────────────────────────────

// "animations/Stand/Emotions/Positive/Happy_4" -> group "Emotions / Positive", label "Happy 4"
// "boston_animation_library/Stand/bye_02" -> group "boston_animation_library", label "Stand / bye 02"
function motionGroupAndLabel(path) {
  const parts = path.split("/");
  const prettify = (s) => s.replace(/_/g, " ");
  if (parts[0] === "animations") {
    const rest = parts[1] === "Stand" ? parts.slice(2) : parts.slice(1);
    return {
      group: rest.length > 1 ? rest.slice(0, -1).join(" / ") : "Other",
      label: prettify(rest[rest.length - 1]),
    };
  }
  return {
    group: "App: " + parts[0],
    label: parts.slice(1).map(prettify).join(" / ") || parts[0],
  };
}

// ─── Motion picker (favourites + collapsible categories) ─────────────────────

const BUILTIN_MOTIONS = [
  ["Dances", "Hey", "animations/Stand/Gestures/Hey_1"],
  ["Dances", "Bow", "animations/Stand/Gestures/BowShort_1"],
  ["Dances", "Enthusiastic", "animations/Stand/Gestures/Enthusiastic_4"],
  ["Dances", "Excited", "animations/Stand/Gestures/Excited_1"],
  ["Dances", "Wake Up", "animations/Stand/Waiting/WakeUp_1"],
  ["Gestures", "Yes (nod)", "animations/Stand/Gestures/Yes_1"],
  ["Gestures", "No (shake)", "animations/Stand/Gestures/No_1"],
  ["Gestures", "Think", "animations/Stand/Gestures/Think_1"],
  ["Gestures", "Explain", "animations/Stand/Gestures/Explain_1"],
  ["Gestures", "Show Sky", "animations/Stand/Gestures/ShowSky_1"],
  ["Emotions", "Happy", "animations/Stand/Emotions/Positive/Happy_4"],
  ["Emotions", "Laugh", "animations/Stand/Emotions/Positive/Laugh_1"],
  ["Emotions", "Sad", "animations/Stand/Emotions/Negative/Sad_1"],
  ["Emotions", "Surprise", "animations/Stand/Emotions/Negative/Surprise_1"],
  ["Emotions", "Ask for attention", "animations/Stand/Emotions/Neutral/AskForAttention_1"],
  ["Reactions", "Shake body", "animations/Stand/Reactions/ShakeBody_1"],
  ["Reactions", "See something", "animations/Stand/Reactions/SeeSomething_1"],
  ["Reactions", "Touch head", "animations/Stand/Reactions/TouchHead_1"],
].map(([category, label, path]) => ({ category, label, path }));

const FAVOURITES_STORAGE_KEY = "pepperFavouriteMotions";
let motionCatalog = BUILTIN_MOTIONS; // [{ category, label, path }]
let favouriteMotions = loadFavouriteMotions(); // Set of paths
const motionPickers = [];

function loadFavouriteMotions() {
  try {
    return new Set(JSON.parse(localStorage.getItem(FAVOURITES_STORAGE_KEY)) || []);
  } catch (e) {
    return new Set();
  }
}

function toggleFavouriteMotion(path) {
  if (!favouriteMotions.delete(path)) favouriteMotions.add(path);
  try {
    localStorage.setItem(FAVOURITES_STORAGE_KEY, JSON.stringify([...favouriteMotions]));
  } catch (e) {
    // favourites then only last for this page load
  }
  motionPickers.forEach(renderMotionPicker);
}

// Group "Emotions / Positive" + label "Happy 4" -> category "Emotions", label "Positive / Happy 4"
function motionEntryFromPath(path) {
  const { group, label } = motionGroupAndLabel(path);
  const [category, ...sub] = group.split(" / ");
  return { category, label: [...sub, label].join(" / "), path };
}

function motionEntry(path) {
  return motionCatalog.find((m) => m.path === path) || motionEntryFromPath(path);
}

function buildMotionCatalog(animations, behaviors) {
  const entries = [...animations, ...behaviors].map(motionEntryFromPath);
  const isApp = (c) => c.startsWith("App: ");
  return entries.sort(
    (a, b) =>
      isApp(a.category) - isApp(b.category) ||
      a.category.localeCompare(b.category) ||
      a.label.localeCompare(b.label, undefined, { numeric: true })
  );
}

// Every search word must appear in the motion's label, category or path
function motionMatchesSearch(entry, words) {
  const text = `${entry.label} ${entry.category} ${entry.path}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

function motionSearchResults(picker) {
  const words = picker.query.toLowerCase().split(/\s+/).filter(Boolean);
  const extraFavourites = [...favouriteMotions]
    .filter((path) => !motionCatalog.some((m) => m.path === path))
    .map(motionEntry);
  return [...motionCatalog, ...extraFavourites].filter((entry) => motionMatchesSearch(entry, words));
}

function createMotionPicker(root) {
  const picker = { root, value: "", openCategory: null, query: "" };
  // The search box sits outside the list so re-rendering the list keeps its focus
  root.innerHTML = `
    <button type="button" class="motion-picker-trigger" aria-haspopup="listbox" aria-expanded="false">
      <span class="motion-picker-value"></span><span class="motion-picker-caret">▾</span>
    </button>
    <div class="motion-picker-menu" hidden>
      <label class="motion-picker-search">
        <span class="motion-picker-search-icon" aria-hidden="true">🔍</span>
        <input type="search" placeholder="Search motions…" aria-label="Search motions" autocomplete="off" />
      </label>
      <div class="motion-picker-list" role="listbox"></div>
    </div>`;
  picker.trigger = root.querySelector(".motion-picker-trigger");
  picker.menu = root.querySelector(".motion-picker-menu");
  picker.search = root.querySelector(".motion-picker-search input");
  picker.list = root.querySelector(".motion-picker-list");

  picker.trigger.addEventListener("click", () => setMotionPickerOpen(picker, picker.menu.hidden));
  picker.search.addEventListener("input", () => {
    picker.query = picker.search.value.trim();
    picker.list.scrollTop = 0;
    renderMotionPicker(picker);
  });
  picker.search.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !picker.query) return;
    e.preventDefault();
    const [first] = motionSearchResults(picker);
    if (!first) return;
    setMotionPickerValue(picker, first.path);
    setMotionPickerOpen(picker, false);
    picker.trigger.focus();
  });
  picker.menu.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const { action, path, category } = el.dataset;
    if (action === "star") {
      toggleFavouriteMotion(path);
    } else if (action === "category") {
      picker.openCategory = picker.openCategory === category ? null : category;
      renderMotionPicker(picker);
    } else if (action === "choose") {
      setMotionPickerValue(picker, path);
      setMotionPickerOpen(picker, false);
      picker.trigger.focus();
    }
  });
  motionPickers.push(picker);
  renderMotionPicker(picker);
  return picker;
}

function setMotionPickerValue(picker, path) {
  picker.value = path;
  renderMotionPicker(picker);
}

function setMotionPickerOpen(picker, open) {
  if (open) {
    motionPickers.forEach((p) => p !== picker && setMotionPickerOpen(p, false));
    // Show the selected motion's category straight away
    if (picker.value) picker.openCategory = motionEntry(picker.value).category;
  }
  // Each opening starts with an empty search
  picker.query = "";
  picker.search.value = "";
  picker.menu.hidden = !open;
  picker.trigger.setAttribute("aria-expanded", String(open));
  picker.root.classList.toggle("open", open);
  renderMotionPicker(picker);
  if (open) picker.search.focus();
}

function motionItemHtml(picker, entry, showCategory = false) {
  const fav = favouriteMotions.has(entry.path);
  const path = escapeHtml(entry.path);
  const category = showCategory ? `<span class="motion-picker-item-category">${escapeHtml(entry.category)}</span>` : "";
  return `
    <div class="motion-picker-item${entry.path === picker.value ? " selected" : ""}">
      <button type="button" class="motion-picker-star${fav ? " fav" : ""}" data-action="star" data-path="${path}"
        title="${fav ? "Remove from favourites" : "Add to favourites"}" aria-pressed="${fav}">${fav ? "★" : "☆"}</button>
      <button type="button" class="motion-picker-choose" data-action="choose" data-path="${path}" title="${path}">${escapeHtml(entry.label)}${category}</button>
    </div>`;
}

function renderMotionPicker(picker) {
  const valueEl = picker.trigger.querySelector(".motion-picker-value");
  if (picker.value) {
    const entry = motionEntry(picker.value);
    valueEl.textContent = (favouriteMotions.has(picker.value) ? "★ " : "") + entry.label;
    valueEl.classList.remove("placeholder");
  } else {
    valueEl.textContent = "-- Select motion --";
    valueEl.classList.add("placeholder");
  }
  if (picker.menu.hidden) return;

  if (picker.query) {
    const results = motionSearchResults(picker);
    picker.list.innerHTML = results.length
      ? `<div class="motion-picker-heading">${results.length} match${results.length === 1 ? "" : "es"}</div>` +
        results.map((entry) => motionItemHtml(picker, entry, true)).join("")
      : '<div class="motion-picker-empty">No motions match</div>';
    return;
  }

  const favourites = [...favouriteMotions]
    .map(motionEntry)
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  const categories = new Map();
  motionCatalog.forEach((entry) => {
    if (!categories.has(entry.category)) categories.set(entry.category, []);
    categories.get(entry.category).push(entry);
  });

  let html = '<div class="motion-picker-heading">★ Favourites</div>';
  html += favourites.length
    ? favourites.map((entry) => motionItemHtml(picker, entry)).join("")
    : '<div class="motion-picker-empty">Click ☆ next to a motion to add it here</div>';
  html += '<div class="motion-picker-heading">Categories</div>';
  categories.forEach((entries, category) => {
    const open = picker.openCategory === category;
    html += `
      <button type="button" class="motion-picker-category${open ? " open" : ""}" data-action="category"
        data-category="${escapeHtml(category)}" aria-expanded="${open}">
        <span class="motion-picker-arrow">▸</span>${escapeHtml(category)}<span class="motion-picker-count">${entries.length}</span>
      </button>`;
    if (open) {
      html += `<div class="motion-picker-sub">${entries.map((entry) => motionItemHtml(picker, entry)).join("")}</div>`;
    }
  });
  const scroll = picker.list.scrollTop;
  picker.list.innerHTML = html;
  picker.list.scrollTop = scroll;
}

document.addEventListener("pointerdown", (e) => {
  motionPickers.forEach((p) => !p.menu.hidden && !p.root.contains(e.target) && setMotionPickerOpen(p, false));
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") motionPickers.forEach((p) => !p.menu.hidden && setMotionPickerOpen(p, false));
});

const motionPicker = createMotionPicker(document.getElementById("motionSelect"));
const timelineMotionPicker = createMotionPicker(document.getElementById("timelineMotionSelect"));

async function loadMotionsFromRobot() {
  const status = document.getElementById("motionListStatus");
  const btn = document.getElementById("reloadMotionsBtn");
  if (!isConnected) {
    alert("Connect to Pepper first.");
    return;
  }
  btn.disabled = true;
  status.textContent = "Loading…";
  try {
    const r = await fetch("/list-motions", { method: "POST" });
    const data = await r.json();
    if (!data.success) throw new Error(data.error || "Unknown error");
    motionCatalog = buildMotionCatalog(data.animations, data.behaviors);
    motionPickers.forEach(renderMotionPicker);
    status.textContent = `${data.animations.length + data.behaviors.length} motions from the robot`;
    status.title = `${data.animations.length} standard animations + ${data.behaviors.length} animations from installed apps`;
  } catch (error) {
    status.textContent = "Could not load from robot — built-in list";
    logError("Load motions", error.message);
  }
  btn.disabled = false;
}

// ─── Sequence Builder ────────────────────────────────────────────────────────

function getMotionDisplayName(motionValue) {
  return motionEntry(motionValue).label;
}

function nextBlockId() {
  blockIdCounter += 1;
  return Date.now() * 1000 + (blockIdCounter % 1000);
}

function addBlock(block) {
  if (isPlaying) {
    alert("Stop the timeline before editing it.");
    return false;
  }
  block.id = nextBlockId();
  timelineSteps = appendStep(timelineSteps, block);
  resetBlockStates();
  renderTimeline();
  return true;
}

function addSpeechBlock() {
  const text = document.getElementById("timelineSpeech").value.trim();
  if (!text) {
    alert("Enter text for Pepper to say.");
    return;
  }

  if (addBlock({ type: "speech", text: text })) {
    document.getElementById("timelineSpeech").value = "";
  }
}

function addTextBlock() {
  const text = document.getElementById("timelineText").value.trim();
  if (!text) {
    alert("Enter some text first.");
    return;
  }

  if (addBlock({ type: "text", text: text, fontSize: currentFontSize, color: currentColor })) {
    document.getElementById("timelineText").value = "";
  }
}

function addImageBlock() {
  const fileInput = document.getElementById("timelineImageInput");
  const file = fileInput.files[0];

  if (!file) {
    alert("Select an image first.");
    return;
  }

  loadImageForTablet(file, (dataUrl) => {
    addBlock({ type: "image", imageData: dataUrl, fileName: file.name });
    fileInput.value = "";
    fileInput.dispatchEvent(new Event("change"));
  });
}

function addDelayBlock() {
  const seconds = parseInt(document.getElementById("delaySeconds").value);
  if (!seconds || seconds < 1) {
    alert("Enter a delay between 1 and 60 seconds.");
    return;
  }

  addBlock({ type: "delay", seconds: seconds });
}

function addMotionBlock() {
  const motionValue = timelineMotionPicker.value;

  if (!motionValue) {
    alert("Please select a motion first.");
    return;
  }

  if (addBlock({ type: "motion", motion: motionValue, displayName: getMotionDisplayName(motionValue) })) {
    setMotionPickerValue(timelineMotionPicker, "");
  }
}

function deleteBlock(id) {
  if (isPlaying) return;
  timelineSteps = withoutBlock(timelineSteps, id);
  resetBlockStates();
  renderTimeline();
}

const ARROW_SVG =
  '<svg viewBox="0 0 28 14" aria-hidden="true"><path d="M1 7h21" stroke="currentColor" stroke-width="2" fill="none"/>' +
  '<path d="M19 2l8 5-8 5z" fill="currentColor"/></svg>';

function blockContentHtml(block) {
  if (block.type === "text") {
    return `
      <div class="block-header"><span>Text</span></div>
      <div class="block-content" style="color: ${escapeHtml(block.color)};">${escapeHtml(block.text)}</div>`;
  }
  if (block.type === "speech") {
    return `
      <div class="block-header"><span>Speech</span></div>
      <div class="block-content">"${escapeHtml(block.text)}"</div>`;
  }
  if (block.type === "image") {
    return `
      <div class="block-header"><span>Image</span></div>
      <img src="${escapeHtml(block.imageData)}" class="block-thumbnail" />
      <div class="block-content">${escapeHtml(block.fileName)}</div>`;
  }
  if (block.type === "delay") {
    return `
      <div class="block-header"><span>Wait</span></div>
      <div class="block-content">${block.seconds} second${block.seconds === 1 ? "" : "s"}</div>`;
  }
  if (block.type === "motion") {
    return `
      <div class="block-header"><span>Motion</span></div>
      <div class="block-content">${escapeHtml(block.displayName)}</div>`;
  }
  return "";
}

function clearDropHighlights() {
  document
    .querySelectorAll("#timeline .drop-ok, #timeline .drop-refused, #timeline .drop-target")
    .forEach((el) => el.classList.remove("drop-ok", "drop-refused", "drop-target"));
}

function updateSteps(steps) {
  if (steps !== timelineSteps) {
    timelineSteps = steps;
    resetBlockStates();
  }
  renderTimeline();
}

function attachBlockDrag(blockEl, block) {
  blockEl.addEventListener("dragstart", (e) => {
    if (isPlaying) {
      e.preventDefault();
      return;
    }
    draggedBlockId = block.id;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(block.id)); // Firefox only starts a drag that carries data
    blockEl.classList.add("dragging");
  });
  blockEl.addEventListener("dragend", () => {
    draggedBlockId = null;
    blockEl.classList.remove("dragging");
    clearDropHighlights();
  });
}

// Dropping onto a step (or any block in it) joins that step, unless the step
// already has a block on the same channel
function attachStepDrop(stepEl, index) {
  stepEl.addEventListener("dragover", (e) => {
    if (draggedBlockId === null || isPlaying) return;
    e.preventDefault(); // accept the drop even when refused, so the drop can say why
    const { error } = moveBlockToStep(timelineSteps, draggedBlockId, index);
    clearDropHighlights();
    stepEl.classList.add(error ? "drop-refused" : "drop-ok");
    e.dataTransfer.dropEffect = "move";
  });
  stepEl.addEventListener("dragleave", (e) => {
    if (!stepEl.contains(e.relatedTarget)) stepEl.classList.remove("drop-ok", "drop-refused");
  });
  stepEl.addEventListener("drop", (e) => {
    if (draggedBlockId === null || isPlaying) return;
    e.preventDefault();
    const { steps, error } = moveBlockToStep(timelineSteps, draggedBlockId, index);
    clearDropHighlights();
    if (error) {
      setTimelineStatus("error", error, 0);
      return;
    }
    updateSteps(steps);
  });
}

// Dropping into a gap makes the block a new step at that position
function attachGapDrop(gapEl, index) {
  gapEl.addEventListener("dragover", (e) => {
    if (draggedBlockId === null || isPlaying) return;
    e.preventDefault();
    clearDropHighlights();
    gapEl.classList.add("drop-target");
    e.dataTransfer.dropEffect = "move";
  });
  gapEl.addEventListener("dragleave", () => gapEl.classList.remove("drop-target"));
  gapEl.addEventListener("drop", (e) => {
    if (draggedBlockId === null || isPlaying) return;
    e.preventDefault();
    clearDropHighlights();
    updateSteps(moveBlockToGap(timelineSteps, draggedBlockId, index));
  });
}

function createBlockElement(block) {
  const blockEl = document.createElement("div");
  blockEl.className = `timeline-block ${block.type}`;
  blockEl.draggable = !isPlaying;
  blockEl.dataset.id = block.id;
  blockEl.innerHTML = `<div class="block-step"><span class="block-state-badge"></span></div>` + blockContentHtml(block) + `
    <div class="block-error"></div>
    <div class="block-actions">
      <button class="delete-btn"${isPlaying ? " disabled" : ""}>Delete</button>
    </div>`;
  blockEl.querySelector(".delete-btn").addEventListener("click", () => deleteBlock(block.id));
  applyBlockState(blockEl, blockStates[block.id]);
  attachBlockDrag(blockEl, block);
  return blockEl;
}

function createStepElement(step, index) {
  const stepEl = document.createElement("div");
  stepEl.className = "timeline-step" + (step.length > 1 ? " multi" : "");
  stepEl.dataset.step = index;
  const together = step.length > 1 ? '<span class="step-together"> · runs together</span>' : "";
  stepEl.innerHTML = `<div class="step-header">Step ${index + 1}${together}</div><div class="step-blocks"></div>`;
  const blocksEl = stepEl.querySelector(".step-blocks");
  step.forEach((block) => blocksEl.appendChild(createBlockElement(block)));
  attachStepDrop(stepEl, index);
  return stepEl;
}

// Gap `index` sits before step `index`; the ones between steps carry the arrow
function createGapElement(index) {
  const gapEl = document.createElement("div");
  const between = index > 0 && index < timelineSteps.length;
  gapEl.className = "timeline-gap" + (between ? "" : " edge") + (between && index === playingStepIndex ? " active" : "");
  gapEl.dataset.gap = index;
  if (between) gapEl.innerHTML = ARROW_SVG;
  attachGapDrop(gapEl, index);
  return gapEl;
}

function renderTimeline() {
  const timeline = document.getElementById("timeline");
  timeline.innerHTML = "";
  timeline.classList.toggle("empty", timelineSteps.length === 0);
  if (timelineSteps.length === 0) return;
  timelineSteps.forEach((step, index) => {
    timeline.appendChild(createGapElement(index));
    timeline.appendChild(createStepElement(step, index));
  });
  timeline.appendChild(createGapElement(timelineSteps.length));
}

// ─── Playback ────────────────────────────────────────────────────────────────

const BLOCK_STATE_LABELS = {
  playing: "Playing",
  done: "Done",
  error: "Failed",
  stopped: "Stopped",
};

function applyBlockState(blockEl, info) {
  blockEl.classList.remove("state-playing", "state-done", "state-error", "state-stopped");
  const badge = blockEl.querySelector(".block-state-badge");
  const errorEl = blockEl.querySelector(".block-error");
  if (info) {
    blockEl.classList.add("state-" + info.state);
    badge.textContent = BLOCK_STATE_LABELS[info.state] || "";
  } else {
    badge.textContent = "";
  }
  errorEl.textContent = info && info.error ? info.error : "";
  errorEl.title = errorEl.textContent;
}

function setBlockState(block, state, error) {
  blockStates[block.id] = { state, error: error || "" };
  const blockEl = document.querySelector(`.timeline-block[data-id="${block.id}"]`);
  if (!blockEl) return;
  applyBlockState(blockEl, blockStates[block.id]);
  if (state === "playing") {
    blockEl.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }
}

function resetBlockStates() {
  blockStates = {};
  setTimelineStatus("idle", "Ready", 0);
}

function setTimelineStatus(state, text, progress) {
  document.getElementById("timelineStatus").className = "timeline-status " + state;
  document.getElementById("timelineStatusText").textContent = text;
  document.getElementById("timelineProgressBar").style.width = Math.round(progress * 100) + "%";
}

function describeBlock(block) {
  if (block.type === "speech") return `Speech "${block.text}"`;
  if (block.type === "text") return `Text "${block.text}"`;
  if (block.type === "image") return `Image ${block.fileName || ""}`.trim();
  if (block.type === "delay") return `Wait ${block.seconds}s`;
  if (block.type === "motion") return `Motion ${block.displayName || block.motion}`;
  return block.type;
}

// Waits `ms` but returns early if playback is stopped
function abortableSleep(ms) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = setInterval(() => {
      if (playbackAborted || Date.now() - started >= ms) {
        clearInterval(tick);
        resolve();
      }
    }, 100);
  });
}

async function postJson(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function runBlock(block) {
  let r;
  if (block.type === "text") {
    const params = new URLSearchParams({
      text: block.text,
      fontSize: block.fontSize,
      color: block.color,
    });
    r = await fetch("/send?" + params.toString());
  } else if (block.type === "speech") {
    r = await postJson("/speak", { text: block.text });
  } else if (block.type === "image") {
    r = await postJson("/send-image", { imageData: block.imageData });
  } else if (block.type === "delay") {
    await abortableSleep(block.seconds * 1000);
    return;
  } else if (block.type === "motion") {
    r = await postJson("/motion", { motion: block.motion });
  } else {
    throw new Error(`Unknown block type "${block.type}"`);
  }
  if (!r.ok) throw new Error((await r.text()) || `HTTP ${r.status}`);
}

// Runs one block of the current step; never rejects, so a step can wait for all
async function runStepBlock(block) {
  setBlockState(block, "playing");
  try {
    await runBlock(block);
  } catch (error) {
    if (playbackAborted) {
      setBlockState(block, "stopped");
      return null;
    }
    setBlockState(block, "error", error.message);
    return error;
  }
  setBlockState(block, playbackAborted ? "stopped" : "done");
  return null;
}

function setPlayingStep(index) {
  playingStepIndex = index;
  document.querySelectorAll("#timeline .timeline-gap").forEach((gap) => {
    gap.classList.toggle("active", !gap.classList.contains("edge") && Number(gap.dataset.gap) === index);
  });
}

async function playTimeline() {
  if (timelineSteps.length === 0) {
    alert("Add some blocks to the timeline first.");
    return;
  }
  if (isPlaying) {
    alert("The timeline is already playing.");
    return;
  }

  isPlaying = true;
  playbackAborted = false;
  blockStates = {};
  document.getElementById("playTimeline").disabled = true;
  document.getElementById("clearTimeline").disabled = true;
  document.getElementById("importTimelineBtn").disabled = true;
  renderTimeline();

  const steps = timelineSteps.map((step) => step.slice());
  const total = steps.length;
  let failed = null;
  let completed = 0;

  for (let i = 0; i < total; i++) {
    if (playbackAborted) break;

    const step = steps[i];
    setPlayingStep(i);
    setTimelineStatus("playing", `Playing step ${i + 1} of ${total}: ${step.map(describeBlock).join(" + ")}`, i / total);

    // Every block of the step starts now; the step ends when all have finished
    const errors = await Promise.all(step.map(runStepBlock));
    if (playbackAborted) break;

    const failures = step.map((block, k) => [block, errors[k]]).filter(([, error]) => error);
    if (failures.length > 0) {
      failures.forEach(([block, error]) => logError(`Timeline step ${i + 1} (${block.type})`, error.message));
      failed = { index: i, message: failures[0][1].message };
      break;
    }
    completed = i + 1;

    if (i < total - 1) {
      await abortableSleep(300);
    }
  }

  setPlayingStep(-1);
  if (failed) {
    setTimelineStatus("error", `Failed at step ${failed.index + 1} of ${total}: ${failed.message}`, completed / total);
  } else if (playbackAborted) {
    steps.flat().forEach((block) => {
      if (blockStates[block.id] && blockStates[block.id].state === "playing") setBlockState(block, "stopped");
    });
    setTimelineStatus("stopped", `Stopped after ${completed} of ${total} steps`, completed / total);
  } else {
    setTimelineStatus("done", `Finished — all ${total} steps played`, 1);
  }

  isPlaying = false;
  document.getElementById("playTimeline").disabled = false;
  document.getElementById("clearTimeline").disabled = false;
  document.getElementById("importTimelineBtn").disabled = false;
  renderTimeline();
}

async function stopTimeline() {
  if (!isPlaying) {
    clearScreen();
    return;
  }
  playbackAborted = true;
  setTimelineStatus("stopping", "Stopping…", 0);
  // Interrupt whatever the robot is doing so the in-flight block returns
  await Promise.allSettled([
    fetch("/stop-speech", { method: "POST" }),
    fetch("/stop-motion", { method: "POST" }),
  ]);
  clearScreen();
}

// ─── Import / Export ─────────────────────────────────────────────────────────

function clearTimelineBlocks() {
  if (isPlaying) {
    alert("Cannot clear timeline while playing!");
    return;
  }
  if (timelineSteps.length === 0) return;

  if (confirm("Clear all blocks from the timeline?")) {
    timelineSteps = [];
    resetBlockStates();
    renderTimeline();
  }
}

function exportTimeline() {
  if (timelineSteps.length === 0) {
    alert("Add some blocks to the timeline before exporting.");
    return;
  }

  const name = prompt("Timeline name:", "my_timeline");
  if (!name) return;

  const sanitizedName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const exportData = {
    name: name,
    exportedAt: new Date().toISOString(),
    blocks: timelineSteps.flat(),
  };

  const jsonString = JSON.stringify(exportData, null, 2);
  const blob = new Blob([jsonString], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = sanitizedName + ".json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function importTimeline(file) {
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const importData = JSON.parse(e.target.result);

      if (!importData.blocks || !Array.isArray(importData.blocks)) {
        alert("Invalid file — no blocks found.");
        return;
      }

      const validTypes = ["speech", "text", "image", "delay", "motion"];
      const validBlocks = importData.blocks.filter((block) => {
        return block && block.type && validTypes.includes(block.type);
      });

      if (validBlocks.length === 0) {
        alert("No valid blocks found in this file.");
        return;
      }

      if (timelineSteps.length > 0) {
        if (!confirm(`Replace the current timeline (${timelineSteps.length} steps)?`)) {
          return;
        }
      }

      if (isPlaying) {
        alert("Stop the timeline before importing.");
        return;
      }
      // Re-issue ids so blocks from different files never collide
      timelineSteps = validBlocks.map((block) => [{ ...block, id: nextBlockId() }]);
      resetBlockStates();
      renderTimeline();
      alert(`Imported "${importData.name || "Untitled"}" — ${validBlocks.length} blocks loaded.`);
    } catch (error) {
      alert("Could not read the file: " + error.message);
    }
  };
  reader.readAsText(file);
}

// ─── Event Listeners ─────────────────────────────────────────────────────────

document.getElementById("connectBtn").addEventListener("click", toggleConnection);

document.getElementById("speakBtn").addEventListener("click", speak);
document.getElementById("speechText").addEventListener("keydown", (e) => {
  if (e.key === "Enter") speak();
});

document.getElementById("send").addEventListener("click", sendTextToTablet);
document.getElementById("clear").addEventListener("click", clearScreen);
document.getElementById("colorPicker").addEventListener("change", (e) => {
  currentColor = e.target.value;
});
document.getElementById("increaseSize").addEventListener("click", () => {
  currentFontSize += 10;
  if (currentFontSize > 300) currentFontSize = 300;
  document.getElementById("fontSizeDisplay").textContent = currentFontSize + "px";
});
document.getElementById("decreaseSize").addEventListener("click", () => {
  currentFontSize -= 10;
  if (currentFontSize < 20) currentFontSize = 20;
  document.getElementById("fontSizeDisplay").textContent = currentFontSize + "px";
});
document.getElementById("msg").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendTextToTablet();
  if (e.key === "Escape") clearScreen();
});

// Image upload handlers
const dropZone = document.getElementById("dropZone");
const imageInput = document.getElementById("imageInput");

dropZone.addEventListener("click", () => imageInput.click());
imageInput.addEventListener("change", (e) => {
  if (e.target.files.length > 0) handleImageFile(e.target.files[0]);
});
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.style.borderColor = "#2563EB";
  dropZone.style.backgroundColor = "#eff6ff";
});
dropZone.addEventListener("dragleave", (e) => {
  e.preventDefault();
  dropZone.style.borderColor = "#d1d5db";
  dropZone.style.backgroundColor = "#f9fafb";
});
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.style.borderColor = "#d1d5db";
  dropZone.style.backgroundColor = "#f9fafb";
  if (e.dataTransfer.files.length > 0) handleImageFile(e.dataTransfer.files[0]);
});
document.getElementById("sendImage").addEventListener("click", sendImage);
document.getElementById("clearImage").addEventListener("click", clearScreen);

// Timeline event listeners
document.getElementById("addSpeechBlock").addEventListener("click", addSpeechBlock);
document.getElementById("addTextBlock").addEventListener("click", addTextBlock);
document.getElementById("addImageBlock").addEventListener("click", addImageBlock);
document.getElementById("addDelayBlock").addEventListener("click", addDelayBlock);
document.getElementById("addMotionBlock").addEventListener("click", addMotionBlock);
document.getElementById("playTimeline").addEventListener("click", playTimeline);
document.getElementById("stopTimeline").addEventListener("click", stopTimeline);
document.getElementById("clearTimeline").addEventListener("click", clearTimelineBlocks);
document.getElementById("exportTimeline").addEventListener("click", exportTimeline);
document.getElementById("importTimelineBtn").addEventListener("click", () => {
  document.getElementById("importTimelineInput").click();
});
document.getElementById("importTimelineInput").addEventListener("change", (e) => {
  if (e.target.files.length > 0) {
    importTimeline(e.target.files[0]);
    e.target.value = "";
  }
});
document.getElementById("timelineImageInput").addEventListener("change", (e) => {
  const label = document.getElementById("timelineImageLabel");
  if (e.target.files.length > 0) {
    label.textContent = e.target.files[0].name;
    label.classList.add("has-file");
  } else {
    label.textContent = "Choose image…";
    label.classList.remove("has-file");
  }
});

// Drive event listeners
document.getElementById("driveToggleBtn").addEventListener("click", (e) => {
  setDriveEnabled(!driveEnabled);
  e.currentTarget.blur(); // so Space can't re-toggle it
});
document.getElementById("avoidanceToggleBtn").addEventListener("click", (e) => {
  toggleObstacleAvoidance();
  e.currentTarget.blur(); // so Space can't toggle it
});
document.getElementById("driveSpeedSlider").addEventListener("input", (e) => {
  document.getElementById("driveSpeedValue").textContent = e.target.value + "%";
  if (driveEnabled && isMoving(driveCommand())) sendDrive();
});
document.querySelectorAll(".drive-key").forEach((btn) => {
  const key = btn.dataset.key;
  const release = () => {
    if (driveHeld.delete(key)) {
      updateDriveUi();
      sendDrive();
    }
  };
  btn.addEventListener("pointerdown", (e) => {
    if (!driveEnabled) return;
    e.preventDefault();
    if (key === "stop") {
      driveStop();
      return;
    }
    btn.setPointerCapture(e.pointerId);
    driveHeld.add(key);
    updateDriveUi();
    sendDrive();
  });
  btn.addEventListener("pointerup", release);
  btn.addEventListener("pointercancel", release);
  btn.addEventListener("lostpointercapture", release);
});

// Camera event listeners
document.getElementById("cameraToggleBtn").addEventListener("click", (e) => {
  setCameraEnabled(!cameraOn);
  e.currentTarget.blur(); // so Space can't re-toggle it
});

// Robot control event listeners
document.getElementById("clearTabletBtn").addEventListener("click", clearScreen);
document.getElementById("reloadMotionsBtn").addEventListener("click", loadMotionsFromRobot);
Object.keys(SLIDERS).forEach((key) => {
  document.getElementById(SLIDERS[key].slider).addEventListener("input", () => onSliderInput(key));
});
document.getElementById("wakeUpBtn").addEventListener("click", wakeUpRobot);
document.getElementById("stopMotionBtn").addEventListener("click", stopMotion);
document.getElementById("stopMotionBtn2").addEventListener("click", stopMotion);
document.getElementById("emergencyStopBtn").addEventListener("click", emergencyStop);
document.getElementById("playMotionBtn").addEventListener("click", playMotion);

// Error log
document.getElementById("clearErrorLogBtn").addEventListener("click", clearErrorLog);
document.getElementById("errorIndicator").addEventListener("click", () => {
  document.getElementById("errorLogPanel").scrollIntoView({ behavior: "smooth" });
});
