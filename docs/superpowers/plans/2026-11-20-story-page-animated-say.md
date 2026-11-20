# Story Page, Animated Say and Eye Colour Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Animated say" option to speech, an eye-colour control, and a Story tab with a running script of independently fired Say / Animated say / Dance / Image items, autosaved on the laptop.

**Architecture:** The bridge (`bridge.py`) gains `animated`/`interrupt` on `/speak`, `POST /eyes`, and `GET`/`POST /story` that store one story file in `stories/story.json`. Pure, DOM-free story helpers live in `story.js` (tested in Node like `sequence.js`); the Story tab's DOM code lives in `story-page.js`, loaded after `controller.js` and reusing its helpers (`postJson`, `logError`, `createMotionPicker`, `loadImageForTablet`, `isConnected`).

**Tech Stack:** Python 3 stdlib HTTP server + `qi`; vanilla JS/HTML/CSS; Node `node:test`; headless-Chrome browser tests via `tests/browser/harness.mjs`; Python `unittest` with a stubbed `qi` module.

**Spec:** `docs/superpowers/specs/2026-11-20-story-page-animated-say-design.md`

## Global Constraints

- No new dependencies (Python or JS). No build step.
- Existing Controller features keep working and stay where they are.
- Old Sequence Builder exports still import; speech blocks without `animated` import as `animated: false`.
- Story endpoints (`GET`/`POST /story`) must work with no robot connected.
- Story file: `stories/story.json` next to `bridge.py`, written atomically (tmp file + `os.replace`); `stories/` is git-ignored. Max request body for `/story`: 50 MB (413 above).
- Story file shape: `{ "version": 1, "eyeColor": "#rrggbb", "items": [ {id, type, played, ...} ] }`, item types `say`, `animatedSay`, `dance` (`motion`), `image` (`name`, `imageData`).
- Animated speech: `ALAnimatedSpeech.say(text, {"bodyLanguageMode": "random"})`, text still prefixed with `\vct={voice_pitch}\ `.
- Eyes: `ALLeds.fadeRGB("FaceLeds", 0xRRGGBB, 0.2)`; colour must match `^#[0-9a-fA-F]{6}$`.
- Story autosave debounce: 500 ms. Undo-delete toast: 6 s.
- Story ▶ for speech always sends `interrupt: true`; Instant Send Speak also sends `interrupt: true`; Sequence playback never interrupts.
- Run all tests with: `node --test tests/*.test.js && node --test tests/browser/*.test.mjs && python3 -m unittest discover -s tests -p 'test_*.py'`

**Deviation from spec, decided here:** on `interrupt`, the bridge only calls `tts.stopAll()`. It does **not** stop motions, because that would also kill a dance the operator deliberately started (spec allows dance + speech overlap). Stopping TTS ends the animated `say()`, and ALAnimatedSpeech stops its own gestures when speech ends. Verify on the robot (Task 8).

## Review Focus

1. **Story fails to load** (bridge returns 500 / corrupt file / network error) → the page must show "Could not load story" and must NOT autosave, so it never overwrites the saved script with an empty one. Test in Task 6.
2. **Several edits while a save is in flight** → saves are sent one at a time and the last state written is the latest one (no older body overwriting a newer one). Test in Task 6.
3. **Reload/close within the 500 ms debounce** (operator types a line and reloads) → pending changes are flushed with `navigator.sendBeacon` on `pagehide`. Test in Task 6.
4. **Corrupt or hand-edited `stories/story.json`** → `GET /story` answers 500 with a JSON error (not a crash, not an empty story). Test in Task 2.
5. **Robot disconnected / reconnected while on the Story tab** → ▶ and STOP buttons disable on disconnect and re-enable on reconnect; editing stays enabled. Test in Task 7.

---

### Task 1: Animated speech in the step model (`sequence.js`)

**Files:**
- Modify: `sequence.js`
- Test: `tests/sequence.test.js`

