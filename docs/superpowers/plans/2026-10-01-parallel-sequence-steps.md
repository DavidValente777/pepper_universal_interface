# Parallel Steps in the Sequence Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Sequence Builder's single row of blocks into a row of steps, where the blocks stacked in a step run at the same time and arrows show the order.

**Architecture:** Pure step logic (channels, conflict checks, moves, file parsing) lives in a new DOM-free `sequence.js`, which is loaded before `controller.js` and unit-tested with Node's built-in test runner. `controller.js` keeps the UI: it renders steps as columns with SVG arrows in the gaps, handles drag and drop, and plays a step by starting its blocks together and waiting for all of them. A small headless-Chrome harness tests the real page against a fake bridge.

**Tech Stack:** Plain browser JavaScript (classic scripts, no build step), CSS, Node 24 `node:test` (no npm dependencies), Google Chrome headless over the DevTools protocol. No bridge (`bridge.py`) changes.

**Spec:** `docs/superpowers/specs/2026-10-01-parallel-sequence-steps-design.md`

## Global Constraints

- A step holds at most one block per channel: `speech` → speech; `motion` → motion; `text`, `image` → tablet; `delay` → wait.
- The next step starts when **every** block of the current step has finished; the existing 300 ms gap between steps stays.
- Refused drops show a status-line message (e.g. `Step 2 already has a motion`), never an alert dialog.
- Export format: `{ "name", "version": 2, "exportedAt", "steps": [[block, ...], ...] }`. Old files with a flat `blocks` array import as one block per step.
- Import message: `Imported "<name>" — <n> steps, <m> blocks`, plus ` (1 conflicting block moved to its own step)` / ` (<k> conflicting blocks moved to their own steps)` when splitting happened.
- Status lines: `Playing step i of n: <descriptions joined by " + ">`, `Failed at step i of n: <first error>`, `Stopped after k of n steps`, `Finished — all n steps played`.
- Error log source for a failed block: `Timeline step i (<type>)`.
- Editing (drag, Delete, Add, Clear, Import) is locked while playing.
- No new runtime dependencies; no changes to `bridge.py`.
- `.gitignore` ignores `*.json`, so test fixtures live inside the test files, never as `.json` files.

## Review Focus

- A drag that did not start on a timeline block (e.g. an image file dragged in from the desktop) passing over or dropped on the timeline must change nothing and throw nothing. Pinned in Task 5.
- Dropping onto a block card inside a step, rather than onto the column's padding, must join that step. Pinned in Task 5.
- The network dropping mid-step (`fetch` rejects) must mark the block Failed with the message, end playback cleanly and re-enable the buttons. Pinned in Task 6.
- Stop during a step with a long Wait next to a Speech must return within about a second and mark both Stopped. Pinned in Task 6.
- A malformed import file (`steps` entries that are `null`, strings or empty) must say `No valid blocks found in this file.` and leave the current timeline untouched. Pinned in Task 2 (unit) and Task 7 (page).

## Before starting

The working tree already has uncommitted, unrelated work in `bridge.py`, `controller.js`, `controller.css` and `controller.html` (camera feeds, motion search, battery indicator). Commit it separately first, with the user's agreement, so this feature's commits only contain this feature. Check with `git status --short`: before Task 1 the only changes listed should be `?? pepper_universal_interface/`, which is unrelated and should be left alone.

Run all tests with:

```bash
node --test tests/
```

## File Structure

| File | Responsibility |
|------|----------------|
| `sequence.js` (create) | DOM-free step logic: channels, `canJoinStep`, conflict messages, block moves, import parsing and export serialisation. Classic script (globals in the page) that also exports via `module.exports` for Node. |
| `tests/sequence.test.js` (create) | Unit tests for `sequence.js` (`node:test`, CommonJS). |
| `tests/browser/harness.mjs` (create) | Starts a static server and headless Chrome, injects the fake bridge and page helpers, exposes `evaluate()`. |
| `tests/browser/sequence-builder.test.mjs` (create) | Page tests: layout, drag and drop, playback, export and import. |
| `controller.html` (modify) | Load `sequence.js` before `controller.js`. |
| `controller.js` (modify) | Timeline state becomes `timelineSteps`; rendering, drag and drop, playback, export and import use steps. |
| `controller.css` (modify) | Step columns, gaps, arrows and drop highlights. |
| `README.md` (modify) | Sequence Builder feature row. |

---

### Task 1: Step model helpers (`sequence.js`)

**Files:**
- Create: `sequence.js`
- Create: `tests/sequence.test.js`
- Modify: `controller.html:291` (script tags)

**Interfaces:**
- Consumes: nothing.
- Produces (globals in the page, and `module.exports` in Node):
  - `VALID_BLOCK_TYPES: string[]`, `["speech", "motion", "text", "image", "delay"]`
  - `blockChannel(block) -> "speech" | "motion" | "tablet" | "wait"`
  - `canJoinStep(step: Block[], block: Block) -> boolean` (ignores `block` itself if it is already in `step`)
  - `conflictMessage(stepIndex: number, block: Block) -> string`, e.g. `"Step 2 already has a motion"`
  - `appendStep(steps, block) -> Step[]`
  - `withoutBlock(steps, id) -> Step[]` (drops steps that become empty)
  - `moveBlockToStep(steps, id, stepIndex) -> { steps: Step[], error: string | null }`. Returns the same `steps` object when nothing changes.
  - `moveBlockToGap(steps, id, gapIndex) -> Step[]`. Gap 0 is before the first step and `steps.length` is after the last.
  - All helpers return new arrays and never modify their input. A `Block` is `{ id: number, type: string, ... }`; a `Step` is a non-empty `Block[]`.

- [ ] **Step 1: Write the failing tests**

