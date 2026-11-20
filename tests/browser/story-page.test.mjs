import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openControllerPage } from "./harness.mjs";

let page;
before(async () => {
  page = await openControllerPage();
});
after(async () => {
  await page?.evaluate(`localStorage.clear();`).catch(() => {});
  await page?.close();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Reloads the page with the fake bridge holding `story` (or failing GET /story)
// and waits until the Story page has finished loading
async function fresh(story = null, failures = {}) {
  await page.evaluate(`
    localStorage.setItem("__fakeStory", ${JSON.stringify(JSON.stringify(story))});
    localStorage.setItem("__fakeFailures", ${JSON.stringify(JSON.stringify(failures))});
    localStorage.setItem("pepper.activeTab", "story");`);
  await page.reload();
  await page.evaluate(`
    for (let i = 0; i < 50 && !storyLoaded && document.getElementById("storyLoadError").hidden; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }`);
}

const say = (id, text) => ({ id, type: "say", text, played: false });
const STORY_POSTS = `__bridge.calls.filter((c) => c.path === "/story" && c.method === "POST")`;

test("adds one item of each kind in order", async () => {
  await fresh();
  const labels = await page.evaluate(`
    ["storyAddSay", "storyAddAnimatedSay", "storyAddDance", "storyAddImage"]
      .forEach((id) => document.getElementById(id).click());
    return [...document.querySelectorAll("#storyList .story-item .story-type")].map((el) => el.textContent);`);
  assert.deepEqual(labels, ["Say", "Animated say", "Dance", "Image"]);
  assert.deepEqual(page.exceptions, []);
});

test("typing autosaves once, 500 ms after the last change", async () => {
  await fresh({ version: 1, eyeColor: "#ffffff", items: [say("a", "")] });
  await page.evaluate(`
    const box = document.querySelector("#storyList .story-text");
    for (const text of ["H", "He", "Hello"]) {
      box.value = text;
      box.dispatchEvent(new Event("input", { bubbles: true }));
    }`);
  assert.equal(await page.evaluate(`return ${STORY_POSTS}.length;`), 0, "nothing saved before the debounce");
  await sleep(800);
  const result = await page.evaluate(`return {
    posts: ${STORY_POSTS}.map((c) => JSON.parse(c.body).items[0].text),
    status: document.getElementById("storySaveStatus").textContent,
  };`);
  assert.deepEqual(result.posts, ["Hello"]);
  assert.match(result.status, /Saved/);
});

test("saves never overlap and the last one holds the latest text", async () => {
  await fresh({ version: 1, eyeColor: "#ffffff", items: [say("a", "")] });
  await page.evaluate(`
    __bridge.delays["/story"] = 400;
    window.__type = (text) => {
      const box = document.querySelector("#storyList .story-text");
      box.value = text;
      box.dispatchEvent(new Event("input", { bubbles: true }));
    };
    __type("a");`);
  await sleep(650); // first save is now in flight
  await page.evaluate(`__type("b");`);
  await sleep(1600);
  const result = await page.evaluate(`
    const posts = ${STORY_POSTS};
    return {
      overlapping: posts.some((c, i) => i > 0 && c.start < posts[i - 1].end),
      count: posts.length,
      saved: __bridge.story.items[0].text,
    };`);
  assert.equal(result.overlapping, false);
  assert.equal(result.count, 2);
  assert.equal(result.saved, "b");
});

test("delete then Undo restores the item in place", async () => {
  await fresh({ version: 1, eyeColor: "#ffffff", items: [say("a", "one"), say("b", "two"), say("c", "three")] });
  const result = await page.evaluate(`
    const texts = () => [...document.querySelectorAll("#storyList .story-text")].map((el) => el.value);
    document.querySelectorAll("#storyList .story-delete")[1].click();
    const afterDelete = texts();
    const toastShown = !document.getElementById("storyUndoToast").hidden;
    document.getElementById("storyUndoBtn").click();
    return { afterDelete, toastShown, afterUndo: texts(),
      toastHidden: document.getElementById("storyUndoToast").hidden };`);
  assert.deepEqual(result.afterDelete, ["one", "three"]);
  assert.equal(result.toastShown, true);
  assert.deepEqual(result.afterUndo, ["one", "two", "three"]);
  assert.equal(result.toastHidden, true);
});

test("dragging an item by its handle reorders the script and saves", async () => {
  await fresh({ version: 1, eyeColor: "#ffffff", items: [say("a", "one"), say("b", "two"), say("c", "three")] });
  const texts = await page.evaluate(`
    const items = document.querySelectorAll("#storyList .story-item");
    const dt = new DataTransfer();
    const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    fire(items[2].querySelector(".story-drag"), "dragstart");
    fire(items[0], "dragover");
    fire(items[0], "drop");
    fire(items[2].querySelector(".story-drag"), "dragend");
    return [...document.querySelectorAll("#storyList .story-text")].map((el) => el.value);`);
  assert.deepEqual(texts, ["three", "one", "two"]);
  await sleep(700);
  assert.deepEqual(await page.evaluate(`return __bridge.story.items.map((i) => i.text);`), ["three", "one", "two"]);
});

test("loads the saved story on start", async () => {
  await fresh({ version: 1, eyeColor: "#ffffff", items: [say("a", "Hello")] });
  assert.equal(await page.evaluate(`return document.querySelector("#storyList .story-text").value;`), "Hello");
});

test("a failed load shows an error and never saves over the file", async () => {
  await fresh(null, { "/story": "disk on fire" });
  await page.evaluate(`document.getElementById("storyAddSay").click();`);
  await sleep(800);
  const result = await page.evaluate(`return {
    errorShown: !document.getElementById("storyLoadError").hidden,
    posts: ${STORY_POSTS}.length,
  };`);
  assert.deepEqual(result, { errorShown: true, posts: 0 });
});

test("closing the page right after a change sends it with a beacon", async () => {
  await fresh({ version: 1, eyeColor: "#ffffff", items: [say("a", "")] });
  const beacon = await page.evaluate(`
    let sent = null;
    navigator.sendBeacon = (url, blob) => { sent = { url, blob }; return true; };
    const box = document.querySelector("#storyList .story-text");
    box.value = "Last words";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    window.dispatchEvent(new Event("pagehide"));
    return sent && { url: sent.url, text: JSON.parse(await sent.blob.text()).items[0].text };`);
  assert.deepEqual(beacon, { url: "/story", text: "Last words" });
});

test("import replaces the story and reports skipped items", async () => {
  await fresh({ version: 1, eyeColor: "#ffffff", items: [say("a", "old")] });
  const result = await page.evaluate(`
    const file = new File([JSON.stringify({ items: [{ type: "say", text: "new" }, { type: "bad" }] })], "s.json");
    await importStory(file);
    return { texts: [...document.querySelectorAll("#storyList .story-text")].map((el) => el.value),
      dialog: __bridge.dialogs[__bridge.dialogs.length - 1] };`);
  assert.deepEqual(result.texts, ["new"]);
  assert.match(result.dialog, /1 item.*skipped/);
});

test("export downloads the story", async () => {
  await fresh({ version: 1, eyeColor: "#123456", items: [say("a", "Hello")] });
  const exported = await page.evaluate(`
    let blob = null;
    URL.createObjectURL = (b) => { blob = b; return "blob:x"; };
    URL.revokeObjectURL = () => {};
    document.getElementById("storyExport").click();
    return JSON.parse(await blob.text());`);
  assert.equal(exported.eyeColor, "#123456");
  assert.deepEqual(exported.items.map((i) => i.text), ["Hello"]);
});
