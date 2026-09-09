import test from "node:test";
import assert from "node:assert/strict";
import * as i18n from "../../web/lib/i18n/index.js";

test("language detection respects saved preference and supported browser languages", () => {
  assert.equal(typeof i18n.detectLanguage, "function");
  assert.equal(i18n.detectLanguage("en", ["de-DE"]), "en");
  assert.equal(i18n.detectLanguage("de", ["en-US"]), "de");
  assert.equal(i18n.detectLanguage("invalid", ["fr", "en-GB"]), "en");
  assert.equal(i18n.detectLanguage(null, ["de-AT"]), "de");
  assert.equal(i18n.detectLanguage(null, ["fr"]), "en");
  assert.equal(i18n.detectLanguage(null, []), "de");
});

test("language updates publish once, format dates, persist, and reject invalid choices", () => {
  assert.equal(typeof i18n.setLanguage, "function");
  const values = new Map();
  const storage = { setItem: (key, value) => values.set(key, value) };
  const document = { documentElement: { lang: "de" } };
  i18n.setLanguage("de", { storage, document });
  let changes = 0;
  const unsubscribe = i18n.subscribeLanguage(() => changes++);
  i18n.setLanguage("en", { storage, document });
  assert.equal(i18n.language, "en");
  assert.equal(i18n.locale, "en-US");
  assert.equal(i18n.formatNumber(1234.5), "1,234.5");
  assert.equal(values.get("agentpier-language"), "en");
  assert.equal(document.documentElement.lang, "en");
  assert.equal(i18n.formatTimestamp(0), new Date(0).toLocaleString("en-US"));
  i18n.setLanguage("en", { storage, document });
  assert.equal(changes, 1);
  assert.throws(() => i18n.setLanguage("fr"), /Unsupported language/);
  unsubscribe();
  i18n.setLanguage("de", { storage, document });
  assert.equal(changes, 1);
  assert.equal(i18n.formatNumber(1234.5), "1.234,5");
});

test("storage denial does not prevent changing the interface language", () => {
  assert.equal(typeof i18n.setLanguage, "function");
  const storage = {
    setItem() {
      throw new Error("blocked");
    },
  };
  i18n.setLanguage("en", { storage });
  assert.equal(i18n.language, "en");
  i18n.setLanguage("de", { storage });
});

test("catalogs switch reactively including frozen and nested messages", () => {
  const de = Object.freeze({
    title: "Hallo",
    nested: { value: "Welt" },
    name: (n) => `Hallo ${n}`,
  });
  const en = Object.freeze({
    title: "Hello",
    nested: { value: "World" },
    name: (n) => `Hello ${n}`,
  });
  const copy = i18n.localizedCopy(de, en);
  const nested = copy.nested;
  i18n.setLanguage("en");
  assert.equal(copy.title, "Hello");
  assert.equal(nested.value, "World");
  assert.equal(copy.name("Ada"), "Hello Ada");
  assert.deepEqual(Object.keys(copy), Object.keys(de));
  i18n.setLanguage("de");
  assert.equal(copy.title, "Hallo");
});

test("browser initialization and storage changes follow persisted preferences", () => {
  let listener;
  const browser = {
    localStorage: { getItem: () => "en" },
    navigator: { languages: ["de-DE"] },
    document: { documentElement: {} },
    addEventListener: (name, fn) => {
      assert.equal(name, "storage");
      listener = fn;
    },
    removeEventListener: (name, fn) => {
      assert.equal(name, "storage");
      assert.equal(fn, listener);
    },
  };
  const dispose = i18n.initializeLanguage(browser);
  assert.equal(i18n.language, "en");
  assert.equal(browser.document.documentElement.lang, "en");
  listener({ key: "unrelated", newValue: "de" });
  assert.equal(i18n.language, "en");
  listener({ key: "agentpier-language", newValue: "de" });
  assert.equal(i18n.language, "de");
  listener({ key: "agentpier-language", newValue: null });
  assert.equal(i18n.language, "de");
  dispose();
});
