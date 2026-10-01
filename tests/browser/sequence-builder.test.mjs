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
