# Parallel steps in the Sequence Builder

Date: 2026-10-01
Status: approved design, awaiting spec review

## Goal

Let the Sequence Builder run blocks at the same time. Blocks stacked below
each other form a **step** and start together. Steps play left to right, with
arrows between them showing the order.

## Decisions

- The next step starts when **every** block of the current step has finished.
- Blocks are grouped by **drag and drop**: drop onto a step to join it, drop
  into the gap between steps to make a new step.
- **Conflicting blocks are refused.** A step holds at most one block from each
  channel:

  | Channel | Block types |
  |---------|-------------|
  | speech  | `speech`    |
  | motion  | `motion`    |
  | tablet  | `text`, `image` |
  | wait    | `delay`     |

  A Wait inside a step means "this step lasts at least N seconds".
- **Add to Timeline** still appends a new step at the end.
- Old exported files must keep importing.

Out of scope: branching or free-form flowcharts, dragging whole steps,
copying blocks, reordering blocks within a step, any bridge change.

## Data model (`controller.js`)

- `timelineBlocks` (flat list) is replaced by `timelineSteps`: an array of
  steps, each step a non-empty array of blocks. Blocks keep their current
  shape (`type`, type-specific fields, unique `id` from `nextBlockId()`).
- `blockChannel(block)` returns the channel name from the table above.
- `canJoinStep(step, block)` is true when no other block in `step` has the
  same channel. It is the single source of truth for drag-and-drop and import.
- Removing a step's last block (move or delete) removes the step.
- `blockStates` stays keyed by block id.

## Layout and arrows (`controller.js`, `controller.css`)

- `#timeline` stays a horizontally scrolling row. Each step renders as a
  column (`.timeline-step`) holding:
  - a header, "STEP n", plus "· runs together" when it has more than one block;
  - its blocks stacked vertically, using the existing block cards
    (type colour, Delete, state badge, error line). The per-block step number
    is removed.
- A multi-block step gets a faint tinted background to group its blocks.
- Between consecutive steps there is a gap (`.timeline-gap`) containing a
  ▶ arrow drawn as inline SVG, aligned with the first block of each column.
  The arrow into the step that is currently playing is highlighted in the
  primary blue.
- The empty-timeline placeholder is unchanged.

## Drag and drop

- Every block card stays draggable while not playing. The drag payload is
  the block id.
- **Onto a step column:**
  - allowed: the column is outlined blue; on drop the block is appended to the
    bottom of that step;
  - refused (`canJoinStep` false): the column is outlined red; on drop nothing
    changes and the timeline status line shows e.g.
    "Step 2 already has a motion" (no alert dialog).
  - Dropping a block onto the step it is already in does nothing.
- **Into a gap:** there is a gap before the first step, between each pair and
  after the last step. While dragging, the gap under the cursor shows a
  vertical blue line; on drop the block becomes a new single-block step at
  that position. This is also how blocks are reordered.
- Editing (drag, Delete, Add, Clear, Import) stays locked while playing.

## Playback

- For each step in order:
  1. Mark every block in it **Playing**, highlight the arrow into the step,
     and set the status line to
     `Playing step i of n: <block descriptions joined by " + ">`, with the
     progress bar at `(i-1)/n`.
  2. Start all blocks with `runBlock` concurrently and wait for all of them
     (`Promise.allSettled`). Each block switches to **Done** or **Failed** as
     soon as it settles, independently of the others.
  3. If any block failed, log each failure as
     `Timeline step i (<type>)` with its message, set the status to
     `Failed at step i of n: <first error>`, and stop before the next step.
  4. Otherwise wait the existing 300 ms gap (abortable) and continue.
- Finish: `Finished — all n steps played`, progress 100 %.
- Stop: unchanged requests (`/stop-speech`, `/stop-motion`, clear tablet).
  Blocks still playing become **Stopped**. The status line reads
  `Stopped after k of n steps`.
- No bridge changes. Requests already run in parallel on the bridge, and
  `/speak` and `/motion` return when Pepper has finished, so "wait for all"
  matches what Pepper is doing.

## Export and import

Export (version 2):

```json
{
  "name": "my_timeline",
  "version": 2,
  "exportedAt": "2026-10-01T12:00:00.000Z",
  "steps": [
    [{ "type": "speech", "text": "Hello!" }],
    [
      { "type": "motion", "motion": "animations/Stand/Gestures/Hey_1", "displayName": "Hey" },
      { "type": "speech", "text": "Hi all" }
    ]
  ]
}
```

Import:

- A file with `steps` (array of arrays) is loaded as is. Invalid blocks are
  dropped (same type check as today) and empty steps are removed.
- A file with only a flat `blocks` array (the old format) becomes one block
  per step, so it plays as before.
- If a step from a file breaks the channel rule, each conflicting block is
  moved into its own new step right after it. The import message reports the
  totals, e.g.
  `Imported "demo" — 3 steps, 5 blocks (1 conflicting block moved to its own step)`.
- Unchanged: block ids are re-issued, the user confirms before a non-empty
  timeline is replaced, and import is refused while playing.

## Testing

Automated, in headless Chrome against a static copy of the page, with
`fetch` replaced by a fake bridge (configurable delays and failures):

- layout: columns, "runs together" header, arrows between steps only;
- drag and drop: join a step, refused conflict (red outline, status message,
  no change), new step from each kind of gap, last block leaving removes the
  step, editing locked while playing;
- playback: blocks of a step start together; the next step starts only after
  the slowest block of the current one; per-block states; failure stops
  before the next step; Stop marks running blocks Stopped;
- export then import gives back the same steps; an old flat-format file
  imports as one block per step; a conflicting step in a file is split.

Manual, on Pepper (needs the user, because the robot moves): one step with
Speech + Motion starts both together, and the following step waits for both.
