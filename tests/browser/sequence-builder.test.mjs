import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openControllerPage } from "./harness.mjs";

let page;
before(async () => {
  page = await openControllerPage();
});
after(async () => {
  await page?.close();
});

test("the controller page loads without errors and has sequence.js", async () => {
  const loaded = await page.evaluate(`return {
    timeline: !!document.getElementById("timeline"),
    sequenceHelpers: typeof canJoinStep === "function" && typeof parseTimelineFile === "function",
  };`);
  assert.deepEqual(loaded, { timeline: true, sequenceHelpers: true });
  assert.deepEqual(page.exceptions, []);
});

const SPEECH = { type: "speech", text: "Hello" };
const SPEECH_2 = { type: "speech", text: "Hi all" };
const MOTION = { type: "motion", motion: "animations/Stand/Gestures/Hey_1", displayName: "Hey" };
const DELAY = { type: "delay", seconds: 1 };
const TEXT = { type: "text", text: "Hi", fontSize: 110, color: "#000000" };

test("steps render as columns with arrows only between steps", async () => {
  const layout = await page.evaluate(`
    __t.load(${JSON.stringify([[SPEECH], [MOTION, SPEECH_2], [DELAY]])});
    const steps = [...document.querySelectorAll("#timeline .timeline-step")];
    const gaps = [...document.querySelectorAll("#timeline .timeline-gap")];
    return {
      headers: steps.map((s) => s.querySelector(".step-header").textContent),
      blocksPerStep: steps.map((s) => s.querySelectorAll(".timeline-block").length),
      multi: steps.map((s) => s.classList.contains("multi")),
      gapCount: gaps.length,
      arrows: gaps.map((g) => !!g.querySelector("svg")),
      edges: gaps.map((g) => g.classList.contains("edge")),
      order: [...document.getElementById("timeline").children].map((el) => el.className.split(" ")[0]),
    };`);
  assert.deepEqual(layout.headers, ["Step 1", "Step 2 · runs together", "Step 3"]);
  assert.deepEqual(layout.blocksPerStep, [1, 2, 1]);
  assert.deepEqual(layout.multi, [false, true, false]);
  assert.equal(layout.gapCount, 4);
  assert.deepEqual(layout.arrows, [false, true, true, false]);
  assert.deepEqual(layout.edges, [true, false, false, true]);
  assert.deepEqual(layout.order, ["timeline-gap", "timeline-step", "timeline-gap", "timeline-step",
    "timeline-gap", "timeline-step", "timeline-gap"]);
});

test("Add to Timeline appends a new step and Delete removes an emptied step", async () => {
  const result = await page.evaluate(`
    __t.load([]);
    document.getElementById("timelineSpeech").value = "One";
    document.getElementById("addSpeechBlock").click();
    document.getElementById("delaySeconds").value = "2";
    document.getElementById("addDelayBlock").click();
    const afterAdd = __t.shape();
    document.querySelector('.timeline-step[data-step="0"] .delete-btn').click();
    return { afterAdd, afterDelete: __t.shape(),
      header: document.querySelector(".timeline-step .step-header").textContent };`);
  assert.deepEqual(result.afterAdd, [["speech"], ["delay"]]);
  assert.deepEqual(result.afterDelete, [["delay"]]);
  assert.equal(result.header, "Step 1");
});

test("an empty timeline shows the placeholder", async () => {
  const empty = await page.evaluate(`__t.load([]);
    const t = document.getElementById("timeline");
    return { empty: t.classList.contains("empty"), children: t.children.length };`);
  assert.deepEqual(empty, { empty: true, children: 0 });
});

test("dropping onto a step joins it and removes the emptied step", async () => {
  const result = await page.evaluate(`
    const [[speech], [motion]] = __t.load(${JSON.stringify([[SPEECH], [MOTION]])});
    const classes = __t.drag(speech, document.querySelector('.timeline-step[data-step="1"]'));
    return { classes, shape: __t.shape() };`);
  assert.match(result.classes, /drop-ok/);
  assert.deepEqual(result.shape, [["motion", "speech"]]);
});

test("dropping onto a block card inside a step joins that step", async () => {
  const shape = await page.evaluate(`
    const [[speech], [motion]] = __t.load(${JSON.stringify([[SPEECH], [MOTION]])});
    __t.drag(speech, document.querySelector('.timeline-block[data-id="' + motion + '"] .block-content'));
    return __t.shape();`);
  assert.deepEqual(shape, [["motion", "speech"]]);
});

test("a conflicting drop is refused with a status message", async () => {
  const result = await page.evaluate(`
    __bridge.dialogs = [];
    const [[first]] = __t.load(${JSON.stringify([[MOTION], [MOTION]])});
    const classes = __t.drag(first, document.querySelector('.timeline-step[data-step="1"]'));
    return { classes, shape: __t.shape(),
      status: document.getElementById("timelineStatusText").textContent,
      dialogs: __bridge.dialogs.length };`);
  assert.match(result.classes, /drop-refused/);
  assert.deepEqual(result.shape, [["motion"], ["motion"]]);
  assert.equal(result.status, "Step 2 already has a motion");
  assert.equal(result.dialogs, 0);
});

