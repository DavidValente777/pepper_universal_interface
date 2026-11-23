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
const HEY = "animations/Stand/Gestures/Hey_1";

// Fresh page on the Story tab holding `items`, connected to the fake robot
async function fresh(items, { connected = true } = {}) {
  const story = { version: 1, eyeColor: "#ffffff", items };
  await page.evaluate(`
    localStorage.setItem("__fakeStory", ${JSON.stringify(JSON.stringify(story))});
    localStorage.setItem("__fakeFailures", "{}");
    localStorage.setItem("pepper.activeTab", "story");
    localStorage.removeItem(CONNECTION_STORAGE_KEY);`); // the test connects itself: no automatic reconnect racing it
  await page.reload();
  await page.evaluate(`
    for (let i = 0; i < 250 && !storyLoaded; i++) await new Promise((r) => setTimeout(r, 20));
    if (${connected}) {
      __bridge.connected = true;
      await checkConnectionStatus();
    }
    __bridge.calls.length = 0;`);
}

const item = (id, type, extra) => ({ id, type, played: false, ...extra });
const PLAY = (index) => `document.querySelectorAll("#storyList .story-play")[${index}].click();`;
const BODIES = (path) => `__bridge.calls.filter((c) => c.path === "${path}").map((c) => c.body && JSON.parse(c.body))`;

test("say ▶ sends interrupting speech and marks the item played", async () => {
  await fresh([item("a", "say", { text: "Hello" })]);
  await page.evaluate(PLAY(0));
  await sleep(100);
  const result = await page.evaluate(`return {
    bodies: ${BODIES("/speak")},
    playedClass: document.querySelector("#storyList .story-item").classList.contains("played"),
    played: story.items[0].played,
  };`);
  assert.deepEqual(result.bodies, [{ text: "Hello", animated: false, interrupt: true }]);
  assert.equal(result.playedClass, true);
  assert.equal(result.played, true);
});

test("animated say ▶ sends animated speech", async () => {
  await fresh([item("a", "animatedSay", { text: "Wave" })]);
  await page.evaluate(PLAY(0));
  await sleep(100);
  assert.deepEqual(await page.evaluate(`return ${BODIES("/speak")};`), [{ text: "Wave", animated: true, interrupt: true }]);
});

test("a second line pressed while the first is still speaking goes out at once", async () => {
  await fresh([item("a", "say", { text: "One" }), item("b", "say", { text: "Two" })]);
  const gap = await page.evaluate(`
    __bridge.delays["/speak"] = 2000;
    ${PLAY(0)}
    await new Promise((r) => setTimeout(r, 50));
    ${PLAY(1)}
    await new Promise((r) => setTimeout(r, 50));
    const calls = __bridge.calls.filter((c) => c.path === "/speak");
    __bridge.delays["/speak"] = 0;
    return calls.length === 2 ? calls[1].start - calls[0].start : null;`);
  assert.ok(gap !== null && gap < 200, `second /speak started ${gap} ms after the first`);
});

test("dance ▶ stops the current motion, then plays the dance", async () => {
  await fresh([item("a", "dance", { motion: HEY })]);
  await page.evaluate(PLAY(0));
  await sleep(100);
  const result = await page.evaluate(`
    const paths = __bridge.calls.map((c) => c.path).filter((p) => p === "/stop-motion" || p === "/motion");
    return { paths, body: ${BODIES("/motion")}[0] };`);
  assert.deepEqual(result.paths, ["/stop-motion", "/motion"]);
  assert.deepEqual(result.body, { motion: HEY });
});

test("image ▶ sends the image and is disabled without one", async () => {
  await fresh([
    item("a", "image", { name: "a.png", imageData: "data:image/png;base64,AA" }),
    item("b", "image", { name: "", imageData: "" }),
  ]);
  const result = await page.evaluate(`
    ${PLAY(0)}
    await new Promise((r) => setTimeout(r, 100));
    return { bodies: ${BODIES("/send-image")},
      disabled: [...document.querySelectorAll("#storyList .story-play")].map((b) => b.disabled) };`);
  assert.deepEqual(result.bodies, [{ imageData: "data:image/png;base64,AA" }]);
  assert.deepEqual(result.disabled, [false, true]);
});