Create `tests/sequence.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const seq = require("../sequence.js");

const speech = (id) => ({ id, type: "speech", text: "hi" });
const motion = (id) => ({ id, type: "motion", motion: "animations/Stand/Gestures/Hey_1", displayName: "Hey" });
const text = (id) => ({ id, type: "text", text: "t", fontSize: 110, color: "#000000" });
const image = (id) => ({ id, type: "image", imageData: "data:image/jpeg;base64,AA", fileName: "a.jpg" });
const delay = (id) => ({ id, type: "delay", seconds: 2 });
const ids = (steps) => steps.map((step) => step.map((b) => b.id));

test("blockChannel groups text and image on the tablet", () => {
  assert.equal(seq.blockChannel(speech(1)), "speech");
  assert.equal(seq.blockChannel(motion(1)), "motion");
  assert.equal(seq.blockChannel(text(1)), "tablet");
  assert.equal(seq.blockChannel(image(1)), "tablet");
  assert.equal(seq.blockChannel(delay(1)), "wait");
});

test("canJoinStep refuses a second block on the same channel", () => {
  assert.equal(seq.canJoinStep([speech(1)], motion(2)), true);
  assert.equal(seq.canJoinStep([motion(1)], motion(2)), false);
  assert.equal(seq.canJoinStep([text(1)], image(2)), false);
  assert.equal(seq.canJoinStep([speech(1), motion(2), text(3)], delay(4)), true);
});

test("canJoinStep ignores the block itself", () => {
  const block = motion(1);
  assert.equal(seq.canJoinStep([block], block), true);
});

test("conflictMessage names the step and the channel", () => {
  assert.equal(seq.conflictMessage(1, motion(9)), "Step 2 already has a motion");
  assert.equal(seq.conflictMessage(0, speech(9)), "Step 1 already has a speech");
  assert.equal(seq.conflictMessage(2, image(9)), "Step 3 already has a tablet block (text or image)");
  assert.equal(seq.conflictMessage(0, delay(9)), "Step 1 already has a wait");
});

test("appendStep adds a new single-block step at the end", () => {
  const steps = [[speech(1)]];
  const next = seq.appendStep(steps, motion(2));
  assert.deepEqual(ids(next), [[1], [2]]);
  assert.deepEqual(ids(steps), [[1]], "input unchanged");
});

test("withoutBlock removes the block and any step left empty", () => {
  const steps = [[speech(1)], [motion(2), speech(3)]];
  assert.deepEqual(ids(seq.withoutBlock(steps, 1)), [[2, 3]]);
  assert.deepEqual(ids(seq.withoutBlock(steps, 3)), [[1], [2]]);
});

test("moveBlockToStep joins a step and removes the emptied source step", () => {
  const steps = [[speech(1)], [motion(2)]];
  const { steps: next, error } = seq.moveBlockToStep(steps, 1, 1);
  assert.equal(error, null);
  assert.deepEqual(ids(next), [[2, 1]]);
  assert.deepEqual(ids(steps), [[1], [2]], "input unchanged");
});

test("moveBlockToStep refuses a conflict and keeps the steps", () => {
  const steps = [[motion(1)], [motion(2)]];
  const result = seq.moveBlockToStep(steps, 1, 1);
  assert.equal(result.error, "Step 2 already has a motion");
  assert.equal(result.steps, steps);
});

test("moveBlockToStep onto the block's own step changes nothing", () => {
  const steps = [[speech(1), motion(2)]];
  const result = seq.moveBlockToStep(steps, 2, 0);
  assert.equal(result.error, null);
  assert.equal(result.steps, steps);
});

test("moveBlockToStep with an unknown id or step changes nothing", () => {
  const steps = [[speech(1)]];
  assert.equal(seq.moveBlockToStep(steps, 99, 0).steps, steps);
  assert.equal(seq.moveBlockToStep(steps, 1, 5).steps, steps);
});

test("moveBlockToGap makes a new step at the gap", () => {
  const steps = [[speech(1), motion(2)], [delay(3)]];
  assert.deepEqual(ids(seq.moveBlockToGap(steps, 2, 0)), [[2], [1], [3]]);
  assert.deepEqual(ids(seq.moveBlockToGap(steps, 2, 1)), [[1], [2], [3]]);
  assert.deepEqual(ids(seq.moveBlockToGap(steps, 2, 2)), [[1], [3], [2]]);
  assert.deepEqual(ids(steps), [[1, 2], [3]], "input unchanged");
});

test("moveBlockToGap removes the source step when it empties", () => {
  const steps = [[speech(1)], [motion(2)]];
  assert.deepEqual(ids(seq.moveBlockToGap(steps, 1, 2)), [[2], [1]]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/sequence.test.js`
Expected: FAIL with `Cannot find module '../sequence.js'`.

- [ ] **Step 3: Write `sequence.js`**

Create `sequence.js`:

```js
// Sequence Builder steps. A timeline is an array of steps; a step is a
// non-empty array of blocks that start together. Pure helpers shared by
// controller.js and the Node tests: no DOM access, and inputs are never
// modified (every change returns new arrays).

const BLOCK_CHANNELS = { speech: "speech", motion: "motion", text: "tablet", image: "tablet", delay: "wait" };
const CHANNEL_NAMES = {
  speech: "a speech",
  motion: "a motion",
  tablet: "a tablet block (text or image)",
  wait: "a wait",
};
const VALID_BLOCK_TYPES = Object.keys(BLOCK_CHANNELS);

// Blocks on the same channel would fight over the same part of Pepper
function blockChannel(block) {
  return BLOCK_CHANNELS[block.type];
}

function canJoinStep(step, block) {
  const channel = blockChannel(block);
  return !step.some((other) => other.id !== block.id && blockChannel(other) === channel);
}

function conflictMessage(stepIndex, block) {
  return `Step ${stepIndex + 1} already has ${CHANNEL_NAMES[blockChannel(block)]}`;
}

function findBlock(steps, id) {
  for (const step of steps) {
    const block = step.find((b) => b.id === id);
    if (block) return block;
  }
  return null;
}

function appendStep(steps, block) {
  return [...steps, [block]];
}

function withoutBlock(steps, id) {
  return steps.map((step) => step.filter((b) => b.id !== id)).filter((step) => step.length > 0);
}

function moveBlockToStep(steps, id, stepIndex) {
  const block = findBlock(steps, id);
  const target = steps[stepIndex];
  if (!block || !target || target.includes(block)) return { steps, error: null };
  if (!canJoinStep(target, block)) return { steps, error: conflictMessage(stepIndex, block) };
  const next = steps.map((step, i) => (i === stepIndex ? [...step, block] : step.filter((b) => b.id !== id)));
  return { steps: next.filter((step) => step.length > 0), error: null };
}

function moveBlockToGap(steps, id, gapIndex) {
  const block = findBlock(steps, id);
  if (!block) return steps;
  const strip = (list) => list.map((step) => step.filter((b) => b.id !== id));
  const next = [...strip(steps.slice(0, gapIndex)), [block], ...strip(steps.slice(gapIndex))];
  return next.filter((step) => step.length > 0);
}

if (typeof module !== "undefined") {
  module.exports = {
    VALID_BLOCK_TYPES,
    blockChannel,
    canJoinStep,
    conflictMessage,
    appendStep,
    withoutBlock,
    moveBlockToStep,
    moveBlockToGap,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/sequence.test.js`