test("dropping into a gap makes a new step there", async () => {
  const result = await page.evaluate(`
    const steps = ${JSON.stringify([[SPEECH, MOTION], [DELAY]])};
    let [[, motion]] = __t.load(steps);
    const classes = __t.drag(motion, document.querySelector('.timeline-gap[data-gap="2"]'));
    const toEnd = __t.shape();
    [[, motion]] = __t.load(steps);
    __t.drag(motion, document.querySelector('.timeline-gap[data-gap="0"]'));
    const toStart = __t.shape();
    return { classes, toEnd, toStart };`);
  assert.match(result.classes, /drop-target/);
  assert.deepEqual(result.toEnd, [["speech"], ["delay"], ["motion"]]);
  assert.deepEqual(result.toStart, [["motion"], ["speech"], ["delay"]]);
});

test("moving a step's only block away renumbers the steps", async () => {
  const result = await page.evaluate(`
    const [[speech]] = __t.load(${JSON.stringify([[SPEECH], [MOTION]])});
    __t.drag(speech, document.querySelector('.timeline-gap[data-gap="2"]'));
    return { shape: __t.shape(),
      headers: [...document.querySelectorAll(".step-header")].map((h) => h.textContent) };`);
  assert.deepEqual(result.shape, [["motion"], ["speech"]]);
  assert.deepEqual(result.headers, ["Step 1", "Step 2"]);
});

test("a drag that did not start on a block is ignored", async () => {
  const shape = await page.evaluate(`
    __t.load(${JSON.stringify([[SPEECH], [MOTION]])});
    __t.dragForeign(document.querySelector('.timeline-step[data-step="0"]'));
    __t.dragForeign(document.querySelector('.timeline-gap[data-gap="1"]'));
    return __t.shape();`);
  assert.deepEqual(shape, [["speech"], ["motion"]]);
  assert.deepEqual(page.exceptions, []);
});

test("blocks cannot be dragged while the timeline plays", async () => {
  const shape = await page.evaluate(`
    __bridge.delays["/speak"] = 400;
    const [[speech]] = __t.load(${JSON.stringify([[SPEECH], [MOTION]])});
    const playing = playTimeline();
    await new Promise((r) => setTimeout(r, 50));
    __t.drag(speech, document.querySelector('.timeline-gap[data-gap="2"]'));
    const during = __t.shape();
    await playing;
    __bridge.delays = {};
    return during;`);
  assert.deepEqual(shape, [["speech"], ["motion"]]);
});

// Block state by id; null when the block never ran (undefined does not survive returnByValue)
const stateOf = `(id) => (blockStates[id] || {}).state || null`;

test("blocks in a step start together and the next step waits for the slowest", async () => {
  const result = await page.evaluate(`
    __bridge.calls = []; __bridge.delays = { "/speak": 400, "/motion": 150 };
    const ids = __t.load(${JSON.stringify([[SPEECH, MOTION], [TEXT]])});
    await playTimeline();
    __bridge.delays = {};
    const call = (p) => __bridge.calls.find((c) => c.path === p);
    const speak = call("/speak"), motion = call("/motion"), send = call("/send");
    return {
      startGap: Math.abs(speak.start - motion.start),
      textAfterSpeech: send.start - speak.end,
      states: ids.flat().map(${stateOf}),
      status: document.getElementById("timelineStatusText").textContent,
    };`);
  assert.ok(result.startGap < 50, `speech and motion should start together (gap ${result.startGap} ms)`);
  assert.ok(result.textAfterSpeech >= 250, `step 2 started ${result.textAfterSpeech} ms after the slower block ended`);
  assert.deepEqual(result.states, ["done", "done", "done"]);
  assert.equal(result.status, "Finished — all 2 steps played");
});

test("the status line describes the step and the arrow into it is highlighted", async () => {
  const seen = await page.evaluate(`
    __bridge.delays = { "/speak": 300 };
    __t.load(${JSON.stringify([[TEXT], [SPEECH, MOTION]])});
    const playing = playTimeline();
    await new Promise((r) => setTimeout(r, 450));
    const seen = {
      status: document.getElementById("timelineStatusText").textContent,
      activeGaps: [...document.querySelectorAll(".timeline-gap.active")].map((g) => g.dataset.gap),
      playingBadges: document.querySelectorAll(".timeline-block.state-playing").length,
    };
    await playing;
    __bridge.delays = {};
    seen.activeAfter = document.querySelectorAll(".timeline-gap.active").length;
    return seen;`);
  assert.equal(seen.status, 'Playing step 2 of 2: Speech "Hello" + Motion Hey');
  assert.deepEqual(seen.activeGaps, ["1"]);
  assert.equal(seen.playingBadges, 1, "motion finished, speech still playing");
  assert.equal(seen.activeAfter, 0);
});

