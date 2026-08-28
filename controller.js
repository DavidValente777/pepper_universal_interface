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
let timelineBlocks = [];
let isPlaying = false;
let playbackAborted = false;
let isConnected = false;
let autoReconnecting = false;
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

async function autoReconnect() {
  if (autoReconnecting) return false;
  if (!lastConnectedHostIp || !lastConnectedPepperIp) return false;

  autoReconnecting = true;
  console.log("Auto-reconnecting to Pepper...");
  updateConnectionStatus("connecting", "Reconnecting to Pepper...");

  try {
    const response = await fetch("/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hostIp: lastConnectedHostIp,
        pepperIp: lastConnectedPepperIp,
      }),
    });
    const result = await response.json();

    if (result.success) {
      isConnected = true;
      updateConnectionStatus("connected", "Connected to Pepper (auto-reconnected)");
      updateIpDisplay(lastConnectedHostIp, lastConnectedPepperIp);
      document.getElementById("connectBtn").textContent = "Disconnect";
      document.getElementById("connectBtn").classList.add("disconnect");
      console.log("Auto-reconnect successful");
      autoReconnecting = false;
      return true;
    } else {
      isConnected = false;
      updateConnectionStatus("error", "Auto-reconnect failed: " + result.error);
      logError("Auto-reconnect", result.error);
      autoReconnecting = false;
      return false;
    }
  } catch (error) {
    isConnected = false;
    updateConnectionStatus("error", "Auto-reconnect error: " + error.message);
    logError("Auto-reconnect", error.message);
    autoReconnecting = false;
    return false;
  }
}

async function checkConnectionStatus() {
  try {
    const response = await fetch("/status");
    const data = await response.json();

    if (data.connected) {
      isConnected = true;
      updateConnectionStatus("connected", "Connected to Pepper");
      updateIpDisplay(data.hostIp, data.pepperIp);
      document.getElementById("hostIp").value = data.hostIp || "";
      setPepperIp(data.pepperIp || "");
      lastConnectedHostIp = data.hostIp;
      lastConnectedPepperIp = data.pepperIp;
      document.getElementById("connectBtn").textContent = "Disconnect";
      document.getElementById("connectBtn").classList.add("disconnect");
    } else {
      if (isConnected && lastConnectedHostIp && lastConnectedPepperIp) {
        console.log("Connection dropped — triggering auto-reconnect");
        isConnected = false;
        await autoReconnect();
      } else {
        isConnected = false;
        updateConnectionStatus(
          "disconnected",
          "Not connected — enter IP addresses above and click Connect",
        );
        updateIpDisplay(null, null);
        document.getElementById("connectBtn").textContent = "Connect";
        document.getElementById("connectBtn").classList.remove("disconnect");
      }
    }
  } catch (error) {
    console.error("Status check error:", error);
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

  try {
    const response = await fetch("/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostIp, pepperIp }),
    });

    const result = await response.json();

    if (result.success) {
      isConnected = true;
      lastConnectedHostIp = hostIp;
      lastConnectedPepperIp = pepperIp;
      updateConnectionStatus("connected", "Connected to Pepper");
      updateIpDisplay(hostIp, pepperIp);
      document.getElementById("connectBtn").textContent = "Disconnect";
      document.getElementById("connectBtn").classList.add("disconnect");
    } else {
      updateConnectionStatus("error", "Connection failed: " + result.error);
    }
  } catch (error) {
    updateConnectionStatus("error", "Connection error: " + error.message);
  }

  document.getElementById("connectBtn").disabled = false;
}

async function disconnect() {
  try {
    await fetch("/disconnect", { method: "POST" });
    isConnected = false;
    updateConnectionStatus("disconnected", "Disconnected");
    updateIpDisplay(null, null);
    document.getElementById("connectBtn").textContent = "Connect";
    document.getElementById("connectBtn").classList.remove("disconnect");
  } catch (error) {
    logError("Disconnect", error.message);
  }
}

function toggleConnection() {
  if (isConnected) {
    disconnect();
  } else {
    connect();
  }
}

// ─── Startup ─────────────────────────────────────────────────────────────────

window.addEventListener("load", checkConnectionStatus);

setInterval(() => {
  if (isConnected) {
    checkConnectionStatus();
  }
}, 5000);

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

async function clearScreen() {
  try {
    const r = await fetch("/send?text=");
    if (!r.ok) logError("Clear Screen", await r.text());
  } catch (error) {
    logError("Clear Screen", error.message);
  }
}