test("a failed play shows the error on the item and in the log", async () => {
  await fresh([item("a", "say", { text: "Hello" })]);
  const result = await page.evaluate(`
    __bridge.failures["/speak"] = "boom";
    ${PLAY(0)}
    await new Promise((r) => setTimeout(r, 100));
    delete __bridge.failures["/speak"];
    return { error: document.querySelector("#storyList .story-error").textContent,
      log: document.getElementById("errorLogEntries").textContent };`);
  assert.equal(result.error, "boom");
  assert.match(result.log, /Story/);
});

test("an empty say shows Nothing to say and sends nothing", async () => {
  await fresh([item("a", "say", { text: "  " }), item("b", "dance", { motion: "" })]);
  const result = await page.evaluate(`
    ${PLAY(0)} ${PLAY(1)}
    await new Promise((r) => setTimeout(r, 100));
    return { errors: [...document.querySelectorAll("#storyList .story-error")].map((e) => e.textContent),
      calls: __bridge.calls.filter((c) => ["/speak", "/motion", "/stop-motion"].includes(c.path)).length };`);
  assert.deepEqual(result.errors, ["Nothing to say", "Choose a dance first"]);
  assert.equal(result.calls, 0);
});

test("Reset marks clears every tick", async () => {
  await fresh([item("a", "say", { text: "x", played: true }), item("b", "say", { text: "y", played: true })]);
  const result = await page.evaluate(`
    document.getElementById("storyResetMarks").click();
    return { played: story.items.map((i) => i.played),
      ticks: document.querySelectorAll("#storyList .story-item.played").length };`);
  assert.deepEqual(result, { played: [false, false], ticks: 0 });
});

test("sound ▶ sends the sound and is disabled without one", async () => {
  await fresh([
    item("a", "sound", { name: "song.mp3", audioData: "data:audio/mpeg;base64,AA" }),
    item("b", "sound", { name: "", audioData: "" }),
  ]);
  const result = await page.evaluate(`
    ${PLAY(0)}
    await new Promise((r) => setTimeout(r, 100));
    return { bodies: ${BODIES("/play-sound")},
      disabled: [...document.querySelectorAll("#storyList .story-play")].map((b) => b.disabled),
      preview: [...document.querySelectorAll("#storyList .story-item")].map((li) => !!li.querySelector("audio.story-preview")),
      labels: [...document.querySelectorAll("#storyList .story-image-label")].map((l) => l.textContent) };`);
  assert.deepEqual(result.bodies, [{ audioData: "data:audio/mpeg;base64,AA", motion: "" }]);
  assert.deepEqual(result.disabled, [false, true]);
  assert.deepEqual(result.preview, [true, false]);
  assert.deepEqual(result.labels, ["song.mp3", "Choose sound…"]);
});

test("a sound with a dance along hands both to the bridge in one request; ✕ removes the dance", async () => {
  await fresh([item("a", "sound", { name: "song.mp3", audioData: "data:audio/mpeg;base64,AA", motion: HEY })]);
  const result = await page.evaluate(`
    ${PLAY(0)}
    await new Promise((r) => setTimeout(r, 100));
    const paths = __bridge.calls.map((c) => c.path).filter((p) => ["/play-sound", "/stop-motion", "/motion"].includes(p));
    const clear = document.querySelector("#storyList .story-subblock-clear");
    const clearShown = !clear.hidden;
    clear.click();
    return { paths, body: ${BODIES("/play-sound")}[0], clearShown, clearHidden: clear.hidden,
      motion: story.items[0].motion,
      label: document.querySelector("#storyList .story-subblock .motion-picker-value").textContent };`);
  assert.deepEqual(result.paths, ["/play-sound"], "the bridge starts and repeats the dance itself");
  assert.deepEqual(result.body, { audioData: "data:audio/mpeg;base64,AA", motion: HEY });
  assert.equal(result.clearShown, true);
  assert.equal(result.clearHidden, true);
  assert.equal(result.motion, "");
  assert.equal(result.label, "-- Select motion --");
});

test("a sound the bridge can't play shows the bridge's message on the item", async () => {
  await fresh([item("a", "sound", { name: "t.mp3", audioData: "data:audio/mpeg;base64,AA", motion: HEY })]);
  const result = await page.evaluate(`
    __bridge.failures["/play-sound"] = JSON.stringify({ success: false, error: "Behavior 'x' is not installed on the robot" });
    ${PLAY(0)}
    await new Promise((r) => setTimeout(r, 100));
    delete __bridge.failures["/play-sound"];
    return document.querySelector("#storyList .story-error").textContent;`);
  assert.equal(result, "Behavior 'x' is not installed on the robot");
});

