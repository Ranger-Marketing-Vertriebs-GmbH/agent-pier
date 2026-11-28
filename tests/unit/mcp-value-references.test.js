import test from "node:test";
import assert from "node:assert/strict";
import { growth, linearAtMost } from "../helpers/cpu-time.js";
import { hasReference } from "../../server/features/mcp-servers/value-references.js";

test("hasReference recognizes each reference form and ignores near misses", () => {
  for (const value of ["${HOME}", "x${VAR:-a}y", "{env:TOKEN}", "a{file:./key}b", "${{}"])
    assert.equal(hasReference(value), true, value);
  for (const value of ["$HOME", "pa$$word", "${}", "{env:}", "{file:", "${", "{envX}"])
    assert.equal(hasReference(value), false, value);
});

// Inputs that made the former regular expression backtrack quadratically
// (100k characters took over a second). The scan stays linear.
// Measured as growth, not against a time budget (tests/helpers/cpu-time.js): 16 times
// the input takes about 16 times as long, and about 256 times when it backtracks.
test("hasReference checks unclosed openers in linear time, up to 400k characters", () => {
  for (const unit of ["${{", "${", "{env:{env:", "{file:", "${}"]) {
    const input = (length) =>
      unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
    const factor = growth(hasReference, input, 25_000);
    assert.ok(
      factor < linearAtMost(),
      `${JSON.stringify(unit)}: 16 times the input took ${factor.toFixed(1)} times as long`,
    );
  }
});
