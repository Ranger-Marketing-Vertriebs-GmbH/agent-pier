import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { check } from "../helpers/property.js";
import { LiveInstance } from "../../server/features/live/live-instance.js";
import { ChatSync } from "../../server/features/chat/chat-sync.js";
import { manualTimers } from "../helpers/manual-timers.js";

// A change sets the value (often to the one already held) and invalidates; a wait
// lets time pass; a slow read holds the next read for a while.
const step = fc.oneof(
  fc.record({ change: fc.integer({ min: 0, max: 3 }) }),
  fc.record({ wait: fc.integer({ min: 0, max: 1500 }) }),
  fc.record({ slow: fc.integer({ min: 1, max: 400 }) }),
);

test("coalescing never loses the last change and revisions rise by one per frame", async () => {
  await check(
    fc.asyncProperty(fc.array(step, { maxLength: 30 }), async (steps) => {
      const clock = manualTimers();
      const source = { value: 0, slow: 0, reads: 0 };
      let invalidate;
      const instance = new LiveInstance({
        definition: {
          name: "demo",
          mode: "state",
          authorize: () => true,
          scopeKey: () => "owner",
          read: async () => {
            source.reads++;
            // The read sees the value as it starts; changes during it need another.
            const value = source.value;
            const delay = source.slow;
            source.slow = 0;
            if (delay)
              await new Promise((resolve) => clock.timers.setTimeout(resolve, delay));
            return { value };
          },
          watch: (hooks) => {
            invalidate = hooks.invalidate;
            return () => {};
          },
        },
        topicId: "demo",
        scopeKey: "owner",
        instance: "hub",
        sync: new ChatSync({}),
        timers: clock.timers,
      });
      const frames = [];
      instance.add({ principal: {}, send: (frame) => frames.push(frame) });
      await clock.advance(0);
      let changes = 0;
      for (const { change, wait, slow } of steps) {
        if (change !== undefined) {
          source.value = change;
          changes++;
          invalidate();
        } else if (slow) source.slow = slow;
        else await clock.advance(wait);
      }
      await clock.advance(5000);
      instance.stop();

      // Latest state wins: what the subscriber holds last is the current value.
      assert.deepEqual(frames.at(-1).data, { value: source.value });
      // A frame only for a difference, each one revision above the previous.
      for (let i = 1; i < frames.length; i++) {
        assert.notDeepEqual(frames[i].data, frames[i - 1].data);
        assert.equal(frames[i].revision, frames[i - 1].revision + 1);
      }
      // Coalescing merges: never more reads than the first one plus one per change.
      assert.ok(source.reads <= changes + 1);
    }),
  );
});
