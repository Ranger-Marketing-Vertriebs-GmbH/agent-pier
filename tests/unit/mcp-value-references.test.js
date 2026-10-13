import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { hasReference } from "../../server/features/mcp-servers/value-references.js";

test("hasReference recognizes each reference form and ignores near misses", () => {
  for (const value of ["${HOME}", "x${VAR:-a}y", "{env:TOKEN}", "a{file:./key}b", "${{}"])
    assert.equal(hasReference(value), true, value);
  for (const value of ["$HOME", "pa$$word", "${}", "{env:}", "{file:", "${", "{envX}"])
    assert.equal(hasReference(value), false, value);
});

// Inputs that made the former regular expression backtrack quadratically
// (100k characters took over a second). The scan stays linear.
test("hasReference checks 100k characters of unclosed openers in under 50 ms", () => {
  const length = 100_000;
  const inputs = ["${{", "${", "{env:{env:", "{file:", "${}"].map((unit) =>
    unit.repeat(Math.ceil(length / unit.length)).slice(0, length),
  );
  for (const input of inputs) {
    const started = performance.now();
    hasReference(input);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 50, `${JSON.stringify(input.slice(0, 6))}: ${elapsed} ms`);
  }
});
