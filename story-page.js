// ─── Story page ──────────────────────────────────────────────────────────────
// A running script the operator prepares before filming and fires item by item.
// The story is saved on the laptop through the bridge (GET/POST /story).
// Uses story.js for the model and controller.js for shared helpers.

const STORY_TYPE_LABELS = { say: "Say", animatedSay: "Animated say", dance: "Dance", image: "Image" };
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

// A reload right after typing must not lose the last line
window.addEventListener("pagehide", () => {
  if (!storyLoaded || !storyUnsaved) return;
  navigator.sendBeacon("/story", new Blob([JSON.stringify(story)], { type: "application/json" }));
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
  }
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
    <span class="story-played" title="Played">✓</span>
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
  return isConnected && !(item.type === "image" && !item.imageData);
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
    return {
      send: async () => {
        await postJson("/stop-motion"); // two dances at once can't work
        return postJson("/motion", { motion: item.motion });
      },
    };
  }
  if (item.type === "image") {
    if (!item.imageData) return { error: "Choose an image first" };
    return { send: () => postJson("/send-image", { imageData: item.imageData }) };
  }
  return { error: `Unknown item type "${item.type}"` };
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
    if (!r.ok) throw new Error((await r.text()) || `HTTP ${r.status}`);
  } catch (err) {
    setStoryItemError(id, err.message);
    logError(`Story ${STORY_TYPE_LABELS[item.type]}`, err.message);
  } finally {
    storyItemElement(id)?.classList.remove("playing");
  }
}

async function stopStory() {
  const results = await Promise.allSettled([postJson("/stop-speech"), postJson("/stop-motion")]);
  results.forEach((result, i) => {
    const what = i === 0 ? "speech" : "motion";
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