test("a failed block lets its step finish, then stops before the next step", async () => {
  const result = await page.evaluate(`
    __bridge.calls = []; __bridge.delays = { "/speak": 200 }; __bridge.failures = { "/motion": "motion broke" };
    const ids = __t.load(${JSON.stringify([[SPEECH, MOTION], [TEXT]])});
    await playTimeline();
    __bridge.delays = {}; __bridge.failures = {};
    return {
      states: ids.flat().map(${stateOf}),
      sendCalled: __bridge.calls.some((c) => c.path === "/send"),
      status: document.getElementById("timelineStatusText").textContent,
      log: document.getElementById("errorLogEntries").textContent,
    };`);
  assert.deepEqual(result.states, ["done", "error", null]);
  assert.equal(result.sendCalled, false);
  assert.equal(result.status, "Failed at step 1 of 2: motion broke");
  assert.match(result.log, /Timeline step 1 \(motion\)/);
});

test("losing the network mid-step fails the block and ends playback cleanly", async () => {
  const result = await page.evaluate(`
    __bridge.offline = true;
    const ids = __t.load(${JSON.stringify([[SPEECH], [TEXT]])});
    await playTimeline();
    __bridge.offline = false;
    const block = document.querySelector('.timeline-block[data-id="' + ids[0][0] + '"]');
    return {
      state: blockStates[ids[0][0]].state,
      error: block.querySelector(".block-error").textContent,
      isPlaying,
      playDisabled: document.getElementById("playTimeline").disabled,
    };`);
  assert.equal(result.state, "error");
  assert.equal(result.error, "Failed to fetch");
  assert.equal(result.isPlaying, false);
  assert.equal(result.playDisabled, false);
});

test("Stop ends a step with a long wait and speech promptly", async () => {
  const result = await page.evaluate(`
    __bridge.delays = { "/speak": 10000 };
    const ids = __t.load(${JSON.stringify([[SPEECH, { type: "delay", seconds: 10 }], [TEXT]])});
    const playing = playTimeline();
    await new Promise((r) => setTimeout(r, 200));
    const started = performance.now();
    await stopTimeline();
    await playing;
    __bridge.delays = {};
    return {
      took: performance.now() - started,
      states: ids.flat().map(${stateOf}),
      status: document.getElementById("timelineStatusText").textContent,
    };`);
  assert.ok(result.took < 1000, `stop took ${result.took} ms`);
  assert.deepEqual(result.states, ["stopped", "stopped", null]);
  assert.equal(result.status, "Stopped after 0 of 2 steps");
});

// Exports the current timeline and returns the parsed file
const EXPORT = `
  let blob;
  const original = URL.createObjectURL;
  URL.createObjectURL = (b) => { blob = b; return "blob:test"; };
  try { exportTimeline(); } finally { URL.createObjectURL = original; }
  const exported = JSON.parse(await blob.text());`;
// Imports `file` (a JS object) and waits for the import message
const IMPORT = (file) => `
  __bridge.dialogs = [];
  importTimeline(new File([JSON.stringify(${file})], "t.json", { type: "application/json" }));
  for (let i = 0; i < 50 && __bridge.dialogs.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  const message = __bridge.dialogs[0];`;

test("export writes version 2 steps and import restores them", async () => {
  const result = await page.evaluate(`
    __t.load(${JSON.stringify([[SPEECH], [MOTION, SPEECH_2], [DELAY]])});
    ${EXPORT}
    __t.load([[${JSON.stringify(TEXT)}]]);
    ${IMPORT("exported")}
    return { version: exported.version, ids: exported.steps.flat().some((b) => "id" in b),
      shape: __t.shape(), message };`);
  assert.equal(result.version, 2);
  assert.equal(result.ids, false);
  assert.deepEqual(result.shape, [["speech"], ["motion", "speech"], ["delay"]]);
  assert.equal(result.message, 'Imported "my_timeline" — 3 steps, 4 blocks');
});

test("an old flat file imports as one block per step", async () => {
  const result = await page.evaluate(`
    ${IMPORT(JSON.stringify({ name: "old", blocks: [SPEECH, MOTION] }))}
    return { shape: __t.shape(), message };`);
  assert.deepEqual(result.shape, [["speech"], ["motion"]]);
  assert.equal(result.message, 'Imported "old" — 2 steps, 2 blocks');
});

test("conflicting blocks in a file are split into their own steps", async () => {
  const result = await page.evaluate(`
    ${IMPORT(JSON.stringify({ name: "clash", version: 2, steps: [[MOTION, MOTION, SPEECH]] }))}
    return { shape: __t.shape(), message };`);
  assert.deepEqual(result.shape, [["motion", "speech"], ["motion"]]);
  assert.equal(result.message, 'Imported "clash" — 2 steps, 3 blocks (1 conflicting block moved to its own step)');
});

test("a malformed file is rejected and the timeline is left alone", async () => {
  const result = await page.evaluate(`
    __t.load(${JSON.stringify([[SPEECH]])});
    ${IMPORT(JSON.stringify({ name: "bad", steps: [null, "x", []] }))}
    return { shape: __t.shape(), message };`);
  assert.deepEqual(result.shape, [["speech"]]);
  assert.equal(result.message, "No valid blocks found in this file.");
});