**Interfaces:**
- Produces:
  - `blockChannels(block) -> string[]` (replaces `blockChannel`): speech → `["speech"]`, animated speech (`type: "speech", animated: true`) → `["speech", "motion"]`, motion → `["motion"]`, text/image → `["tablet"]`, delay → `["wait"]`.
  - `canJoinStep(step, block) -> boolean`: false if any of the block's channels is used by another block in the step.
  - `conflictMessage(stepIndex, block, step) -> string` (new third param; `moveBlockToStep` passes the target step).
  - `validateBlock` normalises speech to `animated: block.animated === true`.
  - Export list: replace `blockChannel` with `blockChannels`.

- [ ] **Step 1: Update/write the failing tests** in `tests/sequence.test.js`. Add helper `const animSpeech = (id) => ({ id, type: "speech", text: "hi", animated: true });` and replace the `blockChannel` test with:

```js
test("blockChannels: animated speech uses speech and motion", () => {
  assert.deepEqual(seq.blockChannels(speech(1)), ["speech"]);
  assert.deepEqual(seq.blockChannels(animSpeech(1)), ["speech", "motion"]);
  assert.deepEqual(seq.blockChannels(motion(1)), ["motion"]);
  assert.deepEqual(seq.blockChannels(text(1)), ["tablet"]);
  assert.deepEqual(seq.blockChannels(image(1)), ["tablet"]);
  assert.deepEqual(seq.blockChannels(delay(1)), ["wait"]);
});

test("canJoinStep: animated speech and a motion cannot share a step", () => {
  assert.equal(seq.canJoinStep([motion(1)], animSpeech(2)), false);
  assert.equal(seq.canJoinStep([animSpeech(1)], motion(2)), false);
  assert.equal(seq.canJoinStep([animSpeech(1)], text(2)), true);
});

test("conflictMessage explains animated speech conflicts", () => {
  assert.equal(seq.conflictMessage(1, animSpeech(9), [motion(1)]),
    "Step 2 already has a motion — animated speech also moves Pepper");
  assert.equal(seq.conflictMessage(0, motion(9), [animSpeech(1)]),
    "Step 1 already has an animated speech, which also moves Pepper");
  assert.equal(seq.conflictMessage(0, speech(9), [animSpeech(1)]), "Step 1 already has a speech");
});

test("import: speech gets animated false by default, keeps true, and splits animated speech from a motion", () => {
  let n = 0;
  const parsed = seq.parseTimelineFile({ steps: [[
    { type: "speech", text: "a" },
    { type: "motion", motion: "animations/Stand/Gestures/Hey_1", displayName: "Hey" },
  ], [{ type: "speech", text: "b", animated: true },
      { type: "motion", motion: "animations/Stand/Gestures/Hey_1", displayName: "Hey" }]] }, () => ++n);
  assert.equal(parsed.steps[0][0].animated, false);
  assert.equal(parsed.steps.length, 3);
  assert.equal(parsed.steps[1][0].animated, true);
  assert.equal(parsed.movedCount, 1);
});
```

Update the existing `conflictMessage` test calls to pass a step containing the conflicting block (e.g. `seq.conflictMessage(1, motion(9), [motion(1)])`), expected strings unchanged.

- [ ] **Step 2: Run** `node --test tests/sequence.test.js` — Expected: FAIL (`seq.blockChannels is not a function`).

- [ ] **Step 3: Implement** in `sequence.js`. `conflictMessage` finds the first of the block's channels that another block in `step` uses, and the block that uses it: if that channel is `motion` and the new block is animated speech → "…already has a motion — animated speech also moves Pepper"; if the channel is `motion` and the occupier is animated speech → "…already has an animated speech, which also moves Pepper"; otherwise the existing `CHANNEL_NAMES` message. `splitConflicts` keeps working via `canJoinStep`. Grep `controller.js` for `conflictMessage`/`blockChannel` callers and update them.

- [ ] **Step 4: Run** `node --test tests/sequence.test.js && node --test tests/browser/*.test.mjs` — Expected: PASS.

- [ ] **Step 5: Commit** `git commit -am "Sequence model: animated speech occupies speech and motion"`

---

### Task 2: Bridge — animated speech, interrupt, eyes, story storage

**Files:**
- Modify: `bridge.py`, `.gitignore`
- Create: `tests/test_bridge.py`

