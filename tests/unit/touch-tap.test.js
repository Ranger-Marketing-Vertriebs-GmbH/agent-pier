import test from "node:test";
import assert from "node:assert/strict";
import { createTouchTap, clickWaitMs } from "../../web/lib/useTouchTap.js";

function fixture() {
  const taps = [];
  const timers = new Map();
  let next = 1;
  const tap = createTouchTap({
    onTap: (button) => taps.push(button),
    setTimer: (run, ms) => {
      timers.set(next, { run, ms });
      return next++;
    },
    clearTimer: (id) => timers.delete(id),
  });
  const button = {
    disabled: false,
    isConnected: true,
    getBoundingClientRect: () => ({ left: 100, right: 144, top: 200, bottom: 244 }),
  };
  const pointer = (x = 120, y = 220, extra = {}) => ({
    pointerType: "touch",
    pointerId: 7,
    clientX: x,
    clientY: y,
    currentTarget: button,
    ...extra,
  });
  const elapse = () => {
    for (const [id, timer] of [...timers]) {
      timers.delete(id);
      timer.run();
    }
  };
  const click = () => {
    const event = {
      prevented: false,
      preventDefault() {
        this.prevented = true;
      },
      stopPropagation() {},
    };
    tap.onClick(event);
    return event.prevented;
  };
  return { tap, taps, timers, button, pointer, elapse, click };
}

test("a touch tap without a click acts after the wait", () => {
  const f = fixture();
  f.tap.onPointerDown(f.pointer());
  f.tap.onPointerUp(f.pointer(122, 221));
  assert.equal(f.taps.length, 0);
  assert.deepEqual(
    [...f.timers.values()].map((timer) => timer.ms),
    [clickWaitMs],
  );
  f.elapse();
  assert.deepEqual(f.taps, [f.button]);
});

test("a click that arrives is left alone and nothing else acts", () => {
  const f = fixture();
  f.tap.onPointerDown(f.pointer());
  f.tap.onPointerUp(f.pointer());
  assert.equal(f.click(), false);
  assert.equal(f.timers.size, 0);
  f.elapse();
  assert.equal(f.taps.length, 0);
});

test("a click arriving after the fallback acted is dropped once", () => {
  const f = fixture();
  f.tap.onPointerDown(f.pointer());
  f.tap.onPointerUp(f.pointer());
  f.elapse();
  assert.equal(f.click(), true);
  assert.equal(f.click(), false);
  assert.equal(f.taps.length, 1);
});

test("a mouse, a drag, a lift outside and a cancelled touch never act", () => {
  for (const run of [
    (f) => {
      f.tap.onPointerDown(f.pointer(120, 220, { pointerType: "mouse" }));
      f.tap.onPointerUp(f.pointer(120, 220, { pointerType: "mouse" }));
    },
    (f) => {
      f.tap.onPointerDown(f.pointer(120, 220));
      f.tap.onPointerUp(f.pointer(140, 220));
    },
    (f) => {
      f.tap.onPointerDown(f.pointer(142, 220));
      f.tap.onPointerUp(f.pointer(147, 220));
    },
    (f) => {
      f.tap.onPointerDown(f.pointer());
      f.tap.onPointerCancel();
      f.tap.onPointerUp(f.pointer());
    },
    (f) => {
      f.tap.onPointerDown(f.pointer());
      f.tap.onPointerUp(f.pointer(120, 220, { pointerId: 8 }));
    },
  ]) {
    const f = fixture();
    run(f);
    f.elapse();
    assert.equal(f.taps.length, 0);
  }
});

test("a button disabled or removed while the click is awaited does not act", () => {
  for (const change of [(b) => (b.disabled = true), (b) => (b.isConnected = false)]) {
    const f = fixture();
    f.tap.onPointerDown(f.pointer());
    f.tap.onPointerUp(f.pointer());
    change(f.button);
    f.elapse();
    assert.equal(f.taps.length, 0);
  }
});

test("a second touch replaces a pending tap", () => {
  const f = fixture();
  f.tap.onPointerDown(f.pointer());
  f.tap.onPointerUp(f.pointer());
  f.tap.onPointerDown(f.pointer());
  assert.equal(f.timers.size, 0);
  f.tap.onPointerUp(f.pointer());
  f.elapse();
  assert.equal(f.taps.length, 1);
});
