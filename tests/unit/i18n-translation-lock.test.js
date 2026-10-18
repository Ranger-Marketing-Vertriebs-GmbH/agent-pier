import test from "node:test";
import assert from "node:assert/strict";
import {
  createLock,
  describeUntranslated,
  findStale,
  findUntranslated,
  flattenMessages,
  loadCatalogs,
  lockPaths,
  readLock,
  serializeLock,
} from "../../scripts/i18n-translation-lock.mjs";

for (const kind of Object.keys(lockPaths)) {
  test(`${kind} English messages follow changes to their German source`, async (t) => {
    const { german, english } = await loadCatalogs(kind);
    const lock = await readLock(kind);
    assert.ok(Object.keys(lock).length > 0, `${lockPaths[kind]} is missing`);
    const found = findUntranslated(german, english, lock);
    assert.deepEqual(found, [], describeUntranslated(found));
    const stale = findStale(german, english, lock).length;
    if (stale) t.diagnostic(`${stale} entries outdated; npm run i18n:confirm refreshes`);
  });
}

const catalog = (value) => flattenMessages(value);
const germanCopy = {
  page: { title: "Konten", greet: (name) => `Hallo ${name}` },
  hint: "Alles bleibt lokal.",
};
const englishCopy = {
  page: { title: "Accounts", greet: (name) => `Hello ${name}` },
  hint: "Everything stays local.",
};
const lock = createLock(catalog(germanCopy), catalog(englishCopy));

test("flattening renders functions with placeholder arguments", () => {
  assert.deepEqual(
    [...catalog(germanCopy)],
    [
      ["page.title", "Konten"],
      ["page.greet", "Hallo __ARG_0__"],
      ["hint", "Alles bleibt lokal."],
    ],
  );
});

test("a German-only change names the key and shows both texts", () => {
  const german = catalog({ ...germanCopy, hint: "Alles bleibt auf deinem Rechner." });
  const found = findUntranslated(german, catalog(englishCopy), lock);
  assert.deepEqual(found, [
    {
      key: "hint",
      german: "Alles bleibt auf deinem Rechner.",
      english: "Everything stays local.",
    },
  ]);
  const message = describeUntranslated(found);
  assert.match(message, /hint\n {4}de: "Alles bleibt auf deinem Rechner\."/);
  assert.match(message, /en: "Everything stays local\."/);
  assert.match(message, /npm run i18n:confirm/);
});

test("a German-only change to a message function is detected", () => {
  const german = catalog({
    ...germanCopy,
    page: { ...germanCopy.page, greet: (name) => `Willkommen ${name}` },
  });
  const found = findUntranslated(german, catalog(englishCopy), lock);
  assert.deepEqual(
    found.map(({ key }) => key),
    ["page.greet"],
  );
});

test("changing both texts or confirming the lock passes", () => {
  const german = catalog({ ...germanCopy, hint: "Alles bleibt auf deinem Rechner." });
  const english = catalog({ ...englishCopy, hint: "Everything stays on your machine." });
  assert.deepEqual(findUntranslated(german, english, lock), []);
  assert.deepEqual(findStale(german, english, lock), ["hint"]);
  const confirmed = createLock(german, catalog(englishCopy));
  assert.deepEqual(findUntranslated(german, catalog(englishCopy), confirmed), []);
  assert.deepEqual(findStale(german, catalog(englishCopy), confirmed), []);
});

test("whitespace-only changes are ignored", () => {
  const german = catalog({ ...germanCopy, hint: "  Alles bleibt\n    lokal. " });
  assert.deepEqual(findUntranslated(german, catalog(englishCopy), lock), []);
  assert.deepEqual(findStale(german, catalog(englishCopy), lock), []);
});

test("added and removed keys are left to the parity tests", () => {
  const german = catalog({ ...germanCopy, added: "Neu", page: { title: "Profile" } });
  const english = catalog({ ...englishCopy, page: { title: "Accounts" } });
  const found = findUntranslated(german, english, lock);
  assert.deepEqual(
    found.map(({ key }) => key),
    ["page.title"],
  );
  const englishMissing = catalog({ hint: "Everything stays local." });
  assert.deepEqual(
    findUntranslated(
      catalog({ ...germanCopy, page: { title: "Profile" } }),
      englishMissing,
      lock,
    ),
    [],
  );
});

test("the lock keeps one sorted key per line", () => {
  const text = serializeLock({ b: "de:2 en:2", a: "de:1 en:1" });
  assert.equal(text, '{\n  "a": "de:1 en:1",\n  "b": "de:2 en:2"\n}\n');
  assert.deepEqual(Object.keys(lock), ["hint", "page.greet", "page.title"]);
  assert.match(lock.hint, /^de:[0-9a-f]{12} en:[0-9a-f]{12}$/);
});