**Interfaces:**
- Produces (HTTP):
  - `POST /speak {text, animated?: bool, interrupt?: bool}` → unchanged plain-text responses (200 "OK: …", 400, 500, 503).
  - `POST /eyes {color: "#rrggbb"}` → `{"success": true}`; 400 `{"success": false, "error": "color must be #rrggbb"}`; 503 when not connected.
  - `GET /story` → 200 story JSON (`{"version":1,"eyeColor":"#ffffff","items":[]}` when no file); 500 `{"success": false, "error": "..."}` if the file is unreadable/invalid JSON.
  - `POST /story <story JSON>` → `{"success": true}`; 400 if body is not an object with list `items`; 413 if `Content-Length` > 50 MB. No connection needed.
- Produces (Python): module globals `animated_speech`, `leds` (set in `connect_pepper` via `session.service("ALAnimatedSpeech")` / `("ALLeds")`); `STORY_PATH` (`os.path.join(os.path.dirname(os.path.abspath(__file__)), "stories", "story.json")`, overridable in tests); `load_story() -> dict`; `save_story(story: dict) -> None` (atomic).

- [ ] **Step 1: Write failing tests** in `tests/test_bridge.py`. Before importing `bridge`, insert a stub: `sys.modules["qi"] = types.ModuleType("qi")`. Start `bridge.ThreadingHTTPServer(("127.0.0.1", 0), bridge.Handler)` in a thread in `setUpClass`; set `bridge.STORY_PATH` to a temp dir path; per test set `bridge.is_connected = True`, `bridge.ensure_connected = lambda: True`, and `MagicMock()` for `bridge.tts`, `bridge.animated_speech`, `bridge.leds`. Use `urllib.request` for calls. Tests:
  - `test_speak_plain_uses_tts`: POST `/speak {"text":"Hi"}` → 200; `tts.say` called with `"\\vct=100\\ Hi"`; `animated_speech.say` not called; `tts.stopAll` not called.
  - `test_speak_animated_uses_animated_speech`: `{"text":"Hi","animated":true}` → `animated_speech.say` called with `("\\vct=100\\ Hi", {"bodyLanguageMode": "random"})`.
  - `test_speak_interrupt_stops_current_speech_first`: `{"text":"Hi","interrupt":true}` → `tts.stopAll` called before `tts.say` (check `bridge.tts.mock_calls` order).
  - `test_eyes_sets_face_leds`: `/eyes {"color":"#ff8000"}` → 200, `leds.fadeRGB` called with `("FaceLeds", 0xFF8000, 0.2)`.
  - `test_eyes_rejects_bad_colour`: `{"color":"red"}` → 400.
  - `test_eyes_needs_connection`: `bridge.is_connected = False` → 503.
  - `test_story_defaults_when_missing`: GET `/story` → `{"version":1,"eyeColor":"#ffffff","items":[]}`.
  - `test_story_round_trip_without_robot`: `is_connected = False`; POST a story with one say item → 200; GET returns it; no `.tmp` file left in the folder.
  - `test_story_rejects_non_story`: POST `[1,2]` and `{"items": "x"}` → 400 each.
  - `test_story_corrupt_file_is_500`: write `"{not json"` to `STORY_PATH`; GET → 500 with `success: false`.
  - `test_story_too_large_is_413`: send a request with header `Content-Length: 52428801` via `http.client` (body may be short; the server must check the header before reading) → 413.

- [ ] **Step 2: Run** `python3 -m unittest tests.test_bridge -v` — Expected: FAIL (404s / missing attributes).

- [ ] **Step 3: Implement** in `bridge.py`:
  - `/speak`: read `animated`, `interrupt` (`bool(...)`); if `interrupt`: `tts.stopAll()`; then `animated_speech.say(tagged, {"bodyLanguageMode": "random"})` or `tts.say(tagged)`.
  - `/eyes` handler using `require_connection_json`, regex validation, `leds.fadeRGB("FaceLeds", int(color[1:], 16), 0.2)`.
  - `do_GET` `/story` → `load_story()`; `do_POST` `/story` → size check on header, `read_json`, shape check, `save_story`. `save_story` does `os.makedirs(dirname, exist_ok=True)`, writes `STORY_PATH + ".tmp"`, then `os.replace`. Route `/story` before the connection checks.
  - Add `animated_speech`, `leds` to globals and to `connect_pepper`'s `global` line and service creation.
  - `.gitignore`: add `stories/`.

