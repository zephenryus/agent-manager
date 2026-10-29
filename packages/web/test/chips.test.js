import assert from "node:assert/strict";
import { test } from "node:test";
import { draftForChip } from "../public/chips.js";

const chip = { agentId: "synthesizer", reason: "Turn notes into themes", message: "  Can you pull three themes from the interview notes?  " };

test("in the room the draft starts with an @mention so it skips the router", () => {
  assert.deepEqual(draftForChip(chip, { inDm: false, current: "" }), {
    text: "@synthesizer Can you pull three themes from the interview notes?",
    drafted: true,
  });
});

test("in a private chat the draft is just the message", () => {
  assert.deepEqual(draftForChip(chip, { inDm: true, current: "" }), {
    text: "Can you pull three themes from the interview notes?",
    drafted: true,
  });
});

test("anything already typed is kept, and the draft goes on a new line after it", () => {
  assert.equal(draftForChip(chip, { inDm: true, current: "Also, keep it short.  \n" }).text, "Also, keep it short.\nCan you pull three themes from the interview notes?");
  assert.equal(draftForChip(chip, { inDm: false, current: "Thanks!" }).text, "Thanks!\n@synthesizer Can you pull three themes from the interview notes?");
});

test("a chip with no message falls back to the old behavior", () => {
  const bare = { agentId: "synthesizer", reason: "r" };
  assert.deepEqual(draftForChip(bare, { inDm: false, current: "" }), { text: "@synthesizer ", drafted: false });
  assert.deepEqual(draftForChip(bare, { inDm: false, current: "what about this?" }), { text: "@synthesizer what about this? ", drafted: false });
  assert.deepEqual(draftForChip(bare, { inDm: true, current: "typed" }), { text: "typed", drafted: false });
  // A blank or non-text message counts as no message.
  assert.equal(draftForChip({ ...bare, message: "   " }, { inDm: true, current: "" }).drafted, false);
  assert.equal(draftForChip({ ...bare, message: 5 }, { inDm: false, current: "" }).drafted, false);
});