function handleImageFile(file) {
  if (!file || !file.type.match(/image\/(jpeg|jpg|png)/)) {
    alert("Please select a JPG or PNG image.");
    return;
  }

  const img = new Image();
  img.onload = () => {
    const MAX_W = 1280,
      MAX_H = 800;
    let w = img.width,
      h = img.height;
    if (w > MAX_W || h > MAX_H) {
      const scale = Math.min(MAX_W / w, MAX_H / h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(img, 0, 0, w, h);
    currentImageData = canvas.toDataURL("image/jpeg", 0.8);
    document.getElementById("previewImg").src = currentImageData;
    document.getElementById("dropZone").style.display = "none";
    document.getElementById("imagePreview").style.display = "block";
  };
  const reader = new FileReader();
  reader.onload = (e) => {
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
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

async function clearImage() {
  try {
    const r = await fetch("/send?text=");
    if (!r.ok) logError("Clear", await r.text());
  } catch (error) {
    logError("Clear", error.message);
  }
}

async function playMotion() {
  const select = document.getElementById("motionSelect");
  const motionValue = select.value;

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
  try {
    const response = await fetch("/stop-motion", { method: "POST" });
    if (!response.ok) logError("Stop Motion", await response.text());
  } catch (error) {
    logError("Stop Motion", error.message);
  }
}

// ─── Sequence Builder ────────────────────────────────────────────────────────

function getMotionDisplayName(motionValue) {
  const select = document.getElementById("timelineMotionSelect");
  const option = select.querySelector(`option[value="${motionValue}"]`);
  return option ? option.textContent : motionValue.split("/").pop();
}

function addSpeechBlock() {
  const text = document.getElementById("timelineSpeech").value.trim();
  if (!text) {
    alert("Enter text for Pepper to say.");
    return;
  }

  const block = { type: "speech", text: text, id: Date.now() };
  timelineBlocks.push(block);
  document.getElementById("timelineSpeech").value = "";
  renderTimeline();
}

function addTextBlock() {
  const text = document.getElementById("timelineText").value.trim();
  if (!text) {
    alert("Enter some text first.");
    return;
  }

  const block = {
    type: "text",
    text: text,
    fontSize: currentFontSize,
    color: currentColor,
    id: Date.now(),
  };
  timelineBlocks.push(block);
  document.getElementById("timelineText").value = "";
  renderTimeline();
}

function addImageBlock() {
  const fileInput = document.getElementById("timelineImageInput");
  const file = fileInput.files[0];

  if (!file) {
    alert("Select an image first.");
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    const block = {
      type: "image",
      imageData: e.target.result,
      fileName: file.name,
      id: Date.now(),
    };
    timelineBlocks.push(block);
    fileInput.value = "";
    renderTimeline();
  };
  reader.readAsDataURL(file);
}

function addDelayBlock() {
  const seconds = parseInt(document.getElementById("delaySeconds").value);
  if (!seconds || seconds < 1) {
    alert("Enter a delay between 1 and 60 seconds.");
    return;
  }

  const block = { type: "delay", seconds: seconds, id: Date.now() };
  timelineBlocks.push(block);
  renderTimeline();
}

function addMotionBlock() {
  const select = document.getElementById("timelineMotionSelect");
  const motionValue = select.value;

  if (!motionValue) {
    alert("Please select a motion first.");
    return;
  }

  const block = {
    type: "motion",
    motion: motionValue,
    displayName: getMotionDisplayName(motionValue),
    id: Date.now(),
  };
  timelineBlocks.push(block);
  select.value = "";
  renderTimeline();
}

function deleteBlock(id) {
  timelineBlocks = timelineBlocks.filter((b) => b.id !== id);
  renderTimeline();
}

function renderTimeline() {
  const timeline = document.getElementById("timeline");

  if (timelineBlocks.length === 0) {
    timeline.classList.add("empty");
    timeline.innerHTML = "";
    return;
  }

  timeline.classList.remove("empty");
  timeline.innerHTML = "";

  timelineBlocks.forEach((block, index) => {
    const blockEl = document.createElement("div");
    blockEl.className = `timeline-block ${block.type}`;
    blockEl.draggable = true;
    blockEl.dataset.index = index;

    let content = "";
    if (block.type === "text") {
      content = `
        <div class="block-header"><span>Text</span></div>
        <div class="block-content" style="color: ${escapeHtml(block.color)};">${escapeHtml(block.text)}</div>
      `;
    } else if (block.type === "speech") {
      content = `
        <div class="block-header"><span>Speech</span></div>
        <div class="block-content">"${escapeHtml(block.text)}"</div>
      `;
    } else if (block.type === "image") {
      content = `
        <div class="block-header"><span>Image</span></div>
        <img src="${escapeHtml(block.imageData)}" class="block-thumbnail" />
        <div class="block-content">${escapeHtml(block.fileName)}</div>
      `;
    } else if (block.type === "delay") {
      content = `
        <div class="block-header"><span>Wait</span></div>
        <div class="block-content">${block.seconds} second${block.seconds === 1 ? "" : "s"}</div>
      `;
    } else if (block.type === "motion") {
      content = `
        <div class="block-header"><span>Motion</span></div>
        <div class="block-content">${escapeHtml(block.displayName)}</div>
      `;
    }

    blockEl.innerHTML = content + `
      <div class="block-actions">
        <button class="delete-btn">Delete</button>
      </div>
    `;
    blockEl.querySelector(".delete-btn").addEventListener("click", () => deleteBlock(block.id));

    blockEl.addEventListener("dragstart", (e) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/html", index);
      blockEl.classList.add("dragging");
    });
    blockEl.addEventListener("dragend", () => {
      blockEl.classList.remove("dragging");
    });
    blockEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });
    blockEl.addEventListener("drop", (e) => {
      e.preventDefault();
      const fromIndex = parseInt(e.dataTransfer.getData("text/html"));
      const toIndex = parseInt(blockEl.dataset.index);
      if (fromIndex !== toIndex) {
        const movedBlock = timelineBlocks.splice(fromIndex, 1)[0];
        timelineBlocks.splice(toIndex, 0, movedBlock);
        renderTimeline();
      }
    });

    timeline.appendChild(blockEl);
  });
}

// ─── Playback ────────────────────────────────────────────────────────────────

async function playTimeline() {
  if (timelineBlocks.length === 0) {
    alert("Add some blocks to the timeline first.");
    return;
  }
  if (isPlaying) {
    alert("The timeline is already playing.");
    return;
  }

  isPlaying = true;
  playbackAborted = false;
  document.getElementById("playTimeline").disabled = true;

  for (let i = 0; i < timelineBlocks.length; i++) {
    if (playbackAborted) break;

    const block = timelineBlocks[i];

    try {
      if (block.type === "text") {
        const params = new URLSearchParams({
          text: block.text,
          fontSize: block.fontSize,
          color: block.color,
        });
        const r = await fetch("/send?" + params.toString());
        if (!r.ok) throw new Error(await r.text());
      } else if (block.type === "speech") {
        const r = await fetch("/speak", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: block.text }),
        });
        if (!r.ok) throw new Error(await r.text());
      } else if (block.type === "image") {
        const r = await fetch("/send-image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ imageData: block.imageData }),
        });
        if (!r.ok) throw new Error(await r.text());
      } else if (block.type === "delay") {
        await new Promise((resolve) => setTimeout(resolve, block.seconds * 1000));
      } else if (block.type === "motion") {
        const r = await fetch("/motion", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ motion: block.motion }),
        });
        if (!r.ok) throw new Error(await r.text());
      }
    } catch (error) {
      logError(`Timeline block ${i + 1} (${block.type})`, error.message);
      playbackAborted = true;
      break;
    }

    if (i < timelineBlocks.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  isPlaying = false;
  document.getElementById("playTimeline").disabled = false;
}