Expected: PASS, 12 tests, 0 failures.

- [ ] **Step 5: Load `sequence.js` in the page**

In `controller.html`, change line 291 from:

```html
    <script src="controller.js"></script>
```

to:

```html
    <script src="sequence.js"></script>
    <script src="controller.js"></script>
```

- [ ] **Step 6: Commit**

```bash
git add sequence.js tests/sequence.test.js controller.html
git commit -m "Add step model helpers for parallel sequence steps"
```

---

### Task 2: Import parsing and export format (`sequence.js`)

**Files:**
- Modify: `sequence.js` (add functions, extend `module.exports`)
- Modify: `tests/sequence.test.js` (append tests)

**Interfaces:**
- Consumes: `VALID_BLOCK_TYPES`, `canJoinStep` (Task 1).
- Produces:
  - `serializeTimeline(name: string, steps: Step[], now: Date) -> { name, version: 2, exportedAt: string, steps }`. Exported blocks have no `id`.
  - `parseTimelineFile(data: any, makeId: () => number) -> { name: string, steps: Step[], blockCount: number, movedCount: number }`. Throws `Error` with a user-facing message: `"Invalid file — no steps or blocks found."` or `"No valid blocks found in this file."`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/sequence.test.js`:

```js
let nextId = 0;
const makeId = () => ++nextId;
const types = (steps) => steps.map((step) => step.map((b) => b.type));

test("serializeTimeline writes version 2 steps without ids", () => {
  const data = seq.serializeTimeline("demo", [[speech(1)], [motion(2), speech(3)]], new Date("2026-10-01T12:00:00Z"));
  assert.equal(data.name, "demo");
  assert.equal(data.version, 2);
  assert.equal(data.exportedAt, "2026-10-01T12:00:00.000Z");
  assert.deepEqual(types(data.steps), [["speech"], ["motion", "speech"]]);
  assert.ok(data.steps.flat().every((b) => !("id" in b)));
});

test("parseTimelineFile reads version 2 files and issues fresh ids", () => {
  const file = seq.serializeTimeline("demo", [[speech(1)], [motion(2), speech(3)]], new Date());
  const parsed = seq.parseTimelineFile(JSON.parse(JSON.stringify(file)), makeId);
  assert.equal(parsed.name, "demo");
  assert.deepEqual(types(parsed.steps), [["speech"], ["motion", "speech"]]);
  assert.equal(parsed.blockCount, 3);
  assert.equal(parsed.movedCount, 0);
  const allIds = parsed.steps.flat().map((b) => b.id);
  assert.equal(new Set(allIds).size, 3);
});

test("parseTimelineFile turns an old flat file into one block per step", () => {
  const parsed = seq.parseTimelineFile({ name: "old", blocks: [speech(7), motion(8), delay(9)] }, makeId);
  assert.deepEqual(types(parsed.steps), [["speech"], ["motion"], ["delay"]]);
  assert.equal(parsed.blockCount, 3);
});

test("parseTimelineFile splits conflicting blocks into their own steps", () => {
  const parsed = seq.parseTimelineFile({ steps: [[motion(1), motion(2), speech(3)], [text(4), image(5)]] }, makeId);
  assert.deepEqual(types(parsed.steps), [["motion", "speech"], ["motion"], ["text"], ["image"]]);
  assert.equal(parsed.movedCount, 2);
  assert.equal(parsed.name, "Untitled");
});

test("parseTimelineFile drops invalid blocks and empty steps", () => {
  const parsed = seq.parseTimelineFile({ steps: [[{ type: "laser" }, speech(1)], [], [null, 42]] }, makeId);
  assert.deepEqual(types(parsed.steps), [["speech"]]);
});

test("parseTimelineFile rejects malformed files with a clear message", () => {
  assert.throws(() => seq.parseTimelineFile({ steps: [null, "x", []] }, makeId), { message: "No valid blocks found in this file." });
  assert.throws(() => seq.parseTimelineFile({ hello: 1 }, makeId), { message: "Invalid file — no steps or blocks found." });
  assert.throws(() => seq.parseTimelineFile(null, makeId), { message: "Invalid file — no steps or blocks found." });
  assert.throws(() => seq.parseTimelineFile({ steps: [] }, makeId), { message: "No valid blocks found in this file." });
});
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `node --test tests/sequence.test.js`
Expected: the 12 Task 1 tests pass; the 6 new tests FAIL with `seq.serializeTimeline is not a function` / `seq.parseTimelineFile is not a function`.

- [ ] **Step 3: Implement**

In `sequence.js`, add above the `if (typeof module !== "undefined")` block:

```js
function isValidBlock(block) {
  return !!block && typeof block === "object" && VALID_BLOCK_TYPES.includes(block.type);
}

// Keeps the first block of each channel; every other block gets its own step
// right after, so a hand-edited file can never play two motions at once
function splitConflicts(step) {
  const kept = [];
  const moved = [];
  step.forEach((block) => (canJoinStep(kept, block) ? kept : moved).push(block));
  return [kept, ...moved.map((block) => [block])];
}

function serializeTimeline(name, steps, now) {
  return {
    name,
    version: 2,
    exportedAt: now.toISOString(),
    steps: steps.map((step) => step.map(({ id, ...block }) => block)),
  };
}

// Version 2 files have "steps"; older files have a flat "blocks" list, which
// becomes one block per step so it plays exactly as before
function parseTimelineFile(data, makeId) {
  let rawSteps;
  if (data && Array.isArray(data.steps)) {
    rawSteps = data.steps.map((step) => (Array.isArray(step) ? step : []));
  } else if (data && Array.isArray(data.blocks)) {
    rawSteps = data.blocks.map((block) => [block]);
  } else {
    throw new Error("Invalid file — no steps or blocks found.");
  }
  const steps = [];
  let movedCount = 0;
  rawSteps.forEach((rawStep) => {
    const blocks = rawStep.filter(isValidBlock).map((block) => ({ ...block, id: makeId() }));
    if (blocks.length === 0) return;
    const parts = splitConflicts(blocks);
    movedCount += parts.length - 1;
    steps.push(...parts);
  });
  if (steps.length === 0) throw new Error("No valid blocks found in this file.");
  const blockCount = steps.reduce((count, step) => count + step.length, 0);
  return { name: data.name || "Untitled", steps, blockCount, movedCount };
}
```

