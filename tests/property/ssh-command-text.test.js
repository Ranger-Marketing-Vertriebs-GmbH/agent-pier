import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  commandSegments,
  hasHiddenCharacters,
  joinSegments,
} from "../../web/features/assistants/ssh-command-text.js";

const hidden = fc.constantFrom(
  "‮",
  "​",
  "⁦",
  "\u0000",
  "\r",
  "﻿",
  "\u{E0041}",
  "\u2028",
  "\uFE0F",
);
const text = fc
  .array(fc.oneof(fc.string({ unit: "grapheme" }), hidden), { maxLength: 20 })
  .map((parts) => parts.join(""));

test("rendering round-trips to the exact command and shows every hidden character", () => {
  fc.assert(
    fc.property(text, (command) => {
      const segments = commandSegments(command);
      assert.equal(joinSegments(segments), command);
      for (const s of segments)
        if ("text" in s) assert.equal(hasHiddenCharacters(s.text), false);
      assert.equal(
        segments.some((s) => "hidden" in s),
        hasHiddenCharacters(command),
      );
    }),
    { seed: Number(process.env.FC_SEED || 86016), numRuns: 500 },
  );
});