test("+ Sound adds a sound item; choosing a file stores it as audio, other files are refused", async () => {
  await fresh([]);
  const result = await page.evaluate(`
    document.getElementById("storyAddSound").click();
    const choose = async (file) => {
      const input = document.querySelector("#storyList .story-item.sound input[type=file]");
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("change"));
      await new Promise((r) => setTimeout(r, 100));
    };
    await choose(new File(["hello"], "notes.txt", { type: "text/plain" }));
    const refused = document.querySelector("#storyList .story-error").textContent;
    await choose(new File(["ID3"], "song.mp3", { type: "" }));
    return { refused, item: story.items[0] };`);
  assert.equal(result.refused, "Choose an MP3 or WAV file");
  assert.equal(result.item.type, "sound");
  assert.equal(result.item.name, "song.mp3");
  assert.equal(result.item.audioData, "data:audio/mpeg;base64,SUQz");
});

test("STOP stops speech, sound and motion but leaves the tablet", async () => {
  await fresh([]);
  const paths = await page.evaluate(`
    document.getElementById("storyStopBtn").click();
    await new Promise((r) => setTimeout(r, 100));
    return __bridge.calls.map((c) => c.path);`);
  assert.ok(paths.includes("/stop-speech"));
  assert.ok(paths.includes("/stop-motion"));
  assert.ok(paths.includes("/stop-sound"));
  assert.ok(!paths.includes("/clear-tablet"));
});

test("disconnecting disables play and STOP but not editing", async () => {
  await fresh([item("a", "say", { text: "x" })]);
  const STATE = `return {
    play: document.querySelector("#storyList .story-play").disabled,
    stop: document.getElementById("storyStopBtn").disabled,
    banner: !document.getElementById("storyNotConnected").hidden,
    add: document.getElementById("storyAddSay").disabled,
  };`;
  const offline = await page.evaluate(`markDisconnected(); ${STATE}`);
  assert.deepEqual(offline, { play: true, stop: true, banner: true, add: false });
  const online = await page.evaluate(`await checkConnectionStatus(); ${STATE}`);
  assert.deepEqual(online, { play: false, stop: false, banner: false, add: false });
});

test("the Story volume slider moves the Controller one and sends once", async () => {
  await fresh([]);
  const result = await page.evaluate(`
    const slider = document.getElementById("storyVolumeSlider");
    slider.value = 30;
    slider.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 300));
    return { twin: document.getElementById("volumeSlider").value,
      label: document.getElementById("storyVolumeValue").textContent,
      bodies: ${BODIES("/set-volume")} };`);
  assert.deepEqual(result, { twin: "30", label: "30%", bodies: [{ value: 30 }] });
});

test("the Story speech speed slider moves the Controller one and sends once", async () => {
  await fresh([]);
  const result = await page.evaluate(`
    const slider = document.getElementById("storySpeedSlider");
    slider.value = 75;
    slider.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 300));
    return { twin: document.getElementById("speedSlider").value,
      label: document.getElementById("storySpeedValue").textContent,
      bodies: ${BODIES("/set-speed")} };`);
  assert.deepEqual(result, { twin: "75", label: "75%", bodies: [{ value: 75 }] });
});

test("the Story word gap slider moves the Controller one and shows Off at 0", async () => {
  await fresh([]);
  const result = await page.evaluate(`
    const slider = document.getElementById("storyWordGapSlider");
    slider.value = 120;
    slider.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 300));
    const moved = { twin: document.getElementById("wordGapSlider").value,
      label: document.getElementById("storyWordGapValue").textContent };
    slider.value = 0;
    slider.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 300));
    return { ...moved, off: document.getElementById("wordGapValue").textContent,
      bodies: ${BODIES("/set-word-gap")} };`);
  assert.deepEqual(result, { twin: "120", label: "120 ms", off: "Off", bodies: [{ value: 120 }, { value: 0 }] });
});

