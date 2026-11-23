// ─── Story page ──────────────────────────────────────────────────────────────
// A running script the operator prepares before filming and fires item by item.
// The story is saved on the laptop through the bridge (GET/POST /story).
// Uses story.js for the model and controller.js for shared helpers.

const STORY_TYPE_LABELS = { say: "Say", animatedSay: "Animated say", dance: "Dance", image: "Image", sound: "Sound" };
const STORY_SAVE_DELAY_MS = 500;
const STORY_UNDO_MS = 6000;

let story = emptyStory();
let storyLoaded = false; // false until GET /story succeeded; nothing is saved before that
let storyIdCounter = 0;
let storySaveTimer = null;
let storySaveInFlight = false;
let storyUnsaved = false; // a change has not reached the bridge yet
let storyUndo = null; // { item, index } of the last deleted item
let storyUndoTimer = null;
let draggedStoryId = null;
const storyPickers = [];

function nextStoryId() {
  storyIdCounter += 1;
  return `s${Date.now().toString(36)}${storyIdCounter}`;
}

function storyEl(id) {
  return document.getElementById(id);
}

// ─── Saving ──────────────────────────────────────────────────────────────────

function setStorySaveStatus(text, state = "") {
  const el = storyEl("storySaveStatus");
  el.textContent = text;
  el.className = "story-save-status " + state;
}

// Replaces the story; re-renders unless the change came from an input that
// already shows it (re-rendering would steal the focus while typing)
function setStory(next, { render = true } = {}) {
  story = next;
  if (render) renderStory();
  scheduleStorySave();
}

function scheduleStorySave() {
  if (!storyLoaded) return;
  storyUnsaved = true;
  setStorySaveStatus("Saving…");
  clearTimeout(storySaveTimer);
  storySaveTimer = setTimeout(saveStoryNow, STORY_SAVE_DELAY_MS);
}

// One save at a time; a change made during a save is sent right after it
async function saveStoryNow() {
  clearTimeout(storySaveTimer);
  storySaveTimer = null;
  if (!storyLoaded || storySaveInFlight) return;
  storySaveInFlight = true;
  storyUnsaved = false;
  setStorySaveStatus("Saving…");
  try {
    const r = await postJson("/story", story);
    const result = await r.json().catch(() => ({}));
    if (!r.ok || !result.success) throw new Error(result.error || `HTTP ${r.status}`);
    if (!storyUnsaved) setStorySaveStatus("Saved ✓", "saved");
  } catch (error) {
    storyUnsaved = true;
    setStorySaveStatus("Save failed — retrying on next change", "error");
    logError("Story save", error.message);
    storySaveInFlight = false;
    return;
  }
  storySaveInFlight = false;
  if (storyUnsaved && !storySaveTimer) saveStoryNow();
}

// A reload right after typing must not lose the last line. Browsers refuse
// beacons above ~64 KB (any story with photos), so then the browser asks
// "Leave site?" instead, which gives the autosave time to finish.
window.addEventListener("beforeunload", (e) => {
  if (!storyLoaded || !storyUnsaved) return;
  const sent = navigator.sendBeacon("/story", new Blob([JSON.stringify(story)], { type: "application/json" }));
  if (!sent) {
    e.preventDefault();
    e.returnValue = "";
  }
});

async function loadStory() {
  try {
    const r = await fetch("/story");
    const body = await r.text();
    if (!r.ok) {
      let message = body;
      try {
        message = JSON.parse(body).error || body;
      } catch {
        // plain-text error
      }
      throw new Error(message || `HTTP ${r.status}`);
    }
    story = validateStory(JSON.parse(body), nextStoryId).story;
    storyLoaded = true;
    setStorySaveStatus("Saved ✓", "saved");
    storyLoadedHook();
  } catch (error) {
    storyEl("storyLoadError").hidden = false;
    logError("Story load", error.message);
  }
  renderStory();
}

