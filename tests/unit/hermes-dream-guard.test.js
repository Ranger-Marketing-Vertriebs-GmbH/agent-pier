import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { dreamGuard } from "../../server/features/assistants/hermes-dream-guard.js";

const before = {
  "MEMORY.md": "📌 Owner drinks tea\n§\nplain",
  "USER.md": "📌 Name is Ada\n§\nlikes cats",
};
const after = (patch) => ({ ...before, ...patch });

test("a night that keeps every pin passes", () => {
  assert.deepEqual(
    dreamGuard(before, {
      "MEMORY.md": "merged\n§\n📌 Owner drinks tea",
      "USER.md": "📌 Name is Ada",
    }),
    { ok: true },
  );
});

test("a dropped pin discards the night", () => {
  assert.deepEqual(dreamGuard(before, after({ "USER.md": "likes cats" })), {
    ok: false,
    reason: "pinLost",
    file: "USER.md",
  });
});

test("a pinned entry changed by one character discards the night", () => {
  for (const text of [
    "📌Owner drinks tea",
    "📌️ Owner drinks tea",
    "📌 Owner drinks tea.",
  ]) {
    assert.deepEqual(dreamGuard(before, after({ "MEMORY.md": text })), {
      ok: false,
      reason: "pinLost",
      file: "MEMORY.md",
    });
  }
});

test("a pin moved to the other file discards the night", () => {
  assert.deepEqual(
    dreamGuard(before, {
      "MEMORY.md": "plain",
      "USER.md": "📌 Name is Ada\n§\n📌 Owner drinks tea",
    }),
    { ok: false, reason: "pinLost", file: "MEMORY.md" },
  );
});

test("a file over its limit discards the night", () => {
  assert.deepEqual(
    dreamGuard(
      before,
      after({ "MEMORY.md": `📌 Owner drinks tea\n§\n${"x".repeat(10001)}` }),
    ),
    { ok: false, reason: "tooLarge", file: "MEMORY.md" },
  );
  assert.deepEqual(
    dreamGuard(
      { "MEMORY.md": "", "USER.md": "" },
      {
        "MEMORY.md": "x".repeat(10001),
        "USER.md": "",
      },
    ),
    { ok: false, reason: "tooLarge", file: "MEMORY.md" },
  );
});

test("pins alone above 80 % still pass", () => {
  const pins = `📌 ${"p".repeat(8997)}`;
  const state = { "MEMORY.md": `${pins}\n§\n${"y".repeat(400)}`, "USER.md": "" };
  assert.deepEqual(dreamGuard(state, { "MEMORY.md": pins, "USER.md": "" }), { ok: true });
  assert.deepEqual(
    dreamGuard(state, { "MEMORY.md": `${pins}\n§\n${"y".repeat(500)}`, "USER.md": "" }),
    { ok: true },
  );
});

test("any after that contains every before pin per file in any order passes", () => {
  const entry = fc
    .string({ minLength: 1, maxLength: 20 })
    .map((s) => s.replace(/§/g, "-").trim())
    .filter(Boolean);
  const pin = entry.map((s) => `📌 ${s}`);
  const side = fc.record({
    pins: fc.array(pin, { maxLength: 4 }),
    others: fc.array(entry, { maxLength: 4 }),
  });
  fc.assert(
    fc.property(side, side, fc.integer(), (m, u, seed) => {
      const join = (a) => a.join("\n§\n");
      const shuffle = (a) =>
        [...a].sort((x, y) => ((x.length * seed) % 7) - ((y.length * seed) % 7));
      const b = {
        "MEMORY.md": join([...m.pins, ...m.others]),
        "USER.md": join([...u.pins, ...u.others]),
      };
      const a = {
        "MEMORY.md": join(shuffle([...m.pins, "extra"])),
        "USER.md": join(shuffle(u.pins)),
      };
      assert.deepEqual(dreamGuard(b, a), { ok: true });
    }),
  );
});
