import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  applyTranscript,
  dictated,
  draftText,
  settleDraft,
  startDraft,
} from "../../web/features/dictation/dictation-text.js";
import { PcmEncoder } from "../../web/features/dictation/pcm-capture-worklet.js";

const play = (text, results) => {
  let draft = startDraft(text);
  for (const result of results) draft = applyTranscript(draft, draft.written, result);
  return draft;
};

test("interim results are replaced and finals accumulate after the existing text", () => {
  let draft = startDraft("Bitte");
  draft = applyTranscript(draft, "Bitte", { final: false, text: "prüf" });
  assert.equal(draftText(draft), "Bitte prüf");
  draft = applyTranscript(draft, draft.written, { final: false, text: "prüfe den" });
  assert.equal(draftText(draft), "Bitte prüfe den");
  draft = applyTranscript(draft, draft.written, { final: true, text: "prüfe den Test." });
  draft = applyTranscript(draft, draft.written, { final: false, text: "Danach" });
  assert.equal(draftText(draft), "Bitte prüfe den Test. Danach");
  // An empty final closes the segment and drops its interim text.
  draft = applyTranscript(draft, draft.written, { final: true, text: "" });
  assert.equal(draftText(draft), "Bitte prüfe den Test.");
  assert.ok(dictated(draft));
  assert.equal(draftText(play("Zeile\n", [{ final: true, text: "neu" }])), "Zeile\nneu");
  assert.equal(draftText(play("", [{ final: true, text: "Hallo" }])), "Hallo");
  assert.equal(dictated(startDraft("x")), false);
});

test("an edit during dictation is kept and later words follow it", () => {
  let draft = play("", [
    { final: true, text: "Erster Satz." },
    { final: false, text: "zw" },
  ]);
  draft = applyTranscript(draft, "Mein Satz.", { final: false, text: "zweiter" });
  assert.equal(draftText(draft), "Mein Satz. zweiter");
  draft = settleDraft(draft, draft.written);
  assert.equal(draftText(draft), "Mein Satz. zweiter");
  assert.equal(draft.interim, "");
  // A settled draft whose field was edited afterwards stays as the owner left it.
  assert.equal(settleDraft(draft, "anders"), draft);
});

test("edit with interim still visible: the interim phrase is replaced, not repeated", () => {
  let draft = play("", [
    { final: true, text: "Erster Satz." },
    { final: false, text: "zweiter" },
  ]);
  assert.equal(draft.written, "Erster Satz. zweiter");
  // The owner fixes a word at the start while "zweiter" is still interim.
  draft = applyTranscript(draft, "Mein Satz. zweiter", {
    final: false,
    text: "zweiter Satz",
  });
  assert.equal(draftText(draft), "Mein Satz. zweiter Satz");
  draft = applyTranscript(draft, draft.written, { final: true, text: "zweiter Satz." });
  assert.equal(draftText(draft), "Mein Satz. zweiter Satz.");
  // An edit that changed the interim words themselves keeps the owner's text.
  draft = play("", [{ final: false, text: "hallo" }]);
  draft = applyTranscript(draft, "Hallo!", { final: true, text: "hallo welt" });
  assert.equal(draftText(draft), "Hallo! hallo welt");
  draft = play("Liste:\n", [{ final: false, text: "eins" }]);
  draft = applyTranscript(draft, "Liste!\neins", { final: true, text: "eins zwei" });
  assert.equal(draftText(draft), "Liste!\neins zwei");
});

test("the composed text always starts with what the owner had", () => {
  const result = fc.record({ final: fc.boolean(), text: fc.string({ maxLength: 12 }) });
  fc.assert(
    fc.property(
      fc.string({ maxLength: 20 }),
      fc.array(result, { maxLength: 12 }),
      (text, results) => {
        const draft = play(text, results);
        assert.ok(draftText(draft).startsWith(text));
        const finals = results.filter((r) => r.final && r.text).map((r) => r.text);
        for (const words of finals) assert.ok(draftText(draft).includes(words));
      },
    ),
  );
});

test("the worklet encoder turns 48 kHz floats into 100 ms frames of 16 kHz PCM", () => {
  const encoder = new PcmEncoder(48000);
  const input = new Float32Array(4800 * 2 + 30).fill(0.5);
  input[0] = 2;
  const frames = encoder.push(input);
  assert.equal(frames.length, 2);
  for (const { buffer } of frames) assert.equal(buffer.byteLength, 3200);
  const samples = new Int16Array(frames[1].buffer);
  assert.ok(
    samples.every((value) => value === Math.round(0.5 * 0x7fff) || value === 16383),
  );
  assert.ok(frames[0].level <= 1);
  // 44.1 kHz input yields the same rate within a frame's rounding.
  const odd = new PcmEncoder(44100);
  assert.equal(odd.push(new Float32Array(44200)).length, 10);
});