// The story's eye colour is shown in the pickers, and set on Pepper when connected
function storyLoadedHook() {
  setEyeColor(story.eyeColor, { send: isConnected });
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function growTextarea(box) {
  box.style.height = "auto";
  box.style.height = box.scrollHeight + "px";
}

function danceNotFound(item) {
  return motionsFromRobot && item.motion && !motionCatalog.some((m) => m.path === item.motion);
}

function storyItemBody(item, li) {
  const body = li.querySelector(".story-body");
  if (item.type === "say" || item.type === "animatedSay") {
    const box = document.createElement("textarea");
    box.className = "story-text";
    box.rows = 1;
    box.placeholder = "What should Pepper say?";
    box.value = item.text;
    box.addEventListener("input", () => {
      growTextarea(box);
      setStory(updateItem(story, item.id, { text: box.value }), { render: false });
    });
    body.appendChild(box);
    requestAnimationFrame(() => growTextarea(box));
  } else if (item.type === "dance") {
    const root = document.createElement("div");
    root.className = "motion-picker";
    const warning = document.createElement("span");
    warning.className = "story-warning";
    body.append(root, warning);
    const showWarning = (current) => (warning.textContent = danceNotFound(current) ? "Not found on this robot" : "");
    const picker = createMotionPicker(root, (path) => {
      setStory(updateItem(story, item.id, { motion: path }), { render: false });
      showWarning({ motion: path });
    });
    storyPickers.push(picker);
    if (item.motion) setMotionPickerValue(picker, item.motion);
    showWarning(item);
  } else if (item.type === "image") {
    if (item.imageData) {
      const img = document.createElement("img");
      img.className = "story-thumb";
      img.src = item.imageData;
      img.alt = item.name;
      body.appendChild(img);
    }
    const label = document.createElement("label");
    label.className = "file-input-label story-image-label" + (item.imageData ? " has-file" : "");
    label.textContent = item.imageData ? item.name || "Image" : "Choose image…";
    label.title = item.imageData ? "Choose another image" : "Choose a JPG or PNG";
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/jpeg,image/jpg,image/png";
    input.hidden = true;
    input.addEventListener("change", () => {
      const file = input.files[0];
      if (!file) return;
      loadImageForTablet(file, (dataUrl) => setStory(updateItem(story, item.id, { imageData: dataUrl, name: file.name })));
    });
    label.appendChild(input);
    body.appendChild(label);
  } else if (item.type === "sound") {
    const label = document.createElement("label");
    label.className = "file-input-label story-image-label" + (item.audioData ? " has-file" : "");
    label.textContent = item.audioData ? item.name || "Sound" : "Choose sound…";
    label.title = item.audioData ? "Choose another sound" : "Choose an MP3 or WAV";
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".mp3,.wav,audio/mpeg,audio/wav,audio/x-wav";
    input.hidden = true;
    input.addEventListener("change", async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        const audioData = await readSoundFile(file);
        setStory(updateItem(story, item.id, { audioData, name: file.name }));
      } catch (error) {
        setStoryItemError(item.id, error.message);
      }
    });
    label.appendChild(input);
    body.appendChild(label);
    if (item.audioData) {
      // Listen on this computer before playing it on Pepper
      const preview = document.createElement("audio");
      preview.className = "story-preview";
      preview.controls = true;
      preview.preload = "none";
      preview.src = item.audioData;
      preview.title = "Preview on this computer";
      body.appendChild(preview);
    }
    storySoundDance(item, body);
  }
}

// The optional dance inside a sound item: it starts together with the sound
function storySoundDance(item, body) {
  const row = document.createElement("div");
  row.className = "story-subblock";
  const label = document.createElement("span");
  label.className = "story-subblock-label";
  label.textContent = "Dance along ↻";
  label.title = "Repeats until the sound ends";
  const root = document.createElement("div");
  root.className = "motion-picker";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "story-subblock-clear";
  clear.textContent = "✕";
  clear.title = "No dance";
  clear.setAttribute("aria-label", "No dance");
  const warning = document.createElement("span");
  warning.className = "story-warning";
  row.append(label, root, clear, warning);
  body.appendChild(row);

  const show = (motion) => {
    clear.hidden = !motion;
    warning.textContent = danceNotFound({ motion }) ? "Not found on this robot" : "";
  };
  const picker = createMotionPicker(root, (path) => {
    setStory(updateItem(story, item.id, { motion: path }), { render: false });
    show(path);
  });
  storyPickers.push(picker);
  if (item.motion) setMotionPickerValue(picker, item.motion);
  show(item.motion);
  clear.addEventListener("click", () => {
    setMotionPickerValue(picker, "");
    setStory(updateItem(story, item.id, { motion: "" }), { render: false });
    show("");
  });
}

