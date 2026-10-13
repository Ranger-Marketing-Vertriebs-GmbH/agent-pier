import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { check } from "../helpers/property.js";
import { followServer, sameValue } from "../../web/lib/settings/draft-state.js";

const keys = ["a", "b", "c", "d"];
const record = fc.record(
  Object.fromEntries(keys.map((key) => [key, fc.integer({ min: 0, max: 2 })])),
);

test("following the server never loses an edit and never keeps a stale untouched value", () => {
  check(
    fc.property(record, record, record, (base, values, server) => {
      const next = followServer({ values, base }, server);
      for (const key of keys) {
        const edited = !sameValue(values[key], base[key]);
        if (!edited) assert.equal(next.values[key], server[key], `untouched ${key}`);
        else assert.equal(next.values[key], values[key], `edited ${key}`);
        const conflict =
          edited &&
          !sameValue(values[key], server[key]) &&
          !sameValue(server[key], base[key]);
        assert.equal(next.conflicts.includes(key), conflict, `conflict ${key}`);
      }
    }),
  );
});
