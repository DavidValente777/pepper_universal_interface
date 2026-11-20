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

const STATE = `return {
  controllerHidden: document.getElementById("controllerTab").hidden,
  storyHidden: document.getElementById("storyTab").hidden,
  active: [...document.querySelectorAll(".tab-bar .tab.active")].map((t) => t.dataset.tab),
  errorLogVisible: document.getElementById("errorLogPanel").offsetParent !== null,
};`;

test("starts on the Controller tab", async () => {
  const state = await page.evaluate(STATE);
  assert.deepEqual(state, { controllerHidden: false, storyHidden: true, active: ["controller"], errorLogVisible: true });
});

test("the Story tab swaps the page and is remembered across a reload", async () => {
  const state = await page.evaluate(`document.querySelector('.tab[data-tab="story"]').click(); ${STATE}`);
  assert.deepEqual(state, { controllerHidden: true, storyHidden: false, active: ["story"], errorLogVisible: true });
  assert.equal(await page.evaluate(`return localStorage.getItem("pepper.activeTab");`), "story");
  await page.reload();
  const reloaded = await page.evaluate(STATE);
  assert.deepEqual(reloaded.active, ["story"]);
  assert.equal(reloaded.controllerHidden, true);
});

test("the Controller tab brings everything back", async () => {
  const state = await page.evaluate(`document.querySelector('.tab[data-tab="controller"]').click(); ${STATE}`);
  assert.deepEqual(state, { controllerHidden: false, storyHidden: true, active: ["controller"], errorLogVisible: true });
});