Extend the `module.exports` object with `serializeTimeline,` and `parseTimelineFile,`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/sequence.test.js`
Expected: PASS, 18 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add sequence.js tests/sequence.test.js
git commit -m "Add version 2 timeline export and tolerant import parsing"
```

---

### Task 3: Headless-Chrome page test harness

**Files:**
- Create: `tests/browser/harness.mjs`
- Create: `tests/browser/sequence-builder.test.mjs`

**Interfaces:**
- Consumes: the page as served from the project root, and `nextBlockId`, `resetBlockStates` and `renderTimeline` from `controller.js` (existing). The `timelineSteps` helpers are used from Task 4 on.
- Produces:
  - `openControllerPage() -> Promise<{ evaluate(source: string): Promise<any>, exceptions: string[], close(): Promise<void> }>`. `evaluate` runs `source` as the body of an async function in the page and returns its JSON-able `return` value.
  - In the page, before `controller.js` runs:
    - `window.__bridge`, a fake bridge: `{ delays: {path: ms}, failures: {path: text}, offline: bool, calls: [{path, body, start, end}], dialogs: [string] }`. `alert` messages go to `dialogs`, `confirm` returns true, `prompt` returns its default. `/stop-speech` and `/stop-motion` end every pending delayed request immediately.
    - `window.__t` helpers: `load(steps) -> number[][]` (replaces `timelineSteps` with fresh-id copies and returns the ids), `shape() -> string[][]` (block types per step), `drag(blockId, targetEl) -> string` (simulates a drag of a timeline block onto `targetEl` and returns the class name of the target's step or gap after `dragover`), `dragForeign(targetEl)` (simulates a drag that didn't start on a block).

- [ ] **Step 1: Write the harness**

Create `tests/browser/harness.mjs`:

```js
// Headless Chrome harness for controller.html. Serves the project directory
// on a random port, replaces fetch() with a fake bridge before controller.js
// runs, and lets tests evaluate code in the page. Needs Google Chrome
// (set CHROME=/path/to/chrome if it is not "google-chrome" on PATH).
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, extname, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CHROME = process.env.CHROME || "google-chrome";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FAKE_BRIDGE = `
  window.__bridge = { delays: {}, failures: {}, offline: false, calls: [], dialogs: [], pending: new Set() };
  window.alert = (message) => window.__bridge.dialogs.push(String(message));
  window.confirm = () => true;
  window.prompt = (message, value) => value;
  window.fetch = async (url, options = {}) => {
    const b = window.__bridge;
    const path = String(url).split("?")[0];
    const call = { path, body: options.body || null, start: performance.now(), end: null };
    b.calls.push(call);
    if (b.offline) throw new TypeError("Failed to fetch");
    if (path === "/stop-speech" || path === "/stop-motion") {
      b.pending.forEach((finish) => finish());
      b.pending.clear();
    }
    await new Promise((resolve) => {
      const timer = setTimeout(done, b.delays[path] || 0);
      function done() { clearTimeout(timer); b.pending.delete(done); resolve(); }
      b.pending.add(done);
    });
    call.end = performance.now();
    if (b.failures[path]) return new Response(b.failures[path], { status: 500 });
    if (path === "/status") {
      return new Response(JSON.stringify({ connected: false, reconnecting: false, attempts: 0, awake: null,
        battery: null, charging: null, lastError: null, hostIp: null, pepperIp: null }));
    }
    return new Response(JSON.stringify({ success: true }));
  };`;

const PAGE_HELPERS = `
  window.__t = {
    load(steps) {
      timelineSteps = steps.map((step) => step.map((block) => ({ ...block, id: nextBlockId() })));
      resetBlockStates();
      renderTimeline();
      return timelineSteps.map((step) => step.map((block) => block.id));
    },
    shape() {
      return timelineSteps.map((step) => step.map((block) => block.type));
    },
    fire(el, type, dataTransfer) {
      el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
    },
    drag(blockId, target) {
      const source = document.querySelector('.timeline-block[data-id="' + blockId + '"]');
      const dt = new DataTransfer();
      this.fire(source, "dragstart", dt);
      this.fire(target, "dragenter", dt);
      this.fire(target, "dragover", dt);
      const zone = target.closest(".timeline-step, .timeline-gap");
      const classes = zone ? zone.className : "";
      this.fire(target, "drop", dt);
      this.fire(source, "dragend", dt);
      return classes;
    },
    dragForeign(target) {
      const dt = new DataTransfer();
      dt.items.add(new File(["x"], "photo.png", { type: "image/png" }));
      this.fire(target, "dragenter", dt);
      this.fire(target, "dragover", dt);
      this.fire(target, "drop", dt);
    },
  };`;

function startServer() {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^[/\\]+/, "");
    const file = join(ROOT, path || "controller.html");
    if (!file.startsWith(ROOT) || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(await readFile(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function launchChrome() {
  const dir = await mkdtemp(join(tmpdir(), "pepper-page-test-"));
  const proc = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`,
    "--no-first-run", "--no-default-browser-check", "--window-size=1400,1000", "about:blank"], { stdio: "ignore" });
  proc.on("error", (error) => { throw new Error(`Could not start Chrome (${CHROME}): ${error.message}`); });
  const portFile = join(dir, "DevToolsActivePort");
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  if (!existsSync(portFile)) throw new Error("Chrome did not start (no DevToolsActivePort)");
  const port = readFileSync(portFile, "utf8").split("\n")[0].trim();
  let page;
  for (let i = 0; i < 50 && !page; i++) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    page = targets.find((t) => t.type === "page");
    if (!page) await sleep(100);
  }
  return { proc, dir, wsUrl: page.webSocketDebuggerUrl };
}

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      data.error ? reject(new Error(data.error.message)) : resolve(data.result);
    } else if (data.method && listeners.has(data.method)) {
      listeners.get(data.method).forEach((listener) => listener(data.params));
    }
  };
  return {
    send(method, params = {}) {
      const id = ++nextId;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    on(method, listener) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(listener);
    },
    once(method) {
      return new Promise((resolve) => this.on(method, resolve));
    },
    close() {
      ws.close();
    },
  };
}

