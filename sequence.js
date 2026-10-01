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
