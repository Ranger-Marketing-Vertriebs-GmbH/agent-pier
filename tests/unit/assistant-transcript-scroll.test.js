import test from "node:test";
import assert from "node:assert/strict";
import {
  anchorToChild,
  followEnd,
  scrollToChild,
} from "../../web/features/assistants/transcript-scroll.js";

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

// A scrolling element with listeners; the observers do nothing in Node.
function transcript({ scrollTop, scrollHeight, clientHeight = 500 }) {
  const listeners = {};
  return {
    scrollTop,
    scrollHeight,
    clientHeight,
    children: [],
    ...at(0),
    addEventListener: (type, listener) => (listeners[type] = listener),
    removeEventListener: (type) => delete listeners[type],
    fire: (type) => listeners[type]?.({ type }),
  };
}
function withObservers(t) {
  const saved = [
    globalThis.ResizeObserver,
    globalThis.MutationObserver,
    globalThis.window,
  ];
  const Observer = class {
    observe() {}
    disconnect() {}
  };
  globalThis.ResizeObserver = Observer;
  globalThis.MutationObserver = Observer;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  t.after(() => {
    [globalThis.ResizeObserver, globalThis.MutationObserver, globalThis.window] = saved;
  });
}

test("a landing scroll that ends near the end does not hold the end", (t) => {
  withObservers(t);
  // The entry sits just above the end: scrolling to it ends within 80 px of it.
  const container = transcript({ scrollTop: 0, scrollHeight: 1100 });
  const stick = { current: false },
    scroll = { current: 0 };
  let anchored = true;
  const stop = followEnd(container, stick, scroll, () => anchored);
  stick.current = false;
  container.scrollTop = 560;
  container.fire("scroll");
  assert.equal(stick.current, false);
  // Once the anchor lets go, reaching the end holds it again.
  anchored = false;
  container.fire("scroll");
  assert.equal(stick.current, true);
  stop();
});

test("the anchor reports when the reader lets go of it", (t) => {
  withObservers(t);
  const container = transcript({ scrollTop: 0, scrollHeight: 2000 });
  let stopped = 0;
  anchorToChild(
    container,
    { ...at(900), isConnected: true },
    () => true,
    () => stopped++,
  );
  assert.equal(container.scrollTop, 888);
  container.fire("wheel");
  assert.equal(stopped, 1);
});
