# Story page and Animated Say — design

Date: 2026-11-20

## Intent

A BBC crew is filming Pepper in a back-and-forth conversation with a presenter,
following a predefined script. The operator prepares Pepper's lines, images and
dances in advance, then during filming presses the right button at the right
moment. The presenter's pace is unknown, so **the operator drives all timing**:
nothing plays automatically.

Separately, speech everywhere in the app gains an "Animated say" option (Pepper
gestures while speaking, like Choregraphe's Animated Say box).

## Goals

1. **Animated say checkbox** on the Instant Send speech card and on the Sequence
   Builder speech block.
2. **Story tab**: a second page, reached from a tab bar at the top
   (`Controller | Story`), holding a running script the operator prepares ahead
   and fires item by item during filming.
3. **Eye colour** control (new feature), plus volume, pitch and brightness on the
   Story page.

## Non-goals

- Automatic playback or chaining of story items (the Sequence Builder already
  does that).
- Multiple saved stories / a story library. There is one story.
- Multi-user or simultaneous editing from two browsers (last save wins).

## Anti-goals (failure even if it "works")

- Anything that can lose the prepared script on the day (reload, crash, cleared
  cache, different browser on the same laptop).
- Anything that makes Pepper lag behind the operator: a pressed line must start
  now, not after the previous one finishes.
- Moving or hiding existing Controller features.

## Approaches considered

**Story layout**
- *Running script (chosen)*: one ordered list mixing speech, animated speech,
  dance and image items. Easy to follow a predefined script top to bottom.
- *Grouped panels* (speech / dances / images): better for improvising, worse for
  following a strict script. Rejected.

**Where the story is saved**
- *On the laptop via the bridge (chosen)*: autosaved to `stories/story.json` in
  the project folder, images embedded. Survives reloads, crashes, cleared browser
  data and browser switches. Costs two small bridge endpoints.
- *In the browser (IndexedDB)*: no bridge changes, but tied to one browser
  profile; clearing site data or a private window loses it. Rejected.
- *localStorage*: ~5 MB cap, a few photos exceed it. Rejected outright.

**Page structure (Claude's call)**: the Story page is a tab within
`controller.html`, not a separate HTML page, so it shares the connection,
the motion list loaded from the robot, and the slider state. Its code lives in a
new `story.js`.

## Design

### 1. Animated say

**Bridge.** `/speak` accepts two new optional fields:
- `animated` (bool, default false): use `ALAnimatedSpeech.say(text,
  {"bodyLanguageMode": "random"})` instead of `ALTextToSpeech.say`. The pitch tag
  `\vct=N\` is still prefixed, as today.
- `interrupt` (bool, default false): before speaking, stop any speech in
  progress (`ALTextToSpeech.stopAll()`), and for animated speech also stop its
  gestures, so the new line starts immediately. The interrupted request's
  `say()` returns early; that is not an error.

The `ALAnimatedSpeech` proxy is created on connect alongside `tts`, the same way.

**Instant Send.** The speech card gets an "Animated say" checkbox next to the
Speak button. Instant Send speech uses `interrupt: true` (Claude's call:
consistent with Story — pressing Speak means "say this now").

**Sequence Builder.** The speech add-block card gets the same checkbox. A speech
block stores `animated: true|false`; the block shows a small "animated" marker.
Sequence playback sends `animated` and does **not** interrupt (steps already wait
for speech to finish).

An animated speech moves the body, so it would fight a motion in the same step.
Channels become a list per block: plain speech occupies `speech`; animated speech
occupies `speech` **and** `motion`. `canJoinStep` rejects a block if any of its
channels is taken, and the conflict message names it (e.g. "Step 2 already has a
motion — animated speech also moves Pepper"). This lives in `sequence.js` and is
covered by `tests/sequence.test.js`.

Import: speech blocks without `animated` import as `false`; old exports keep
working. Validation accepts `animated` only as a boolean.

### 2. Tab bar

A tab bar under the app bar: `Controller` (everything that exists today,
unchanged) and `Story`. Switching tabs only shows/hides sections; nothing
reloads, the connection and camera are untouched. The last chosen tab is
remembered in localStorage (a convenience only). The battery indicator, error
indicator and error log stay reachable from both tabs (the app bar is shared;
errors from Story actions go to the same log).

If the robot is not connected, the Story page shows a one-line banner
"Not connected — connect on the Controller tab" with a link to switch tabs.
Editing still works while disconnected (preparing at home); only play buttons are
disabled.

### 3. Story page

```
[ Controller | Story ]
Vol ▬▬●▬  Pitch ▬●▬▬  Bright ▬▬▬●  Eyes [■]           [   STOP   ]
+ Say   + Animated say   + Dance   + Image     Reset marks  Export  Import
 ⠿ ▶ [Say]      [Hello, I'm Pepper!            ]   ✓   🗑
 ⠿ ▶ [Anim say] [I love meeting people.        ]       🗑
 ⠿ ▶ [Image]    (thumbnail) logo.png  [Change]         🗑
 ⠿ ▶ [Dance]    [Tai Chi            ▾]                 🗑
```

**Controls row**
- Volume, pitch, brightness: same endpoints and ranges as the Controller sliders,
  kept in sync with them both ways (moving one moves the other).
- Eye colour: colour picker (see section 4).
- **STOP**: large, always enabled while connected. Stops speech (TTS + animated
  speech) and all motions/dances. Does not clear the tablet (there is a separate
  Clear Tablet on Controller; Claude's call: an image left up mid-take is safer
  than a sudden blank screen).

**Items.** Four kinds, added by the `+` buttons at the end of the list:
- *Say* / *Animated say*: a text box (multi-line allowed, grows with content).
  ▶ calls `/speak` with `interrupt: true` and `animated` accordingly.
- *Dance*: a picker of the motions installed on the robot (the same list and
  search the Motions card uses; built-in list when not yet loaded). ▶ stops any
  running motion, then plays the chosen one (Claude's call: two dances at once
  can't work). A saved dance name not present in the current list still shows,
  marked "not found on this robot".
- *Image*: drop/choose a JPG or PNG; shows a thumbnail and file name. ▶ sends it
  to the tablet via the existing `/send-image` (same fitting as Image Display).

Each item: drag handle to reorder, ▶ play, 🗑 delete (no confirmation; Claude's
call — see Undo below), and a ✓ once played.

**Behaviour while live**
- Every ▶ is independent and fires immediately; nothing chains or auto-advances.
- Items may overlap across kinds: an image or a dance can start while Pepper is
  talking.
- A speech ▶ while Pepper is speaking cuts the current line off mid-sentence and
  says the new one.
- ▶ on an item gives brief visual feedback (playing state while the request is
  in flight); failures show on the item and in the error log.
- ✓ marks are a reminder only; anything can be replayed. "Reset marks" clears
  them for the next take. Marks are saved with the story (a reload mid-take keeps
  your place).

**Undo.** A deleted item shows a short "Deleted — Undo" toast for ~6 s.
Avoids a confirm dialog slowing the operator, without risking the script.

### 4. Eye colour

**Bridge.** `POST /eyes` with `color` as `#rrggbb`: `ALLeds.fadeRGB("FaceLeds",
0xRRGGBB, 0.2)`. Validates the format, 400 otherwise; 503 if not connected.

**UI.** A colour picker on the Controller tab (next to the brightness slider) and
on the Story page, kept in sync. Sent on change (not on every drag tick). The
value is remembered in the story file so the prepared look is restored.
(Claude's call: Pepper's own eye animations, e.g. during Autonomous Life, may
override it — Autonomous Life is already disabled on connect.)

### 5. Saving the story

**Bridge.**
- `GET /story` → the saved story JSON, or an empty story if none exists.
- `PUT /story` (or POST) with the story JSON → written atomically
  (write `stories/story.json.tmp`, then rename). Basic shape validation; 400 on
  bad input. Neither endpoint needs a robot connection.
- `stories/` is git-ignored. Request body size limit raised enough for images
  (e.g. 50 MB).

**Story file shape**
```json
{
  "version": 1,
  "eyeColor": "#ffffff",
  "items": [
    { "id": "…", "type": "say",       "text": "Hello", "played": false },
    { "id": "…", "type": "animatedSay","text": "…",    "played": true },
    { "id": "…", "type": "dance",     "motion": "animations/Stand/…" , "played": false },
    { "id": "…", "type": "image",     "name": "logo.png", "imageData": "data:image/png;base64,…", "played": false }
  ]
}
```

**Page.** Loads the story on page load. Autosaves on every change, debounced
(~500 ms; typing doesn't spam). A small "Saved ✓ / Saving… / Save failed" label
on the Story page; a save failure also goes to the error log and keeps retrying
on the next change.

**Export / Import.** Export downloads the same JSON. Import validates it (types,
fields, image data URIs) and replaces the current story after a confirmation
(it overwrites the prepared script).

### 6. Docs and tests

- README: tab bar, Story page, Animated say, eye colour, new endpoints, where the
  story file lives.
- Node tests for the multi-channel `sequence.js` rules and `animated` import.
- Pure story helpers (validate, add/remove/reorder, reset marks) in `story.js`
  written DOM-free like `sequence.js` and covered by Node tests.
- Browser test for the Story page basics (add, reorder, delete+undo, autosave
  call) in the existing `tests/browser` harness, if it fits there.

## Left to the builder

- Exact ALAnimatedSpeech/TTS calls to stop animated gestures cleanly on
  interrupt on NAOqi 2.5 — verify on the robot; fall back to stopping TTS plus
  the existing `stop_all_motions()` if needed.
- Visual styling, consistent with the existing controller.css.
- Drag-and-drop implementation for reordering (the Sequence Builder's approach
  can be reused or simplified).
