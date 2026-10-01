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
