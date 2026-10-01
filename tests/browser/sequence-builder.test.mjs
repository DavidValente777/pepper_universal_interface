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
