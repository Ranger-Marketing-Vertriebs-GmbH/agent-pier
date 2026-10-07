import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { check } from "../helpers/property.js";
import {
  createIdMap,
  createNameMap,
} from "../../server/features/protocol-adapter/names.js";
import {
  decodeCarrier,
  encodeCarrier,
} from "../../server/features/protocol-adapter/carrier.js";

const profiles = [
  { pattern: /^[a-zA-Z0-9_-]{1,64}$/, maxLength: 64 },
  { pattern: /^[a-zA-Z0-9_-]{1,128}$/, maxLength: 128 },
  { pattern: /^[a-z0-9_]{1,12}$/, maxLength: 12 },
];

const char = fc.oneof(
  fc.constantFrom(..."ab_-.:/ Z09"),
  fc.constantFrom("__", "mcp__", "ü", "日", "😀"),
  fc.string({ minLength: 1, maxLength: 1, unit: "grapheme" }),
);
const name = fc
  .array(char, { minLength: 1, maxLength: 300 })
  .map((parts) => parts.join(""))
  .filter((value) => value.length >= 1 && value.length <= 300);
const entry = fc.record({
  name,
  namespace: fc.option(name, { nil: undefined }),
});

test("name maps are bijective, valid and idempotent for random name sets", () => {
  check(
    fc.property(
      fc.constantFrom(...profiles),
      fc.array(entry, { maxLength: 40 }),
      (profile, entries) => {
        const map = createNameMap(profile);
        const outputs = new Map();
        for (const item of entries) {
          const upstream = map.toUpstream(item.name, item.namespace);
          assert.match(upstream, profile.pattern);
          assert.ok(upstream.length <= profile.maxLength);
          assert.equal(map.toUpstream(item.name, item.namespace), upstream);
          const key = JSON.stringify([item.namespace ?? null, item.name]);
          outputs.set(key, upstream);
          const back = map.fromUpstream(upstream);
          assert.equal(back.name, item.name);
          assert.equal(back.namespace, item.namespace || undefined);
        }
        assert.equal(new Set(outputs.values()).size, outputs.size);
        for (const [key, upstream] of outputs) {
          const [namespace, original] = JSON.parse(key);
          const back = map.fromUpstream(upstream);
          assert.equal(back.name, original);
          assert.equal(back.namespace, namespace ?? undefined);
        }
      },
    ),
  );
});

test("id maps are bijective and idempotent", () => {
  check(
    fc.property(fc.array(name, { maxLength: 40 }), (ids) => {
      const map = createIdMap(/^[a-zA-Z0-9_-]+$/);
      const outputs = new Map();
      for (const id of ids) {
        const upstream = map.toUpstream(id);
        assert.match(upstream, /^[a-zA-Z0-9_-]+$/);
        assert.equal(map.toUpstream(id), upstream);
        assert.equal(map.fromUpstream(upstream), id);
        outputs.set(id, upstream);
      }
      assert.equal(new Set(outputs.values()).size, outputs.size);
    }),
  );
});

test("carrier round trips random payloads", () => {
  check(
    fc.property(
      fc.stringMatching(/^[a-z0-9-]{1,12}$/),
      fc.option(fc.string({ unit: "binary", maxLength: 500 }), { nil: null }),
      (origin, payload) => {
        const carrier = encodeCarrier(origin, payload);
        assert.match(carrier, /^ap1\.[a-z0-9-]+\.[A-Za-z0-9_-]*$/);
        assert.deepEqual(decodeCarrier(carrier), { origin, payload });
      },
    ),
  );
});

const carrierInput = fc.tuple(
  fc.stringMatching(/^[a-z0-9-]{1,12}$/),
  fc.string({ unit: "binary", minLength: 1, maxLength: 200 }),
);

test("structurally broken mutations of valid carriers never decode", () => {
  const mutations = {
    extraDot: (carrier, at) => `${carrier.slice(0, at)}.${carrier.slice(at)}`,
    plus: (carrier, at) => `${carrier.slice(0, at)}+${carrier.slice(at + 1)}`,
    slash: (carrier, at) => `${carrier.slice(0, at)}/${carrier.slice(at + 1)}`,
    padding: (carrier, _at, pad) => `${carrier}${"=".repeat(pad)}`,
  };
  check(
    fc.property(
      carrierInput,
      fc.constantFrom(...Object.keys(mutations)),
      fc.nat(),
      fc.integer({ min: 1, max: 2 }),
      ([origin, payload], kind, position, pad) => {
        const carrier = encodeCarrier(origin, payload);
        const bodyStart = carrier.lastIndexOf(".") + 1;
        // Mutate inside the base64url body (or anywhere for the extra dot).
        const at =
          kind === "extraDot"
            ? position % (carrier.length + 1)
            : bodyStart + (position % (carrier.length - bodyStart));
        assert.equal(decodeCarrier(mutations[kind](carrier, at, pad)), null);
      },
    ),
  );
});

test("truncated carriers decode to null or to a different payload, never the original", () => {
  check(
    fc.property(carrierInput, fc.nat(), ([origin, payload], cut) => {
      const carrier = encodeCarrier(origin, payload);
      const decoded = decodeCarrier(carrier.slice(0, cut % carrier.length));
      if (decoded !== null) {
        assert.equal(decoded.origin, origin);
        assert.notEqual(decoded.payload, payload);
        assert.equal(
          encodeCarrier(decoded.origin, decoded.payload).length < carrier.length,
          true,
        );
      }
    }),
  );
});
