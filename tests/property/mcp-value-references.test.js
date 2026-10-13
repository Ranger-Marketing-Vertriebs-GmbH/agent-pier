import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { hasReference } from "../../server/features/mcp-servers/value-references.js";

// The regular expression hasReference replaced; kept here as the reference semantics.
const regexReference = /\$\{[^}]+\}|\{(?:env|file):[^}]+\}/;

const settings = {
  seed: Number(process.env.FC_SEED || 261013),
  numRuns: Number(process.env.FC_RUNS || 2000),
};

// Pieces that build openers, closers and near misses, so generated strings hit
// references, empty references and unclosed openers often.
const piece = fc.constantFrom(
  "$",
  "{",
  "}",
  "${",
  "${}",
  "{env:",
  "{file:",
  "{env",
  "env:",
  "file:",
  ":",
  "e",
  "x",
  " ",
  "$$",
);
const value = fc.oneof(
  fc.array(piece, { maxLength: 30 }).map((pieces) => pieces.join("")),
  fc.string({ maxLength: 40 }),
);

test("hasReference matches the former regular expression on any string", () => {
  fc.assert(
    fc.property(value, (input) => {
      assert.equal(hasReference(input), regexReference.test(input));
    }),
    settings,
  );
});

test("hasReference is false for every non-string", () => {
  fc.assert(
    fc.property(
      fc.anything().filter((input) => typeof input !== "string"),
      (input) => {
        assert.equal(hasReference(input), false);
      },
    ),
    settings,
  );
});
