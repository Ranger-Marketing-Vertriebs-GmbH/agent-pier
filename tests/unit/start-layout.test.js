import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanStartLayout,
  readStartLayout,
  rememberStartLayout,
  startLayoutDefaults,
} from "../../web/features/dashboard/start-layout.js";

const KEY = "agentpier.start.layout";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  return {
    writes,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => {
      writes.push(key);
      values.set(key, String(value));
    },
  };
}

test("a first visit starts from the defaults", () => {
  assert.deepEqual(readStartLayout(memoryStorage()), startLayoutDefaults);
  assert.deepEqual(readStartLayout(null), startLayoutDefaults);
});

test("the known parts are remembered and read back over the defaults", () => {
  const storage = memoryStorage();
  rememberStartLayout(
    { agents: false, attention: 2, sessions: { items: 24, rows: 18 } },
    storage,
  );
  rememberStartLayout({ runs: 3, tools: undefined, agentList: null }, storage);
  assert.deepEqual(readStartLayout(storage), {
    ...startLayoutDefaults,
    agents: false,
    attention: 2,
    sessions: { items: 24, rows: 18 },
    runs: 3,
  });
});

test("an unchanged layout is not written again", () => {
  const storage = memoryStorage();
  rememberStartLayout({ attention: 1 }, storage);
  rememberStartLayout({ attention: 1 }, storage);
  rememberStartLayout({}, storage);
  assert.equal(storage.writes.length, 1);
});

test("broken or foreign values fall back to the defaults", () => {
  for (const stored of ["not json", "[]", "null", '{"attention":-1,"agents":"yes"}'])
    assert.deepEqual(
      readStartLayout(memoryStorage({ [KEY]: stored })),
      startLayoutDefaults,
      stored,
    );
  assert.deepEqual(
    cleanStartLayout({
      attention: 1.5,
      runs: 1e9,
      sessions: { items: 2, rows: 5 },
      agentList: { items: 3 },
      tools: "4",
      extra: 1,
    }),
    { runs: 999, sessions: { items: 2, rows: 2 } },
  );
});

test("storage that refuses access neither throws nor remembers", () => {
  const refusing = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
  assert.deepEqual(readStartLayout(refusing), startLayoutDefaults);
  assert.deepEqual(rememberStartLayout({ attention: 2 }, refusing), { attention: 2 });
});
