import test from "node:test";
import assert from "node:assert/strict";
import {
  anchorToChild,
  followEnd,
  landOn,
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
    listening: () => Object.keys(listeners),
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

test("a landing on the page scroller holds its target for a limited time", async (t) => {
  withObservers(t);
  // The page's own scroller: its box top moves with scrollTop, so it is not counted.
  const page = { ...transcript({ scrollTop: 100, scrollHeight: 3000 }), ...at(-100) };
  const saved = globalThis.document;
  globalThis.document = { scrollingElement: page };
  t.after(() => (globalThis.document = saved));
  const stop = landOn({ ...at(900), isConnected: true, parentElement: null }, 20);
  assert.equal(page.scrollTop, 988);
  assert.ok(page.listening().length > 0);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(page.listening(), []);
  stop();
});
