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

// Body of the most recent call to `path`, parsed, after giving the page a moment
const LAST_BODY = `
  const lastBody = async (path) => {
    await new Promise((r) => setTimeout(r, 50));
    const calls = __bridge.calls.filter((c) => c.path === path);
    return calls.length ? JSON.parse(calls[calls.length - 1].body) : null;
  };`;

test("Speak sends animated and interrupt", async () => {
  const result = await page.evaluate(`${LAST_BODY}
    document.getElementById("speechText").value = "Hi";
    document.getElementById("speechAnimated").checked = true;
    document.getElementById("speakBtn").click();
    const animated = await lastBody("/speak");
    document.getElementById("speechAnimated").checked = false;
    document.getElementById("speakBtn").click();
    const plain = await lastBody("/speak");
    return { animated, plain };`);
  assert.deepEqual(result.animated, { text: "Hi", animated: true, interrupt: true });
  assert.deepEqual(result.plain, { text: "Hi", animated: false, interrupt: true });
});

test("timeline speech block remembers Animated say and refuses a motion beside it", async () => {
  const result = await page.evaluate(`
    __t.load([]);
    document.getElementById("timelineSpeech").value = "Hello";
    document.getElementById("timelineSpeechAnimated").checked = true;
    document.getElementById("addSpeechBlock").click();
    const block = timelineSteps[0][0];
    const label = document.querySelector(".timeline-block.speech .block-header").textContent;
    const unticked = document.getElementById("timelineSpeechAnimated").checked;
    const [, [motionId]] = __t.load([[{ type: "speech", text: "a", animated: true }],
      [{ type: "motion", motion: "animations/Stand/Gestures/Hey_1", displayName: "Hey" }]]);
    const classes = __t.drag(motionId, document.querySelector('.timeline-step[data-step="0"]'));
    return { animated: block.animated, label, unticked, classes, shape: __t.shape() };`);
  assert.equal(result.animated, true);
  assert.match(result.label, /Animated/);
  assert.equal(result.unticked, false);
  assert.match(result.classes, /drop-refused/);
  assert.deepEqual(result.shape, [["speech"], ["motion"]]);
});

test("timeline playback sends animated without interrupt", async () => {
  const body = await page.evaluate(`${LAST_BODY}
    __t.load([[{ type: "speech", text: "a", animated: true }]]);
    await playTimeline();
    return lastBody("/speak");`);
  assert.deepEqual(body, { text: "a", animated: true });
});

test("eye colour picker sends /eyes", async () => {
  const body = await page.evaluate(`${LAST_BODY}
    const picker = document.getElementById("eyeColorPicker");
    picker.disabled = false;
    picker.value = "#00ff00";
    picker.dispatchEvent(new Event("change"));
    return lastBody("/eyes");`);
  assert.deepEqual(body, { color: "#00ff00" });
});

test("eye colour is a dropdown of named colours on both tabs", async () => {
  const result = await page.evaluate(`
    return ["eyeColorPicker", "storyEyeColorPicker"].map((id) => {
      const el = document.getElementById(id);
      return { tag: el.tagName, options: [...el.options].map((o) => o.textContent + " " + o.value) };
    });`);
  const expected = ["White #ffffff", "Red #ff0000", "Orange #ff8000", "Yellow #ffff00", "Green #00ff00",
    "Cyan #00ffff", "Blue #0000ff", "Purple #8000ff", "Pink #ff00ff", "Off #000000"];
  for (const picker of result) {
    assert.equal(picker.tag, "SELECT");
    assert.deepEqual(picker.options, expected);
  }
});

test("an eye colour not in the list is still shown as Custom", async () => {
  const shown = await page.evaluate(`
    await setEyeColor("#123456", { send: false });
    const el = document.getElementById("eyeColorPicker");
    const result = { value: el.value, text: el.options[el.selectedIndex].textContent };
    await setEyeColor("#ffffff", { send: false });
    return result;`);
  assert.deepEqual(shown, { value: "#123456", text: "Custom (#123456)" });
});
