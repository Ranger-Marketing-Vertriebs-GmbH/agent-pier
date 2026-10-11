import test from "node:test";
import assert from "node:assert/strict";
import { scrollToChild } from "../../web/features/assistants/transcript-scroll.js";

const at = (top) => ({ getBoundingClientRect: () => ({ top }) });
test("scrolls the transcript so the child sits just below its top edge", () => {
  const container = { scrollTop: 100, ...at(50) };
  assert.equal(scrollToChild(container, at(450)), true);
  assert.equal(container.scrollTop, 488);
});
test("never scrolls above the start and ignores missing nodes", () => {
  const container = { scrollTop: 0, ...at(50) };
  scrollToChild(container, at(40));
  assert.equal(container.scrollTop, 0);
  assert.equal(scrollToChild(null, at(1)), false);
  assert.equal(scrollToChild(container, null), false);
});