- [ ] **Step 4: Run** `python3 -m unittest tests.test_bridge -v` — Expected: PASS (11 tests).

- [ ] **Step 5: Commit** `git add bridge.py .gitignore tests/test_bridge.py && git commit -m "Bridge: animated/interrupting speech, eye colour, story storage"`

---

### Task 3: Controller tab — Animated say checkboxes and eye colour

**Files:**
- Modify: `controller.html`, `controller.js`, `controller.css`, `tests/browser/harness.mjs`
- Test: `tests/browser/controller-speech.test.mjs` (new)

**Interfaces:**
- Consumes: Task 1 (`animated` on speech blocks), Task 2 (`/speak` fields, `/eyes`).
- Produces (globals in `controller.js`, used by Task 7):
  - `setEyeColor(color: string, { send = true } = {})`: sets every element with class `eye-color-picker` to `color`; if `send`, POSTs `/eyes {color}` (errors → `logError("Eye colour", …)`); then calls every function in `eyeColorListeners`.
  - `const eyeColorListeners = []` — functions `(color) => void`.
  - `connectionListeners = []` — functions `(connected: boolean) => void`, called from `markConnected` (on first connect) and `markDisconnected`.
  - `motionsFromRobot` boolean, true after a successful `loadMotionsFromRobot`.
  - `createMotionPicker(root, onChange?)` — optional `onChange(path)` called when the user chooses a motion (click or Enter); `destroyMotionPicker(picker)` removes it from `motionPickers`.
- HTML ids: `speechAnimated` (checkbox in Instant Send speech card), `timelineSpeechAnimated` (checkbox in Sequence Builder speech card), `eyeColorPicker` (`<input type="color" class="eye-color-picker">` next to the brightness slider, default `#ffffff`, disabled while disconnected like the sliders).

- [ ] **Step 1: Extend the harness fake bridge** in `tests/browser/harness.mjs`: keep `options.method` on each call (`call.method = options.method || "GET"`); add `b.story = null` and answer `GET /story` with `b.story ?? {version:1, eyeColor:"#ffffff", items:[]}` (status 500 when `b.failures["/story"]` is set, as today), and `POST /story` by storing `JSON.parse(body)` into `b.story`. Add `b.connected = false`; `/status` returns `connected: b.connected` with IPs `"1.1.1.1"`/`"2.2.2.2"` when true. Existing tests must still pass.

- [ ] **Step 2: Write failing tests** in `tests/browser/controller-speech.test.mjs` (same `before`/`after` as `sequence-builder.test.mjs`):
  - `Speak sends animated and interrupt`: tick `#speechAnimated`, set `#speechText` "Hi", click `#speakBtn` → last `/speak` call body is `{"text":"Hi","animated":true,"interrupt":true}`; unticked → `animated:false`.
  - `timeline speech block remembers Animated say`: tick `#timelineSpeechAnimated`, add a speech block → `timelineSteps[0][0].animated === true`, the block element contains text "Animated"; then `__t.load([[{type:"speech",text:"a",animated:true}],[MOTION]])` and drag the motion onto step 1 → refused (shape unchanged) with the conflict message shown as today.
  - `timeline playback sends animated without interrupt`: load one animated speech step, `await playTimeline()` → `/speak` body `{"text":"a","animated":true}` (no `interrupt` key).
  - `eye colour picker sends /eyes`: set `#eyeColorPicker` value `#00ff00`, dispatch `change` → a `/eyes` call with body `{"color":"#00ff00"}`.

- [ ] **Step 3: Run** `node --test tests/browser/controller-speech.test.mjs` — Expected: FAIL.

- [ ] **Step 4: Implement.** `speak()` sends `{text, animated, interrupt: true}`; `addSpeechBlock` stores `animated` and unticks the checkbox after adding; `blockContentHtml` speech header reads "Animated speech" when animated; `runBlock` speech posts `{text, animated: block.animated === true}`; `describeBlock` says "Animated speech". `setSlidersEnabled` also toggles `.eye-color-picker` disabled. Add `connectionListeners`, `eyeColorListeners`, `setEyeColor`, `motionsFromRobot`, `onChange`/`destroyMotionPicker` per Interfaces. Checkbox styling: small inline label "Animated say" in both cards.