test("eye colour syncs both pickers, the robot and the story", async () => {
  await fresh([]);
  const result = await page.evaluate(`
    const picker = document.getElementById("storyEyeColorPicker");
    picker.value = "#0000ff";
    picker.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 100));
    return { twin: document.getElementById("eyeColorPicker").value, bodies: ${BODIES("/eyes")},
      story: story.eyeColor };`);
  assert.deepEqual(result, { twin: "#0000ff", bodies: [{ color: "#0000ff" }], story: "#0000ff" });
});

test("the story's eye colour is applied to Pepper on connect", async () => {
  await page.evaluate(`
    localStorage.removeItem(CONNECTION_STORAGE_KEY);
    localStorage.setItem("__fakeStory", JSON.stringify({ version: 1, eyeColor: "#ff0000", items: [] }));`);
  await page.reload();
  const result = await page.evaluate(`
    for (let i = 0; i < 250 && !storyLoaded; i++) await new Promise((r) => setTimeout(r, 20));
    const before = ${BODIES("/eyes")};
    __bridge.connected = true;
    await checkConnectionStatus();
    await new Promise((r) => setTimeout(r, 100));
    return { before, after: ${BODIES("/eyes")}, picker: document.getElementById("storyEyeColorPicker").value };`);
  assert.deepEqual(result.before, []);
  assert.deepEqual(result.after, [{ color: "#ff0000" }]);
  assert.equal(result.picker, "#ff0000");
});

// Clicks the ⬇ of item `index` and returns the request body and the downloaded file
const DOWNLOAD = (index) => `
  let saved = null;
  URL.createObjectURL = (blob) => { saved = { blob }; return "blob:audio"; };
  URL.revokeObjectURL = () => {};
  const realClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { if (saved) saved.name = this.download; };
  document.querySelectorAll("#storyList .story-item")[${index}].querySelector(".story-audio").click();
  for (let i = 0; i < 50 && !(saved && saved.name); i++) await new Promise((r) => setTimeout(r, 20));
  HTMLAnchorElement.prototype.click = realClick;
  return { bodies: ${BODIES("/speech-audio")}, name: saved && saved.name, type: saved && saved.blob.type,
    error: document.querySelectorAll("#storyList .story-error")[${index}].textContent };`;

test("only speech lines have a download-audio button", async () => {
  await fresh([item("a", "say", { text: "x" }), item("b", "animatedSay", { text: "y" }),
    item("c", "dance", { motion: HEY }), item("d", "image", { name: "", imageData: "" })]);
  const has = await page.evaluate(`return [...document.querySelectorAll("#storyList .story-item")]
    .map((li) => !!li.querySelector(".story-audio"));`);
  assert.deepEqual(has, [true, true, false, false]);
});

test("⬇ downloads the line as a numbered MP3 named after its first words", async () => {
  await fresh([item("a", "say", { text: "x" }), item("b", "animatedSay", { text: "Hello there — Pepper here, nice to meet you all!" })]);
  const result = await page.evaluate(DOWNLOAD(1));
  assert.deepEqual(result.bodies, [{ text: "Hello there — Pepper here, nice to meet you all!" }]);
  assert.equal(result.name, "02_hello-there-pepper-here-nice.mp3");
  assert.equal(result.type, "audio/mpeg");
  assert.equal(result.error, "");
});

test("⬇ saves a .wav when the bridge has no ffmpeg", async () => {
  await fresh([item("a", "say", { text: "Hi" })]);
  const result = await page.evaluate(`__bridge.audioType = "audio/wav"; ${DOWNLOAD(0).replace("return {", "const out = {")}
    delete __bridge.audioType; return out;`);
  assert.equal(result.name, "01_hi.wav");
});

test("⬇ on an empty line says so, and a failure shows on the item", async () => {
  await fresh([item("a", "say", { text: " " }), item("b", "say", { text: "Hi" })]);
  const empty = await page.evaluate(DOWNLOAD(0));
  assert.deepEqual([empty.bodies, empty.error], [[], "Nothing to say"]);
  const failed = await page.evaluate(`__bridge.failures["/speech-audio"] = "robot busy"; ${DOWNLOAD(1)}`);
  assert.equal(failed.error, "robot busy");
});

test("⬇ is disabled while disconnected", async () => {
  await fresh([item("a", "say", { text: "Hi" })], { connected: false });
  const disabled = await page.evaluate(`return document.querySelector("#storyList .story-audio").disabled;`);
  assert.equal(disabled, true);
});
