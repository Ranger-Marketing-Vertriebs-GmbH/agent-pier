import test from "node:test";
import assert from "node:assert/strict";
import {
  afterTurn,
  heardText,
  heardWords,
  phaseTone,
  talkNotice,
} from "../../web/features/talk/talk-state.js";
import * as en from "../../web/lib/i18n/en/talk.js";
import * as dictation from "../../web/lib/i18n/en/dictation.js";

const baseline = { replyId: "old", attemptId: "a1" };

test("talk mode speaks the new reply once the agent is done", () => {
  assert.deepEqual(afterTurn(baseline, { active: true, replyId: "new" }), {
    next: "wait",
  });
  assert.deepEqual(
    afterTurn(baseline, { active: false, replyId: "old", attemptId: "a1" }),
    {
      next: "wait",
    },
  );
  assert.deepEqual(
    afterTurn(baseline, { active: false, replyId: "new", attemptId: "a2" }),
    {
      next: "speak",
      messageId: "new",
    },
  );
  // A turn that ended without a reply (failed, stopped) listens again.
  assert.deepEqual(
    afterTurn(baseline, {
      active: false,
      replyId: "old",
      attemptId: "a2",
      attemptState: "failed",
    }),
    { next: "listen", notice: "noReply" },
  );
});

test("finals add up and an interim result replaces the previous one", () => {
  let heard = { finals: [], interim: "" };
  heard = heardWords(heard, { final: false, text: "what" });
  heard = heardWords(heard, { final: false, text: "what time" });
  assert.equal(heardText(heard), "what time");
  heard = heardWords(heard, { final: true, text: "What time is it" });
  heard = heardWords(heard, { final: true, text: "" });
  heard = heardWords(heard, { final: false, text: "in Berlin" });
  assert.equal(heardText(heard), "What time is it in Berlin");
});

test("every phase has a tone and every notice a text", () => {
  for (const phase of ["starting", "listening", "thinking", "speaking", "paused"])
    assert.ok(phaseTone(phase).tone);
  assert.equal(phaseTone("listening").pulse, true);
  assert.equal(phaseTone("paused").pulse, false);
  const copy = en.talkCopy;
  const text = (notice) => talkNotice(notice, copy, dictation.dictationCopy);
  assert.equal(text(null), "");
  assert.equal(
    text({ source: "ended", code: "limit", minutes: 30 }),
    copy.ended.limit(30),
  );
  assert.equal(text({ source: "speak", code: "auth" }), copy.speak.auth);
  assert.equal(text({ source: "speak", code: "odd" }), copy.speak.failed);
  assert.equal(
    text({ source: "reason", code: "voiceMissing" }),
    copy.reasons.voiceMissing,
  );
  // Dictation's own refusals keep the dictation copy (Deepgram).
  assert.equal(
    text({ source: "error", code: "quota" }),
    dictation.dictationCopy.errors.quota,
  );
  assert.equal(text({ source: "error", code: "odd" }), copy.errors.failed);
});