- [ ] **Step 5: Run** `node --test tests/*.test.js && node --test tests/browser/*.test.mjs` — Expected: PASS.

- [ ] **Step 6: Commit** `git add -A controller.* tests/browser && git commit -m "Animated say checkboxes and eye colour on the Controller tab"`

---

### Task 4: Tab bar

**Files:**
- Modify: `controller.html`, `controller.js`, `controller.css`
- Test: `tests/browser/tabs.test.mjs` (new)

**Interfaces:**
- Produces: `<nav class="tab-bar">` with `<button class="tab" data-tab="controller">Controller</button>` and `<button class="tab" data-tab="story">Story</button>` directly under the app bar; `<section id="controllerTab">` wraps all current sections except the Error Log; `<section id="storyTab" hidden>` (empty, filled in Task 6) sits after it; Error Log stays below both. `showTab(name: "controller"|"story")` toggles `hidden`, `.active` and `aria-selected`, and stores the name in `localStorage["pepper.activeTab"]` (wrapped in try/catch). On load the stored tab is shown (default `controller`).

- [ ] **Step 1: Write failing tests:** clicking the Story tab hides `#controllerTab`, shows `#storyTab`, marks the Story tab `.active`; `localStorage["pepper.activeTab"] === "story"`; after `location.reload()` (re-await load) Story is still shown; the Error Log panel is visible on both tabs; clicking Controller restores it. Then reset to controller.

- [ ] **Step 2: Run** `node --test tests/browser/tabs.test.mjs` — Expected: FAIL.

- [ ] **Step 3: Implement** markup, `showTab`, and tab styling matching the app bar (`controller.css`).

- [ ] **Step 4: Run** all tests — Expected: PASS.

- [ ] **Step 5: Commit** `git commit -am "Add Controller/Story tab bar"` (add the new test file).

---

### Task 5: Story model helpers (`story.js`)

**Files:**
- Create: `story.js`
- Test: `tests/story.test.js`

**Interfaces:** (all pure; never mutate inputs; exported via `module.exports` when `module` exists, like `sequence.js`)
- `STORY_ITEM_TYPES = ["say", "animatedSay", "dance", "image"]`
- `emptyStory() -> { version: 1, eyeColor: "#ffffff", items: [] }`
- `makeItem(type, id) -> item` — `{id, type, played: false}` plus `text: ""` (say/animatedSay), `motion: ""` (dance), `name: "", imageData: ""` (image).
- `addItem(story, item) -> story` (appends)
- `updateItem(story, id, changes) -> story`
- `removeItem(story, id) -> { story, removed: { item, index } | null }`
- `restoreItem(story, item, index) -> story` (inserts at `index`, clamped)
- `moveItem(story, id, toIndex) -> story` (`toIndex` is the final position, clamped)
- `resetMarks(story) -> story` (all `played: false`)
- `validateStory(data, makeId) -> { story, dropped: number }` — throws `Error("This is not a Pepper story file.")` when `data` is not an object with an `items` array. Keeps valid items with fresh ids from `makeId()`; `played` coerced with `=== true`; say/animatedSay need string `text`; dance needs string `motion`; image needs string `name` and `imageData` that is `""` or starts with `data:image/`; others are dropped and counted. `eyeColor` kept if it matches `/^#[0-9a-fA-F]{6}$/`, else `"#ffffff"`.

- [ ] **Step 1: Write failing tests** in `tests/story.test.js` covering each function: `makeItem` shapes for all four types; `addItem`/`updateItem` don't mutate input; `removeItem` returns the index and `restoreItem` puts it back in the same place (round trip equals original order); `moveItem` first→last, last→first, and out-of-range clamps; `resetMarks`; `validateStory` drops `{type:"say", text: 5}`, `{type:"image", imageData:"javascript:x"}`, `{type:"nope"}` (`dropped === 3`), keeps a valid item of each type with new ids, coerces `played: "yes"` to false, defaults bad `eyeColor`, and throws on `null`, `[]`, `{items: "x"}`.