export async function openControllerPage() {
  const server = await startServer();
  const chrome = await launchChrome();
  const cdp = await connectCdp(chrome.wsUrl);
  const exceptions = [];
  cdp.on("Runtime.exceptionThrown", (p) =>
    exceptions.push(p.exceptionDetails.exception?.description || p.exceptionDetails.text));
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: FAKE_BRIDGE + PAGE_HELPERS });
  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/controller.html` });
  await loaded;

  async function evaluate(source) {
    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
      expression: `(async () => { ${source} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  }

  async function close() {
    cdp.close();
    const exited = new Promise((resolve) => chrome.proc.once("exit", resolve));
    chrome.proc.kill();
    await exited;
    server.close();
    await rm(chrome.dir, { recursive: true, force: true });
  }

  return { evaluate, exceptions, close };
}
```

- [ ] **Step 2: Write the smoke test**

Create `tests/browser/sequence-builder.test.mjs`:

```js
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
```

- [ ] **Step 3: Run it**

Run: `node --test tests/browser/sequence-builder.test.mjs`
Expected: PASS, 1 test. If it fails with "Could not start Chrome", set `CHROME` to the Chrome binary and rerun.

- [ ] **Step 4: Commit**

```bash
git add tests/browser/harness.mjs tests/browser/sequence-builder.test.mjs
git commit -m "Add headless Chrome harness for controller page tests"
```

---

### Task 4: Steps data model, columns and arrows

**Files:**
- Modify: `controller.js` (state at lines 41-44; `addBlock` ~1174; `deleteBlock` ~1249; `renderTimeline` ~1256-1340; temporary adjustments in `playTimeline`, `clearTimelineBlocks`, `exportTimeline` and `importTimeline`)
- Modify: `controller.css` (`#timeline` rule at ~735; new step and gap rules)
- Modify: `tests/browser/sequence-builder.test.mjs`

**Interfaces:**
- Consumes: `appendStep`, `withoutBlock` (Task 1).
- Produces (globals in `controller.js`):
  - `timelineSteps: Block[][]` replaces `timelineBlocks`.
  - `playingStepIndex: number` (`-1` when not playing).
  - `createBlockElement(block) -> HTMLElement`, `createStepElement(step, index) -> HTMLElement`, `createGapElement(index) -> HTMLElement`, where gap `index` is the step it leads into.
  - DOM: `.timeline-step[data-step=i]` (class `multi` when it has more than one block) contains `.step-header` and `.step-blocks`. `.timeline-gap[data-gap=i]` has class `edge` for the first and last gap, and holds an `<svg>` arrow only between steps. Arrow gaps get class `active` while their step plays.

- [ ] **Step 1: Write the failing layout tests**

Append to `tests/browser/sequence-builder.test.mjs`:

```js
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
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/browser/sequence-builder.test.mjs`
Expected: the smoke test passes; the 3 new tests FAIL, e.g. `ReferenceError: timelineSteps is not defined` or `Assignment to constant variable`.

- [ ] **Step 3: Change the state**

In `controller.js`, replace line 41:

```js
let timelineBlocks = [];
```

with:

```js
let timelineSteps = []; // [[block, ...], ...]: the blocks of a step start together
let playingStepIndex = -1; // step being played, -1 when idle
```

- [ ] **Step 4: Update add and delete**

In `addBlock`, replace `timelineBlocks.push(block);` with:

```js
  timelineSteps = appendStep(timelineSteps, block);
```

In `deleteBlock`, replace `timelineBlocks = timelineBlocks.filter((b) => b.id !== id);` with:

```js
  timelineSteps = withoutBlock(timelineSteps, id);
```

- [ ] **Step 5: Replace `renderTimeline`**

Replace the whole `renderTimeline` function (from `function renderTimeline() {` to the closing `}` before `// ─── Playback`) with:

```js
const ARROW_SVG =
  '<svg viewBox="0 0 28 14" aria-hidden="true"><path d="M1 7h21" stroke="currentColor" stroke-width="2" fill="none"/>' +
  '<path d="M19 2l8 5-8 5z" fill="currentColor"/></svg>';

function blockContentHtml(block) {
  if (block.type === "text") {
    return `
      <div class="block-header"><span>Text</span></div>
      <div class="block-content" style="color: ${escapeHtml(block.color)};">${escapeHtml(block.text)}</div>`;
  }
  if (block.type === "speech") {
    return `
      <div class="block-header"><span>Speech</span></div>
      <div class="block-content">"${escapeHtml(block.text)}"</div>`;
  }
  if (block.type === "image") {
    return `
      <div class="block-header"><span>Image</span></div>
      <img src="${escapeHtml(block.imageData)}" class="block-thumbnail" />
      <div class="block-content">${escapeHtml(block.fileName)}</div>`;
  }
  if (block.type === "delay") {
    return `
      <div class="block-header"><span>Wait</span></div>
      <div class="block-content">${block.seconds} second${block.seconds === 1 ? "" : "s"}</div>`;
  }
  if (block.type === "motion") {
    return `
      <div class="block-header"><span>Motion</span></div>
      <div class="block-content">${escapeHtml(block.displayName)}</div>`;
  }
  return "";
}

function createBlockElement(block) {
  const blockEl = document.createElement("div");
  blockEl.className = `timeline-block ${block.type}`;
  blockEl.draggable = !isPlaying;
  blockEl.dataset.id = block.id;
  blockEl.innerHTML = `<div class="block-step"><span class="block-state-badge"></span></div>` + blockContentHtml(block) + `
    <div class="block-error"></div>
    <div class="block-actions">
      <button class="delete-btn"${isPlaying ? " disabled" : ""}>Delete</button>
    </div>`;
  blockEl.querySelector(".delete-btn").addEventListener("click", () => deleteBlock(block.id));
  applyBlockState(blockEl, blockStates[block.id]);
  return blockEl;
}

function createStepElement(step, index) {
  const stepEl = document.createElement("div");
  stepEl.className = "timeline-step" + (step.length > 1 ? " multi" : "");
  stepEl.dataset.step = index;
  const together = step.length > 1 ? '<span class="step-together"> · runs together</span>' : "";
  stepEl.innerHTML = `<div class="step-header">Step ${index + 1}${together}</div><div class="step-blocks"></div>`;
  const blocksEl = stepEl.querySelector(".step-blocks");
  step.forEach((block) => blocksEl.appendChild(createBlockElement(block)));
  return stepEl;
}

// Gap `index` sits before step `index`; the ones between steps carry the arrow
function createGapElement(index) {
  const gapEl = document.createElement("div");
  const between = index > 0 && index < timelineSteps.length;
  gapEl.className = "timeline-gap" + (between ? "" : " edge") + (between && index === playingStepIndex ? " active" : "");
  gapEl.dataset.gap = index;
  if (between) gapEl.innerHTML = ARROW_SVG;
  return gapEl;
}

function renderTimeline() {
  const timeline = document.getElementById("timeline");
  timeline.innerHTML = "";
  timeline.classList.toggle("empty", timelineSteps.length === 0);
  if (timelineSteps.length === 0) return;
  timelineSteps.forEach((step, index) => {
    timeline.appendChild(createGapElement(index));
    timeline.appendChild(createStepElement(step, index));
  });
  timeline.appendChild(createGapElement(timelineSteps.length));
}
```

