import test from "node:test";
import assert from "node:assert/strict";
import { createViewportVariables } from "../../web/features/sessions/viewport-variables.js";

test("the variables stay until the last holder releases", () => {
  const removed = [];
  const style = { setProperty() {}, removeProperty: (name) => removed.push(name) };
  const vars = createViewportVariables(style);
  const a = vars.acquire(),
    b = vars.acquire();
  a();
  assert.deepEqual(removed, []);
  b();
  assert.deepEqual(removed, ["--session-viewport-height", "--session-viewport-top"]);
  b();
  assert.equal(removed.length, 2); // a second release is a no-op
});

test("a holder acquired after the last release clears again on its own release", () => {
  const removed = [];
  const style = { setProperty() {}, removeProperty: (name) => removed.push(name) };
  const vars = createViewportVariables(style);
  vars.acquire()();
  assert.equal(removed.length, 2);
  const again = vars.acquire();
  again();
  assert.equal(removed.length, 4);
});