const STORY_SOUND_MAX_BYTES = 15 * 1024 * 1024;
const STORY_SOUND_TYPES = { mp3: "audio/mpeg", wav: "audio/wav" };

// The file as a data:audio/... URI. Browsers sometimes report no type (or a
// generic one) for .mp3/.wav, so the extension decides when they do.
function readSoundFile(file) {
  const extension = (file.name.split(".").pop() || "").toLowerCase();
  const type = STORY_SOUND_TYPES[extension] || (/^audio\/(mpeg|mp3|wav|x-wav|wave)$/.test(file.type) ? file.type : null);
  if (!type) return Promise.reject(new Error("Choose an MP3 or WAV file"));
  if (file.size > STORY_SOUND_MAX_BYTES) {
    return Promise.reject(new Error(`${file.name} is too large (15 MB max)`));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^;,]*/, "data:" + type));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function createStoryItemElement(item, index) {
  const li = document.createElement("li");
  li.className = `story-item ${item.type}` + (item.played ? " played" : "");
  li.dataset.id = item.id;
  li.innerHTML = `
    <span class="story-drag" draggable="true" title="Drag to reorder" aria-label="Drag to reorder">⠿</span>
    <span class="story-number">${index + 1}</span>
    <button class="story-play" title="Play now" aria-label="Play now">▶</button>
    <span class="story-type">${escapeHtml(STORY_TYPE_LABELS[item.type])}</span>
    <div class="story-body"></div>
    <span class="story-played" title="Played">✓</span>${isSpeechItem(item)
      ? '<button class="story-audio" title="Download this line as an audio file" aria-label="Download as audio">⬇</button>'
      : ""}
    <button class="story-delete" title="Delete" aria-label="Delete">🗑</button>
    <div class="story-error"></div>`;
  storyItemBody(item, li);
  li.querySelector(".story-delete").addEventListener("click", () => deleteStoryItem(item.id));
  attachStoryDrag(li, item.id);
  storyItemCreatedHook(li, item);
  return li;
}

function storyItemCreatedHook(li, item) {
  const play = li.querySelector(".story-play");
  play.disabled = !canPlayStoryItem(item);
  play.addEventListener("click", () => playStoryItem(item.id));
  const audio = li.querySelector(".story-audio");
  if (audio) {
    audio.disabled = !isConnected;
    audio.addEventListener("click", () => downloadStoryAudio(item.id));
  }
}

function isSpeechItem(item) {
  return item.type === "say" || item.type === "animatedSay";
}

function renderStory() {
  storyPickers.splice(0).forEach(destroyMotionPicker);
  const list = storyEl("storyList");
  list.innerHTML = "";
  story.items.forEach((item, index) => list.appendChild(createStoryItemElement(item, index)));
  storyEl("storyEmpty").hidden = story.items.length > 0;
}

// ─── Editing ─────────────────────────────────────────────────────────────────

function addStoryItem(type) {
  setStory(addItem(story, makeItem(type, nextStoryId())));
  const items = storyEl("storyList").querySelectorAll(".story-item");
  const last = items[items.length - 1];
  last?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  last?.querySelector(".story-text")?.focus();
}

function hideStoryUndo() {
  clearTimeout(storyUndoTimer);
  storyUndo = null;
  storyEl("storyUndoToast").hidden = true;
}

function deleteStoryItem(id) {
  const { story: next, removed } = removeItem(story, id);
  if (!removed) return;
  setStory(next);
  clearTimeout(storyUndoTimer);
  storyUndo = removed;
  const what = removed.item.text || removed.item.name || STORY_TYPE_LABELS[removed.item.type];
  storyEl("storyUndoText").textContent = `Deleted “${what.length > 40 ? what.slice(0, 40) + "…" : what}”`;
  storyEl("storyUndoToast").hidden = false;
  storyUndoTimer = setTimeout(hideStoryUndo, STORY_UNDO_MS);
}

function undoStoryDelete() {
  if (!storyUndo) return;
  const { item, index } = storyUndo;
  hideStoryUndo();
  setStory(restoreItem(story, item, index));
}

function clearStoryDropTargets() {
  storyEl("storyList")
    .querySelectorAll(".drop-target, .dragging")
    .forEach((el) => el.classList.remove("drop-target", "dragging"));
}

