import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openControllerPage } from "./harness.mjs";

let page;
before(async () => {
  page = await openControllerPage();
});
after(async () => {
  await page.close();
});

test("the controller page loads without errors and has sequence.js", async () => {
  const loaded = await page.evaluate(`return {
    timeline: !!document.getElementById("timeline"),
    sequenceHelpers: typeof canJoinStep === "function" && typeof parseTimelineFile === "function",
  };`);
  assert.deepEqual(loaded, { timeline: true, sequenceHelpers: true });
  assert.deepEqual(page.exceptions, []);
});
