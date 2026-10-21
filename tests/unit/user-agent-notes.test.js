import test from "node:test";
import assert from "node:assert/strict";
import {
  handBackNote,
  handBackNotes,
} from "../../server/features/assistants/browser-hand-back.js";
import { shareNote, shareNotes } from "../../server/features/assistants/agent-shares.js";
import { shareDefinition } from "../../server/features/assistants/team-plugin/share-tool.js";
import { checkInPrompt } from "../../server/features/assistants/native-heartbeats.js";
import { NativeRoutines } from "../../server/features/assistants/native-routines.js";

// Notes AgentPier writes into a user's chat name her as the agent's user, never as
// the owner, who neither reads nor drives her chat.
test("the browser hand-back names the user who drove it", () => {
  assert.equal(handBackNote("owner", null), handBackNotes.owner);
  assert.equal(handBackNote("timeout", null), handBackNotes.timeout);
  for (const reason of ["owner", "timeout"]) {
    const note = handBackNote(reason, "user-1");
    assert.doesNotMatch(note, /owner/i);
    assert.match(note, /your user/i);
  }
});

test("a check-in of a user's own agent addresses her, not the owner", () => {
  assert.match(checkInPrompt(null), /the owner/);
  const prompt = checkInPrompt("user-1");
  assert.doesNotMatch(prompt, /owner/i);
  assert.match(prompt, /your user/);
  assert.match(prompt, /NO_REPLY/);
});

test("a user's routine reports to her, the owner's to him", () => {
  const payload = (binding) =>
    NativeRoutines.prototype.payload.call(
      {},
      { name: "Daily", prompt: "Check" },
      binding,
    );
  assert.match(payload({ kind: "routine" }), /for the owner/);
  const own = payload({ kind: "routine", userId: "user-1" });
  assert.doesNotMatch(own, /owner/i);
  assert.match(own, /for your user/);
});

test("a file shared in a user's chat is for the person who asked, not the owner", () => {
  assert.equal(shareNote({ userId: null }), shareNotes.owner);
  const note = shareNote({ userId: "u-1" });
  assert.match(note, /person who asked sees the file in this chat/);
  assert.doesNotMatch(note, /owner/i);
  // The tool itself, the same for every agent, names no owner as the recipient.
  assert.doesNotMatch(shareDefinition.share_file.description, /owner/i);
});