function attachStoryDrag(li, id) {
  const handle = li.querySelector(".story-drag");
  handle.addEventListener("dragstart", (e) => {
    draggedStoryId = id;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
    e.dataTransfer.setDragImage?.(li, 20, 20);
    li.classList.add("dragging");
  });
  handle.addEventListener("dragend", () => {
    draggedStoryId = null;
    clearStoryDropTargets();
  });
  li.addEventListener("dragover", (e) => {
    if (!draggedStoryId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    li.classList.add("drop-target");
  });
  li.addEventListener("dragleave", (e) => {
    if (!li.contains(e.relatedTarget)) li.classList.remove("drop-target");
  });
  li.addEventListener("drop", (e) => {
    if (!draggedStoryId) return;
    e.preventDefault();
    const target = story.items.findIndex((item) => item.id === id);
    const moved = draggedStoryId;
    draggedStoryId = null;
    clearStoryDropTargets();
    if (moved !== id && target >= 0) setStory(moveItem(story, moved, target));
  });
}

// ─── Playing ─────────────────────────────────────────────────────────────────

function canPlayStoryItem(item) {
  return isConnected && !(item.type === "image" && !item.imageData) && !(item.type === "sound" && !item.audioData);
}

function storyItemElement(id) {
  return storyEl("storyList").querySelector(`.story-item[data-id="${CSS.escape(id)}"]`);
}

function setStoryItemError(id, message) {
  const li = storyItemElement(id);
  if (li) li.querySelector(".story-error").textContent = message;
}

// The request that plays the item, or an error message when it can't be played
function storyItemRequest(item) {
  if (item.type === "say" || item.type === "animatedSay") {
    const text = item.text.trim();
    if (!text) return { error: "Nothing to say" };
    // interrupt: Pepper stops mid-sentence and says this line now
    return { send: () => postJson("/speak", { text, animated: item.type === "animatedSay", interrupt: true }) };
  }
  if (item.type === "dance") {
    if (!item.motion) return { error: "Choose a dance first" };
    return { send: () => startStoryDance(item.motion) };
  }
  if (item.type === "image") {
    if (!item.imageData) return { error: "Choose an image first" };
    return { send: () => postJson("/send-image", { imageData: item.imageData }) };
  }
  if (item.type === "sound") {
    if (!item.audioData) return { error: "Choose a sound first" };
    // Pepper streams it from the bridge; a new sound replaces the one playing.
    // The bridge starts the dance along (if any) with it and repeats it until
    // the sound ends.
    return { send: () => postJson("/play-sound", { audioData: item.audioData, motion: item.motion || "" }) };
  }
  return { error: `Unknown item type "${item.type}"` };
}

async function startStoryDance(motion) {
  await postJson("/stop-motion"); // two dances at once can't work
  return postJson("/motion", { motion });
}

// Every ▶ fires at once and on its own: nothing waits for an earlier item
async function playStoryItem(id) {
  const item = story.items.find((i) => i.id === id);
  if (!item) return;
  const { send, error } = storyItemRequest(item);
  setStoryItemError(id, error || "");
  if (!send) return;

  setStory(updateItem(story, id, { played: true }), { render: false });
  storyItemElement(id)?.classList.add("played", "playing");
  try {
    const r = await send();
    if (!r.ok) {
      const body = await r.text();
      let message = body;
      try {
        message = JSON.parse(body).error || body; // JSON endpoints
      } catch {
        // plain-text error
      }
      throw new Error(message || `HTTP ${r.status}`);
    }
  } catch (err) {
    setStoryItemError(id, err.message);
    logError(`Story ${STORY_TYPE_LABELS[item.type]}`, err.message);
  } finally {
    storyItemElement(id)?.classList.remove("playing");
  }
}

// "02_hello-there-pepper-here-nice": script position plus the first words
function storyAudioFileName(item, extension) {
  const number = String(story.items.indexOf(item) + 1).padStart(2, "0");
  const words = item.text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, 5)
    .join("-");
  return `${number}_${words || "line"}.${extension}`;
}