- [ ] **Step 6: Keep the rest of the timeline working until Tasks 6 and 7**

These are temporary adapters, replaced in Tasks 6 and 7. In `controller.js`:
- `playTimeline`: replace `if (timelineBlocks.length === 0) {` with `if (timelineSteps.length === 0) {`, and `const blocks = timelineBlocks.slice();` with `const blocks = timelineSteps.flat();`.
- `clearTimelineBlocks`: replace `if (timelineBlocks.length === 0) return;` with `if (timelineSteps.length === 0) return;`, and `timelineBlocks = [];` with `timelineSteps = [];`.
- `exportTimeline`: replace `if (timelineBlocks.length === 0) {` with `if (timelineSteps.length === 0) {`, and `blocks: timelineBlocks,` with `blocks: timelineSteps.flat(),`.
- `importTimeline`: replace `if (timelineBlocks.length > 0) {` with `if (timelineSteps.length > 0) {`, `` `Replace the current timeline (${timelineBlocks.length} blocks)?` `` with `` `Replace the current timeline (${timelineSteps.length} steps)?` ``, and `timelineBlocks = validBlocks.map((block) => ({ ...block, id: nextBlockId() }));` with `timelineSteps = validBlocks.map((block) => [{ ...block, id: nextBlockId() }]);`.

Then check that nothing still uses the old name:

Run: `grep -n "timelineBlocks" controller.js`
Expected: no output.

- [ ] **Step 7: Styles**

In `controller.css`, in the `#timeline {` rule at ~735, change `gap: 10px;` to `gap: 0;`. The gap elements now provide the spacing. Then add after the `.timeline-block.motion` line (~779):

```css
/* Steps: blocks stacked in a column start together; gaps hold the arrows */
.timeline-step {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex-shrink: 0;
  align-self: flex-start;
  padding: 8px;
  border: 2px solid transparent;
  border-radius: 10px;
  transition: border-color 0.15s, background 0.15s;
}
.timeline-step.multi {
  background: rgba(37, 99, 235, 0.06);
}
.step-header {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: #9ca3af;
}
.step-together {
  font-weight: 600;
  text-transform: none;
  color: var(--primary);
}
.step-blocks {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.timeline-gap {
  position: relative;
  flex-shrink: 0;
  width: 44px;
  align-self: stretch;
  display: flex;
  justify-content: center;
  padding-top: 62px; /* level with the first block of each step */
  color: #9ca3af;
}
.timeline-gap.edge {
  width: 16px;
}
.timeline-gap svg {
  width: 28px;
  height: 14px;
}
.timeline-gap.active {
  color: var(--primary);
}
```

- [ ] **Step 8: Run all tests**

Run: `node --test tests/`
Expected: PASS: 18 unit tests and 4 page tests, 0 failures.

- [ ] **Step 9: Commit**

```bash
git add controller.js controller.css tests/browser/sequence-builder.test.mjs
git commit -m "Render the sequence as step columns with arrows between them"
```

---

### Task 5: Drag and drop between steps and gaps

**Files:**
- Modify: `controller.js` (globals; `createBlockElement`, `createStepElement` and `createGapElement` from Task 4; new drag helpers placed above `createBlockElement`)
- Modify: `controller.css` (drop highlights)
- Modify: `tests/browser/sequence-builder.test.mjs`

**Interfaces:**
- Consumes: `moveBlockToStep`, `moveBlockToGap` (Task 1); `timelineSteps`, `createBlockElement`, `createStepElement`, `createGapElement` (Task 4); existing `setTimelineStatus(state, text, progress)`, `resetBlockStates()` and `isPlaying`.
- Produces:
  - `draggedBlockId: number | null`. It's null for any drag that didn't start on a timeline block.
  - `updateSteps(steps)`, which sets `timelineSteps` and re-renders (block states are reset only if the steps changed).
  - CSS classes during a drag: `drop-ok` / `drop-refused` on `.timeline-step`, and `drop-target` on `.timeline-gap`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/browser/sequence-builder.test.mjs`:

```js
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
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/browser/sequence-builder.test.mjs`
Expected: the drop tests FAIL, because the shapes don't change and the classes are empty. The "ignored" and "while playing" tests may already pass, which is fine.

- [ ] **Step 3: Implement the drag handlers**

In `controller.js`, add after the `let playingStepIndex` line:

```js
let draggedBlockId = null; // block being dragged in the timeline; null for any other drag (e.g. a file)
```

Add above `function createBlockElement(block) {`:

```js
function clearDropHighlights() {
  document
    .querySelectorAll("#timeline .drop-ok, #timeline .drop-refused, #timeline .drop-target")
    .forEach((el) => el.classList.remove("drop-ok", "drop-refused", "drop-target"));
}

function updateSteps(steps) {
  if (steps !== timelineSteps) {
    timelineSteps = steps;
    resetBlockStates();
  }
  renderTimeline();
}

function attachBlockDrag(blockEl, block) {
  blockEl.addEventListener("dragstart", (e) => {
    if (isPlaying) {
      e.preventDefault();
      return;
    }
    draggedBlockId = block.id;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(block.id)); // Firefox only starts a drag that carries data
    blockEl.classList.add("dragging");
  });
  blockEl.addEventListener("dragend", () => {
    draggedBlockId = null;
    blockEl.classList.remove("dragging");
    clearDropHighlights();
  });
}