function stopTimeline() {
  playbackAborted = true;
  isPlaying = false;
  document.getElementById("playTimeline").disabled = false;
  clearScreen();
}

// ─── Import / Export ─────────────────────────────────────────────────────────

function clearTimelineBlocks() {
  if (isPlaying) {
    alert("Cannot clear timeline while playing!");
    return;
  }
  if (timelineBlocks.length === 0) return;

  if (confirm("Clear all blocks from the timeline?")) {
    timelineBlocks = [];
    renderTimeline();
  }
}

function exportTimeline() {
  if (timelineBlocks.length === 0) {
    alert("Add some blocks to the timeline before exporting.");
    return;
  }

  const name = prompt("Timeline name:", "my_timeline");
  if (!name) return;

  const sanitizedName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const exportData = {
    name: name,
    exportedAt: new Date().toISOString(),
    blocks: timelineBlocks,
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
        return block && block.type && validTypes.includes(block.type) && block.id;
      });

      if (validBlocks.length === 0) {
        alert("No valid blocks found in this file.");
        return;
      }

      if (timelineBlocks.length > 0) {
        if (!confirm(`Replace the current timeline (${timelineBlocks.length} blocks)?`)) {
          return;
        }
      }

      timelineBlocks = validBlocks;
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
document.getElementById("clearImage").addEventListener("click", clearImage);

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

// Robot control event listeners
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
