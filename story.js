// Story page script model. A story is an ordered list of items the operator
// fires one at a time during filming. Pure helpers shared by story-page.js
// and the Node tests: no DOM access, and inputs are never modified.

const STORY_ITEM_TYPES = ["say", "animatedSay", "dance", "image", "sound"];
const DEFAULT_EYE_COLOR = "#ffffff";
const EYE_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function emptyStory() {
  return { version: 1, eyeColor: DEFAULT_EYE_COLOR, items: [] };
}

function makeItem(type, id) {
  const item = { id, type, played: false };
  if (type === "say" || type === "animatedSay") return { ...item, text: "" };
  if (type === "dance") return { ...item, motion: "" };
  if (type === "image") return { ...item, name: "", imageData: "" };
  // motion: optional dance that starts together with the sound
  if (type === "sound") return { ...item, name: "", audioData: "", motion: "" };
  throw new Error(`Unknown story item type "${type}"`);
}

function addItem(story, item) {
  return { ...story, items: [...story.items, item] };
}

function updateItem(story, id, changes) {
  return { ...story, items: story.items.map((item) => (item.id === id ? { ...item, ...changes } : item)) };
}

function removeItem(story, id) {
  const index = story.items.findIndex((item) => item.id === id);
  if (index < 0) return { story, removed: null };
  return {
    story: { ...story, items: story.items.filter((item) => item.id !== id) },
    removed: { item: story.items[index], index },
  };
}

function clampIndex(index, length) {
  return Math.max(0, Math.min(index, length));
}

function restoreItem(story, item, index) {
  const items = story.items.slice();
  items.splice(clampIndex(index, items.length), 0, item);
  return { ...story, items };
}

// toIndex is where the item ends up
function moveItem(story, id, toIndex) {
  const { story: without, removed } = removeItem(story, id);
  if (!removed) return story;
  return restoreItem(without, removed.item, toIndex);
}

function resetMarks(story) {
  return { ...story, items: story.items.map((item) => ({ ...item, played: false })) };
}

// Returns the item with only its known fields, or null when the page could
// not safely render and play it
function validateItem(raw) {
  if (!raw || typeof raw !== "object" || !STORY_ITEM_TYPES.includes(raw.type)) return null;
  const played = raw.played === true;
  switch (raw.type) {
    case "say":
    case "animatedSay":
      return typeof raw.text === "string" ? { type: raw.type, played, text: raw.text } : null;
    case "dance":
      return typeof raw.motion === "string" ? { type: raw.type, played, motion: raw.motion } : null;
    case "image": {
      const okImage = raw.imageData === "" || (typeof raw.imageData === "string" && raw.imageData.startsWith("data:image/"));
      return typeof raw.name === "string" && okImage
        ? { type: raw.type, played, name: raw.name, imageData: raw.imageData }
        : null;
    }
    case "sound": {
      const okAudio = raw.audioData === "" || (typeof raw.audioData === "string" && raw.audioData.startsWith("data:audio/"));
      return typeof raw.name === "string" && okAudio
        ? { type: raw.type, played, name: raw.name, audioData: raw.audioData,
            motion: typeof raw.motion === "string" ? raw.motion : "" }
        : null;
    }
    default:
      return null;
  }
}

function validateStory(data, makeId) {
  if (!data || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.items)) {
    throw new Error("This is not a Pepper story file.");
  }
  const items = [];
  let dropped = 0;
  data.items.forEach((raw) => {
    const item = validateItem(raw);
    if (item) items.push({ id: makeId(), ...item });
    else dropped += 1;
  });
  const eyeColor = typeof data.eyeColor === "string" && EYE_COLOR_PATTERN.test(data.eyeColor)
    ? data.eyeColor
    : DEFAULT_EYE_COLOR;
  return { story: { version: 1, eyeColor, items }, dropped };
}

if (typeof module !== "undefined") {
  module.exports = {
    STORY_ITEM_TYPES,
    emptyStory,
    makeItem,
    addItem,
    updateItem,
    removeItem,
    restoreItem,
    moveItem,
    resetMarks,
    validateStory,
  };
}
