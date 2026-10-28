import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { check } from "../helpers/property.js";
import { listRows } from "../../server/features/live/live-rows.js";
import { ChatSync } from "../../server/features/chat/chat-sync.js";
import { applyListSync } from "../../web/lib/live/list-sync.js";

const item = fc.record({
  id: fc.constantFrom("a", "b", "c", "d", "e", "f"),
  value: fc.oneof(fc.integer(), fc.string({ maxLength: 4 }), fc.boolean()),
});
// Plain JSON objects, as a topic read returns them (fast-check may build null prototypes).
const list = fc
  .record({
    items: fc.uniqueArray(item, { selector: (entry) => entry.id, maxLength: 6 }),
    more: fc.uniqueArray(item, { selector: (entry) => entry.id, maxLength: 3 }),
    total: fc.integer({ min: 0, max: 50 }),
    label: fc.oneof(fc.constant(null), fc.string({ maxLength: 4 })),
    flags: fc.dictionary(fc.constantFrom("x", "y", "z"), fc.boolean(), { maxKeys: 3 }),
  })
  .map((value) => JSON.parse(JSON.stringify(value)));

test("deltas against the previous cursor rebuild the same list as a fresh snapshot", () => {
  check(
    fc.property(fc.array(list, { minLength: 1, maxLength: 8 }), (values) => {
      const sync = new ChatSync({});
      let held = null;
      for (const value of values) {
        const data = sync.encodeScoped(
          ["topic", "owner"],
          listRows(value),
          held?.state.sync.cursor,
        );
        held = applyListSync(held, data);
      }
      const fresh = applyListSync(
        null,
        new ChatSync({}).encodeScoped(["topic", "owner"], listRows(values.at(-1))),
      );
      assert.deepEqual(held.list, fresh.list);
      assert.deepEqual(held.list, values.at(-1));
    }),
  );
});