- [ ] **Step 2: Run** `node --test tests/story.test.js` — Expected: FAIL (cannot find module).

- [ ] **Step 3: Implement** `story.js`.

- [ ] **Step 4: Run** `node --test tests/story.test.js` — Expected: PASS.

- [ ] **Step 5: Commit** `git add story.js tests/story.test.js && git commit -m "Story model helpers"`

---

### Task 6: Story page — editing, autosave, export/import

**Files:**
- Create: `story-page.js`
- Modify: `controller.html` (fill `#storyTab`; add `<script src="story.js">` before `controller.js` and `<script src="story-page.js">` after it), `controller.css`
- Test: `tests/browser/story-page.test.mjs` (new)

**Interfaces:**
- Consumes: Task 5 helpers; Task 3 globals (`createMotionPicker(root, onChange)`, `destroyMotionPicker`, `motionEntry`, `motionCatalog`, `motionsFromRobot`, `loadImageForTablet`, `postJson`, `logError`, `escapeHtml`); Task 2 `/story`.
- Produces (globals, used by Task 7 and tests): `let story` (current story), `let storyLoaded` (bool), `setStory(next)` (sets `story`, re-renders, schedules save), `renderStory()`, `saveStoryNow() -> Promise`, `nextStoryId() -> string`.
- DOM ids/classes: `#storyList` (`<ol>`), each item `li.story-item[data-id]` with `.story-drag` handle, `.story-play`, `.story-type` label ("Say", "Animated say", "Dance", "Image"), a `textarea.story-text` (say kinds) / `.motion-picker` root (dance) / thumbnail + `input[type=file]` + name (image), `.story-played` ✓ marker, `.story-error`, `.story-delete`. Add buttons `#storyAddSay`, `#storyAddAnimatedSay`, `#storyAddDance`, `#storyAddImage`; `#storyExport`, `#storyImportBtn` + hidden `#storyImportInput`; `#storySaveStatus`; `#storyUndoToast` with `#storyUndoBtn`; `#storyLoadError` (hidden unless load failed).

Behaviour (from spec §3, §5):
- On load: `GET /story` → `validateStory(..., nextStoryId)`, `storyLoaded = true`, render. On any failure: show `#storyLoadError` "Could not load the saved story — changes are not being saved. Reload the page to try again." and leave `storyLoaded = false`; while false, **nothing is ever POSTed**.
- Autosave: every change calls `scheduleSave()` (500 ms debounce). Only one POST in flight; a change during a save marks dirty and triggers one more save afterwards with the latest `story`. Status text: "Saving…", "Saved ✓", "Save failed — retrying on next change" (+ `logError("Story save", …)`).
- `pagehide`: if a save is pending, `navigator.sendBeacon("/story", new Blob([JSON.stringify(story)], {type: "application/json"}))`.
- Typing in a textarea updates the item without re-rendering (keeps focus); textareas grow with content (`rows` from line count or `field-sizing: content`).
- Dance picker: `createMotionPicker(root, (path) => update item motion)`; before each re-render, `destroyMotionPicker` the story's pickers. If `motionsFromRobot && motion && !motionCatalog.some(m => m.path === motion)`, show "not found on this robot".
- Image: file chosen → `loadImageForTablet(file, dataUrl => update {imageData, name: file.name})`.
- Delete: `removeItem`, show the undo toast for 6 s; Undo → `restoreItem`. A new delete replaces the previous undo.
- Reorder: HTML5 drag starting from the `.story-drag` handle; drop on an item moves the dragged item to that item's index (`moveItem`).
- Export: download `JSON.stringify(story, null, 2)` as `pepper_story.json`. Import: `validateStory`; `confirm("Replace the current story (N items)?")` when non-empty; then `setStory`; alert a summary, mentioning dropped items if any.