// Dropping onto a step (or any block in it) joins that step, unless the step
// already has a block on the same channel
function attachStepDrop(stepEl, index) {
  stepEl.addEventListener("dragover", (e) => {
    if (draggedBlockId === null || isPlaying) return;
    e.preventDefault(); // accept the drop even when refused, so the drop can say why
    const { error } = moveBlockToStep(timelineSteps, draggedBlockId, index);
    clearDropHighlights();
    stepEl.classList.add(error ? "drop-refused" : "drop-ok");
    e.dataTransfer.dropEffect = "move";
  });
  stepEl.addEventListener("dragleave", (e) => {
    if (!stepEl.contains(e.relatedTarget)) stepEl.classList.remove("drop-ok", "drop-refused");
  });
  stepEl.addEventListener("drop", (e) => {
    if (draggedBlockId === null || isPlaying) return;
    e.preventDefault();
    const { steps, error } = moveBlockToStep(timelineSteps, draggedBlockId, index);
    clearDropHighlights();
    if (error) {
      setTimelineStatus("error", error, 0);
      return;
    }
    updateSteps(steps);
  });
}

// Dropping into a gap makes the block a new step at that position
function attachGapDrop(gapEl, index) {
  gapEl.addEventListener("dragover", (e) => {
    if (draggedBlockId === null || isPlaying) return;
    e.preventDefault();
    clearDropHighlights();
    gapEl.classList.add("drop-target");
    e.dataTransfer.dropEffect = "move";
  });
  gapEl.addEventListener("dragleave", () => gapEl.classList.remove("drop-target"));
  gapEl.addEventListener("drop", (e) => {
    if (draggedBlockId === null || isPlaying) return;
    e.preventDefault();
    clearDropHighlights();
    updateSteps(moveBlockToGap(timelineSteps, draggedBlockId, index));
  });
}
```

Then wire them in the Task 4 functions:
- in `createBlockElement`, before `return blockEl;`, add `attachBlockDrag(blockEl, block);`
- in `createStepElement`, before `return stepEl;`, add `attachStepDrop(stepEl, index);`
- in `createGapElement`, before `return gapEl;`, add `attachGapDrop(gapEl, index);`

- [ ] **Step 4: Drop highlight styles**

Append to the step rules in `controller.css` (after `.timeline-gap.active`):

```css
.timeline-step.drop-ok {
  border-color: var(--primary);
  background: rgba(37, 99, 235, 0.08);
}
.timeline-step.drop-refused {
  border-color: var(--danger);
  background: rgba(220, 38, 38, 0.06);
}
.timeline-gap.drop-target::after {
  content: "";
  position: absolute;
  top: 4px;
  bottom: 4px;
  left: 50%;
  width: 3px;
  margin-left: -1.5px;
  border-radius: 2px;
  background: var(--primary);
}
```

- [ ] **Step 5: Run all tests**

Run: `node --test tests/`
Expected: PASS: 18 unit tests and 11 page tests, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add controller.js controller.css tests/browser/sequence-builder.test.mjs
git commit -m "Drag blocks onto steps or into gaps, refusing channel conflicts"
```

---

### Task 6: Play a step's blocks together

**Files:**
- Modify: `controller.js` (`playTimeline` ~1440-1508; new `runStepBlock` and `setPlayingStep` above it)
- Modify: `tests/browser/sequence-builder.test.mjs`

**Interfaces:**
- Consumes: `timelineSteps`, `playingStepIndex` (Task 4); existing `runBlock(block)` (throws on failure), `setBlockState(block, state, error)`, `setTimelineStatus`, `describeBlock`, `abortableSleep`, `logError(source, message)`, `isPlaying`, `playbackAborted` and `stopTimeline()`.
- Produces:
  - `runStepBlock(block) -> Promise<Error | null>`. It never rejects; it sets the block's state and resolves with the error, if any.
  - `setPlayingStep(index)`, which updates `playingStepIndex` and the `active` arrow.

- [ ] **Step 1: Write the failing tests**

Append to `tests/browser/sequence-builder.test.mjs`:

```js
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
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/browser/sequence-builder.test.mjs`
Expected: the 5 new tests FAIL. With the Task 4 adapter, blocks still play one after another, so `startGap` is about 400 ms, and the status lines say "blocks" instead of "steps".

- [ ] **Step 3: Replace `playTimeline`**

In `controller.js`, add above `async function playTimeline() {`:

```js
// Runs one block of the current step; never rejects, so a step can wait for all
async function runStepBlock(block) {
  setBlockState(block, "playing");
  try {
    await runBlock(block);
  } catch (error) {
    if (playbackAborted) {
      setBlockState(block, "stopped");
      return null;
    }
    setBlockState(block, "error", error.message);
    return error;
  }
  setBlockState(block, playbackAborted ? "stopped" : "done");
  return null;
}

function setPlayingStep(index) {
  playingStepIndex = index;
  document.querySelectorAll("#timeline .timeline-gap").forEach((gap) => {
    gap.classList.toggle("active", !gap.classList.contains("edge") && Number(gap.dataset.gap) === index);
  });
}
```

Replace the whole `playTimeline` function with:

