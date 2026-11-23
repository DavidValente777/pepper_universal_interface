const test = require("node:test");
const assert = require("node:assert/strict");
const st = require("../story.js");

const ids = (story) => story.items.map((item) => item.id);
const storyOf = (...items) => ({ version: 1, eyeColor: "#ffffff", items });
const say = (id, text = "hi") => ({ id, type: "say", text, played: false });

test("emptyStory has no items and white eyes", () => {
  assert.deepEqual(st.emptyStory(), { version: 1, eyeColor: "#ffffff", items: [] });
  assert.deepEqual(st.STORY_ITEM_TYPES, ["say", "animatedSay", "dance", "image", "sound"]);
});

test("makeItem shapes each kind", () => {
  assert.deepEqual(st.makeItem("say", "a"), { id: "a", type: "say", played: false, text: "" });
  assert.deepEqual(st.makeItem("animatedSay", "b"), { id: "b", type: "animatedSay", played: false, text: "" });
  assert.deepEqual(st.makeItem("dance", "c"), { id: "c", type: "dance", played: false, motion: "" });
  assert.deepEqual(st.makeItem("image", "d"), { id: "d", type: "image", played: false, name: "", imageData: "" });
  assert.deepEqual(st.makeItem("sound", "e"), { id: "e", type: "sound", played: false, name: "", audioData: "", motion: "" });
});

test("validateStory keeps sounds with audio data URIs or none yet", () => {
  let n = 0;
  const { story, dropped } = st.validateStory({
    items: [
      { type: "sound", name: "song.mp3", audioData: "data:audio/mpeg;base64,AA" },
      { type: "sound", name: "", audioData: "", motion: "animations/Stand/Gestures/Hey_1" },
      { type: "sound", name: "x.png", audioData: "data:image/png;base64,AA" },
      { type: "sound", audioData: "data:audio/mpeg;base64,AA" },
    ],
  }, () => `id${++n}`);
  assert.equal(dropped, 2);
  assert.deepEqual(story.items, [
    { id: "id1", type: "sound", played: false, name: "song.mp3", audioData: "data:audio/mpeg;base64,AA", motion: "" },
    { id: "id2", type: "sound", played: false, name: "", audioData: "", motion: "animations/Stand/Gestures/Hey_1" },
  ]);
});

test("addItem and updateItem return new stories", () => {
  const start = st.emptyStory();
  const added = st.addItem(start, say("a"));
  assert.deepEqual(ids(added), ["a"]);
  assert.equal(start.items.length, 0, "input unchanged");
  const updated = st.updateItem(added, "a", { text: "Hello" });
  assert.equal(updated.items[0].text, "Hello");
  assert.equal(added.items[0].text, "hi", "input unchanged");
});

test("removeItem then restoreItem puts it back in place", () => {
  const story = storyOf(say("a"), say("b"), say("c"));
  const { story: without, removed } = st.removeItem(story, "b");
  assert.deepEqual(ids(without), ["a", "c"]);
  assert.deepEqual(removed, { item: say("b"), index: 1 });
  assert.deepEqual(ids(st.restoreItem(without, removed.item, removed.index)), ["a", "b", "c"]);
  assert.equal(st.removeItem(story, "zzz").removed, null);
  assert.deepEqual(ids(st.restoreItem(without, say("x"), 99)), ["a", "c", "x"], "index clamped");
});

test("moveItem moves to the final position, clamped", () => {
  const story = storyOf(say("a"), say("b"), say("c"));
  assert.deepEqual(ids(st.moveItem(story, "a", 2)), ["b", "c", "a"]);
  assert.deepEqual(ids(st.moveItem(story, "c", 0)), ["c", "a", "b"]);
  assert.deepEqual(ids(st.moveItem(story, "a", 50)), ["b", "c", "a"]);
  assert.deepEqual(ids(st.moveItem(story, "c", -3)), ["c", "a", "b"]);
  assert.deepEqual(ids(story), ["a", "b", "c"], "input unchanged");
});

test("resetMarks clears every played mark", () => {
  const story = storyOf({ ...say("a"), played: true }, say("b"));
  assert.deepEqual(st.resetMarks(story).items.map((i) => i.played), [false, false]);
});

test("validateStory keeps valid items with fresh ids and drops the rest", () => {
  let n = 0;
  const { story, dropped } = st.validateStory({
    eyeColor: "#00FF00",
    items: [
      { id: "old", type: "say", text: "Hello", played: true },
      { type: "animatedSay", text: "Hi", played: "yes" },
      { type: "dance", motion: "animations/Stand/Gestures/Hey_1" },
      { type: "image", name: "a.png", imageData: "data:image/png;base64,AA" },
      { type: "image", name: "empty.png", imageData: "" },
      { type: "say", text: 5 },
      { type: "image", name: "x", imageData: "javascript:x" },
      { type: "nope" },
      null,
    ],
  }, () => `id${++n}`);
  assert.equal(dropped, 4);
  assert.deepEqual(story.items.map((i) => i.type), ["say", "animatedSay", "dance", "image", "image"]);
  assert.deepEqual(ids(story), ["id1", "id2", "id3", "id4", "id5"]);
  assert.deepEqual(story.items.map((i) => i.played), [true, false, false, false, false]);
  assert.equal(story.eyeColor, "#00FF00");
  assert.equal(story.version, 1);
});

test("validateStory defaults a bad eye colour and refuses non-stories", () => {
  assert.equal(st.validateStory({ eyeColor: "red", items: [] }, () => "x").story.eyeColor, "#ffffff");
  for (const bad of [null, [], { items: "x" }, "story"]) {
    assert.throws(() => st.validateStory(bad, () => "x"), /not a Pepper story file/);
  }
});