// Pepper's voice saved to a file (not spoken) and downloaded: MP3, or WAV
// when the bridge's computer has no ffmpeg
async function downloadStoryAudio(id) {
  const item = story.items.find((i) => i.id === id);
  if (!item) return;
  const text = item.text.trim();
  setStoryItemError(id, text ? "" : "Nothing to say");
  if (!text) return;
  const button = storyItemElement(id)?.querySelector(".story-audio");
  if (button) {
    button.disabled = true;
    button.textContent = "…";
  }
  try {
    const r = await postJson("/speech-audio", { text });
    if (!r.ok) {
      const body = await r.text();
      let message = body;
      try {
        message = JSON.parse(body).error || body;
      } catch {
        // plain-text error
      }
      throw new Error(message || `HTTP ${r.status}`);
    }
    const blob = await r.blob();
    const extension = (r.headers.get("Content-Type") || "").includes("wav") ? "wav" : "mp3";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = storyAudioFileName(item, extension);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (error) {
    setStoryItemError(id, error.message);
    logError("Story audio", error.message);
  } finally {
    const current = storyItemElement(id)?.querySelector(".story-audio");
    if (current) {
      current.disabled = !isConnected;
      current.textContent = "⬇";
    }
  }
}

async function stopStory() {
  const results = await Promise.allSettled([postJson("/stop-speech"), postJson("/stop-motion"), postJson("/stop-sound")]);
  results.forEach((result, i) => {
    const what = ["speech", "motion", "sound"][i];
    if (result.status === "rejected") logError("Story STOP", `Could not stop ${what}: ${result.reason.message}`);
    else if (!result.value.ok) logError("Story STOP", `Could not stop ${what} (HTTP ${result.value.status})`);
  });
}

function resetStoryMarks() {
  setStory(resetMarks(story));
}

function onStoryConnection(connected) {
  storyEl("storyNotConnected").hidden = connected;
  storyEl("storyStopBtn").disabled = !connected;
  story.items.forEach((item) => {
    const play = storyItemElement(item.id)?.querySelector(".story-play");
    if (play) play.disabled = !canPlayStoryItem(item);
    const audio = storyItemElement(item.id)?.querySelector(".story-audio");
    if (audio) audio.disabled = !connected;
  });
  if (connected && storyLoaded) setEyeColor(story.eyeColor);
}

// ─── Export / Import ─────────────────────────────────────────────────────────

function exportStory() {
  const blob = new Blob([JSON.stringify(story, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "pepper_story.json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function importStory(file) {
  if (!file) return;
  let parsed;
  try {
    parsed = validateStory(JSON.parse(await file.text()), nextStoryId);
  } catch (error) {
    alert(error instanceof SyntaxError ? "Could not read the file: " + error.message : error.message);
    return;
  }
  const count = (n) => `${n} item${n === 1 ? "" : "s"}`;
  if (story.items.length > 0 && !confirm(`Replace the current story (${count(story.items.length)})?`)) return;
  hideStoryUndo();
  setStory(parsed.story);
  storyLoadedHook();
  let summary = `Imported ${count(parsed.story.items.length)}`;
  if (parsed.dropped > 0) summary += ` (${count(parsed.dropped)} skipped because it could not be read)`;
  alert(summary);
}

// ─── Wiring ──────────────────────────────────────────────────────────────────

storyEl("storyAddSay").addEventListener("click", () => addStoryItem("say"));
storyEl("storyAddAnimatedSay").addEventListener("click", () => addStoryItem("animatedSay"));
storyEl("storyAddDance").addEventListener("click", () => addStoryItem("dance"));
storyEl("storyAddImage").addEventListener("click", () => addStoryItem("image"));
storyEl("storyAddSound").addEventListener("click", () => addStoryItem("sound"));
storyEl("storyUndoBtn").addEventListener("click", undoStoryDelete);
storyEl("storyExport").addEventListener("click", exportStory);
storyEl("storyImportBtn").addEventListener("click", () => storyEl("storyImportInput").click());
storyEl("storyImportInput").addEventListener("change", (e) => {
  importStory(e.target.files[0]);
  e.target.value = "";
});

storyEl("storyResetMarks").addEventListener("click", resetStoryMarks);
storyEl("storyStopBtn").addEventListener("click", stopStory);
storyEl("storyGoConnect").addEventListener("click", () => showTab("controller"));
storyEl("storyEyeColorPicker").addEventListener("change", (e) => setEyeColor(e.target.value));
eyeColorListeners.push((color) => {
  if (storyLoaded && story.eyeColor !== color) setStory({ ...story, eyeColor: color }, { render: false });
});
connectionListeners.push(onStoryConnection);

renderStory();
onStoryConnection(isConnected);
loadStory();