```js
async function playTimeline() {
  if (timelineSteps.length === 0) {
    alert("Add some blocks to the timeline first.");
    return;
  }
  if (isPlaying) {
    alert("The timeline is already playing.");
    return;
  }

  isPlaying = true;
  playbackAborted = false;
  blockStates = {};
  document.getElementById("playTimeline").disabled = true;
  document.getElementById("clearTimeline").disabled = true;
  document.getElementById("importTimelineBtn").disabled = true;
  renderTimeline();

  const steps = timelineSteps.map((step) => step.slice());
  const total = steps.length;
  let failed = null;
  let completed = 0;

  for (let i = 0; i < total; i++) {
    if (playbackAborted) break;

    const step = steps[i];
    setPlayingStep(i);
    setTimelineStatus("playing", `Playing step ${i + 1} of ${total}: ${step.map(describeBlock).join(" + ")}`, i / total);

    // Every block of the step starts now; the step ends when all have finished
    const errors = await Promise.all(step.map(runStepBlock));
    if (playbackAborted) break;

    const failures = step.map((block, k) => [block, errors[k]]).filter(([, error]) => error);
    if (failures.length > 0) {
      failures.forEach(([block, error]) => logError(`Timeline step ${i + 1} (${block.type})`, error.message));
      failed = { index: i, message: failures[0][1].message };
      break;
    }
    completed = i + 1;

    if (i < total - 1) {
      await abortableSleep(300);
    }
  }

  setPlayingStep(-1);
  if (failed) {
    setTimelineStatus("error", `Failed at step ${failed.index + 1} of ${total}: ${failed.message}`, completed / total);
  } else if (playbackAborted) {
    steps.flat().forEach((block) => {
      if (blockStates[block.id] && blockStates[block.id].state === "playing") setBlockState(block, "stopped");
    });
    setTimelineStatus("stopped", `Stopped after ${completed} of ${total} steps`, completed / total);
  } else {
    setTimelineStatus("done", `Finished — all ${total} steps played`, 1);
  }

  isPlaying = false;
  document.getElementById("playTimeline").disabled = false;
  document.getElementById("clearTimeline").disabled = false;
  document.getElementById("importTimelineBtn").disabled = false;
  renderTimeline();
}
```

- [ ] **Step 4: Run all tests**

Run: `node --test tests/`
Expected: PASS: 18 unit tests and 16 page tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add controller.js tests/browser/sequence-builder.test.mjs
git commit -m "Play the blocks of a step together and wait for all of them"
```

---

### Task 7: Export and import steps

**Files:**
- Modify: `controller.js` (`exportTimeline` ~1541; `importTimeline` ~1570; new `importSummary`)
- Modify: `tests/browser/sequence-builder.test.mjs`

**Interfaces:**
- Consumes: `serializeTimeline`, `parseTimelineFile` (Task 2); `timelineSteps`, `renderTimeline` (Task 4); existing `nextBlockId`, `resetBlockStates` and `isPlaying`.
- Produces: `importSummary({ name, steps, blockCount, movedCount }) -> string`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/browser/sequence-builder.test.mjs`:

```js
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
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/browser/sequence-builder.test.mjs`
Expected: the 4 new tests FAIL. The export has no `version`, import flattens steps, and the messages differ.

- [ ] **Step 3: Replace export and import**

In `controller.js`, in `exportTimeline`, replace:

```js
  const exportData = {
    name: name,
    exportedAt: new Date().toISOString(),
    blocks: timelineSteps.flat(),
  };

  const jsonString = JSON.stringify(exportData, null, 2);
```

with:

```js
  const jsonString = JSON.stringify(serializeTimeline(name, timelineSteps, new Date()), null, 2);
```

Replace the whole `importTimeline` function with:

```js
function importSummary({ name, steps, blockCount, movedCount }) {
  const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  let text = `Imported "${name}" — ${count(steps.length, "step")}, ${count(blockCount, "block")}`;
  if (movedCount === 1) text += " (1 conflicting block moved to its own step)";
  else if (movedCount > 1) text += ` (${movedCount} conflicting blocks moved to their own steps)`;
  return text;
}

function importTimeline(file) {
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    let parsed;
    try {
      parsed = parseTimelineFile(JSON.parse(e.target.result), nextBlockId);
    } catch (error) {
      alert(error instanceof SyntaxError ? "Could not read the file: " + error.message : error.message);
      return;
    }
    if (timelineSteps.length > 0 && !confirm(`Replace the current timeline (${timelineSteps.length} steps)?`)) {
      return;
    }
    if (isPlaying) {
      alert("Stop the timeline before importing.");
      return;
    }
    timelineSteps = parsed.steps;
    resetBlockStates();
    renderTimeline();
    alert(importSummary(parsed));
  };
  reader.readAsText(file);
}
```

- [ ] **Step 4: Run all tests**

Run: `node --test tests/`
Expected: PASS: 18 unit tests and 20 page tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add controller.js tests/browser/sequence-builder.test.mjs
git commit -m "Export and import timelines as version 2 steps"
```

---

### Task 8: Documentation and a live check on Pepper

**Files:**
- Modify: `README.md:99`

**Interfaces:**
- Consumes: everything above.
- Produces: user-facing documentation.

- [ ] **Step 1: Update the README row**

In `README.md`, replace the Sequence Builder row (line 99) with:

```markdown
| **Sequence Builder** | Build a sequence of steps from speech, text, image, motion and delay blocks. Stack blocks in one step to run them at the same time (one per kind: speech, motion, tablet text/image, wait); the next step starts when all of them have finished. Drag a block onto a step to join it or into the gap between steps to make a new step. Arrows show the order. Export/import as JSON (older single-row exports still import). During playback the current step is highlighted, finished/failed/stopped blocks are marked, and errors are shown on the failing block |
```

- [ ] **Step 2: Run the full test suite once more**

Run: `node --test tests/`
Expected: PASS: 38 tests, 0 failures.

- [ ] **Step 3: Live check on Pepper (needs the user, since the robot moves)**

Ask the user to restart the bridge (`python3 run.py`), refresh the page, and, with Pepper awake and in open space:
1. Build step 1 = Speech "Hello everyone" + Motion "Hey", and step 2 = Text "Done".
2. Press Play Timeline. Expected: Pepper starts talking and waving at the same moment; "Done" appears on the tablet only after both have finished; both blocks show Done.
3. Drag a second Motion onto step 1. Expected: a red outline, and the status line says "Step 1 already has a motion".
4. Export, Clear All, Import the file. Expected: the same two steps come back.

Record what the user reports; anything unexpected goes back to the matching task.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "Document parallel steps in the Sequence Builder"
```