- [ ] **Step 1: Write failing tests** in `tests/browser/story-page.test.mjs`. Add `reload()` to the object `openControllerPage` returns (navigates again and resolves on `Page.loadEventFired`). `__bridge` is re-created on every load, so `FAKE_BRIDGE` seeds `b.story` from `localStorage["__fakeStory"]` (JSON) and `b.failures` from `localStorage["__fakeFailures"]` (JSON) at startup; tests set those, then `reload()`. Tests:
  - `adds one item of each kind in order`: click the four add buttons → 4 `.story-item`s with type labels `["Say","Animated say","Dance","Image"]`.
  - `typing autosaves once after 500 ms`: type into the first textarea (set value + `input` event) three times quickly; wait 800 ms → exactly one new `POST /story`, whose body's first item text is the final value; status reads "Saved ✓".
  - `saves are sequential and end with the latest state`: set `__bridge.delays["/story"] = 400`; change text "a", wait 600 ms (save in flight), change to "b"; wait 1500 ms → POST `/story` calls never overlap (`call.start >= previous.end`) and `__bridge.story.items[0].text === "b"`.
  - `delete then Undo restores the item in place`: 3 items, delete the middle → 2 items and toast visible; click `#storyUndoBtn` → 3 items in original order.
  - `drag reorders`: drag item 3's handle onto item 1 → order of ids changes accordingly and a save follows.
  - `loads the saved story on start`: fake story with a say item "Hello" → after reload, first textarea value "Hello".
  - `load failure blocks saving`: `/story` GET fails (500) → `#storyLoadError` visible; add an item; wait 800 ms → no `POST /story` call.
  - `import replaces the story and reports dropped items`: call `importStory` with a File of `{items:[{type:"say",text:"x"},{type:"bad"}]}` → one item, alert mentions 1 skipped.
  - `export downloads the story`: stub `URL.createObjectURL` to capture the Blob; click `#storyExport` → parsed blob equals `story`.

- [ ] **Step 2: Run** `node --test tests/browser/story-page.test.mjs` — Expected: FAIL.

- [ ] **Step 3: Implement** `story-page.js`, the `#storyTab` markup (top controls row left empty for Task 7 except the add/export/import row and status), and CSS for the list (readable at a glance: large ▶ buttons, type label colour-coded the same as the Sequence Builder's block colours).

- [ ] **Step 4: Run** all tests — Expected: PASS.

- [ ] **Step 5: Commit** `git add story-page.js controller.html controller.css tests/browser && git commit -m "Story page: editable running script with autosave, undo, import/export"`

---

### Task 7: Story page — live controls (play, marks, STOP, sliders, eyes, connection)

**Files:**
- Modify: `story-page.js`, `controller.html`, `controller.js`, `controller.css`
- Test: `tests/browser/story-live.test.mjs` (new)

**Interfaces:**
- Consumes: Task 3 (`connectionListeners`, `eyeColorListeners`, `setEyeColor`, `SLIDERS`), Task 6 globals.
- Produces: `playStoryItem(id) -> Promise<void>`; `#storyStopBtn`; `#storyResetMarks`; `#storyNotConnected` banner with a button that calls `showTab("controller")`; Story sliders `#storyVolumeSlider`, `#storyPitchSlider`, `#storyBrightnessSlider` (+ value labels) and `#storyEyeColorPicker` (class `eye-color-picker`).

Behaviour:
- ▶ per item, all independent and immediate:
  - say / animatedSay: `postJson("/speak", {text, animated: type === "animatedSay", interrupt: true})`. Empty text → item error "Nothing to say", no request.
  - dance: `await postJson("/stop-motion")` then `postJson("/motion", {motion})`. No motion chosen → item error "Choose a dance first".
  - image: `postJson("/send-image", {imageData})`; ▶ disabled while `imageData` is empty.
  - On press: item gets class `playing` until the request settles, `played: true` is set immediately (and saved). Non-OK response / network error → `.story-error` text + `logError("Story", …)`; a new press clears the previous error.
- `#storyResetMarks`: `resetMarks`, save.
- `#storyStopBtn`: `Promise.allSettled([postJson("/stop-speech"), postJson("/stop-motion")])`; does not touch the tablet.
- Connection: `connectionListeners.push(onStoryConnection)` — when disconnected, all `.story-play`, `#storyStopBtn`, story sliders and eye picker are disabled and `#storyNotConnected` is shown; editing stays enabled. Initial state follows `isConnected`.
- Sliders: change `SLIDERS` entries to `{ sliders: [...ids], labels: [...ids], endpoint, format }` including the Story ids; `onSliderInput(key, sourceId)` copies the moved slider's value to its twin(s) and labels before the debounced send; `loadRobotSettings`/`setSlidersEnabled` update all of them.
- Eye colour: `#storyEyeColorPicker` `change` → `setEyeColor(value)`. `eyeColorListeners.push(color => { if (story.eyeColor !== color) setStory({...story, eyeColor: color}) })`. After the story loads, `setEyeColor(story.eyeColor, { send: false })`; on (re)connect (`connectionListeners`, connected=true) `setEyeColor(story.eyeColor)` so the prepared colour is applied to the robot.

- [ ] **Step 1: Write failing tests** in `tests/browser/story-live.test.mjs` (set `__bridge.connected = true` and call `checkConnectionStatus()` to become connected):
  - `say ▶ sends interrupting speech and marks played`: say "Hello" → `/speak` body `{"text":"Hello","animated":false,"interrupt":true}`; item has `.played`; story item `played === true`.
  - `animated say ▶ sends animated`: body has `animated: true`.
  - `pressing a second line while the first is speaking sends it at once`: `__bridge.delays["/speak"] = 2000`; press item 1 then item 2 → both `/speak` calls start within 200 ms of each other.
  - `dance ▶ stops the current motion then plays`: dance with motion `animations/Stand/Gestures/Hey_1` → `/stop-motion` call precedes `/motion` call with that body.
  - `image ▶ sends the image and is disabled without one`.
  - `failed play shows the error on the item`: `__bridge.failures["/speak"] = "boom"` → `.story-error` text "boom" and the error log has a "Story" entry.
  - `empty say shows "Nothing to say" and sends nothing`.
  - `Reset marks clears every ✓`.
  - `STOP stops speech and motion but not the tablet`: calls include `/stop-speech` and `/stop-motion`, not `/clear-tablet`.
  - `disconnect disables play and STOP but not editing`: `markDisconnected()` → `.story-play` and `#storyStopBtn` disabled, `#storyNotConnected` visible, `#storyAddSay` enabled; reconnect re-enables.
  - `story volume slider moves the Controller slider and sends once`: set `#storyVolumeSlider` 30 + `input` → `#volumeSlider.value === "30"`, one `/set-volume` call.
  - `eye colour syncs both pickers and the story`: Story picker `#123456` + `change` → `#eyeColorPicker.value === "#123456"`, `/eyes` called, `story.eyeColor === "#123456"`.

- [ ] **Step 2: Run** `node --test tests/browser/story-live.test.mjs` — Expected: FAIL.

- [ ] **Step 3: Implement** per the behaviour above. STOP is large and red, top-right of the Story controls row, styled like `.emergency-stop-btn` but labelled "STOP".

- [ ] **Step 4: Run** all tests — Expected: PASS.

- [ ] **Step 5: Commit** `git commit -am "Story page: independent play buttons, STOP, marks, synced sliders and eye colour"` (add the new test file).

---

### Task 8: README and robot check

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README**: Features table rows for Tabs, Story page, Animated say, Eye colour (and mention the Animated say option on Speech and Sequence Builder rows); Server Endpoints rows for `/speak` new fields, `/eyes`, `GET /story`, `POST /story`; a short "Story page" section (how to prepare, where the file lives — `stories/story.json` — and that it's backed up by Export); Running the Tests gains `node --test tests/story.test.js` and `python3 -m unittest discover -s tests -p 'test_*.py'`.

- [ ] **Step 2: Run** the full test command from Global Constraints — Expected: all PASS.

- [ ] **Step 3: Robot checklist** (manual, on Pepper; record results for the user): plain Say, Animated say (gestures happen), Animated say interrupted by another Say (speech stops and gestures stop), Dance then Say over it (dance keeps going), Image, STOP, eye colour, volume/pitch/brightness sync. If interrupted animated speech leaves gestures running, report it — do not silently add motion-stopping.

- [ ] **Step 4: Commit** `git commit -am "Document Story page, Animated say and eye colour"`
