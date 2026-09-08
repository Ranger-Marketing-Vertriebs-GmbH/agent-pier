import test from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { setLanguage } from "../../web/lib/i18n/index.js";

const base = new URL("../../web/lib/i18n/", import.meta.url);
function compare(german, english, path, exact = false) {
  assert.equal(typeof english, typeof german, path);
  if (typeof german === "function") {
    assert.equal(english.length, german.length, `${path} arguments`);
    const args = Array.from({ length: german.length }, (_, i) => `__ARG_${i}__`);
    const expected = german(...args);
    const actual = english(...args);
    assert.equal(typeof actual, "string", path);
    if (exact) assert.equal(actual, expected, path);
    for (const arg of args) {
      assert.equal(actual.includes(arg), expected.includes(arg), `${path}: ${arg}`);
    }
  } else if (german && typeof german === "object") {
    assert.deepEqual(Object.keys(english).sort(), Object.keys(german).sort(), path);
    for (const key of Object.keys(german))
      compare(german[key], english[key], `${path}.${key}`, exact);
  } else {
    assert.ok(english.length > 0, path);
    if (exact) assert.equal(english, german, path);
  }
}

test("every message has matching German and English catalogs and reactive exports", async () => {
  const files = (await readdir(new URL("de/", base)))
    .filter((name) => name.endsWith(".js"))
    .sort();
  assert.deepEqual((await readdir(new URL("en/", base))).sort(), files);
  assert.deepEqual((await readdir(new URL("messages/", base))).sort(), files);
  for (const file of files) {
    const de = await import(new URL(`de/${file}`, base));
    const en = await import(new URL(`en/${file}`, base));
    const messages = await import(new URL(`messages/${file}`, base));
    compare(de, en, file);
    setLanguage("en");
    compare(en, messages, `${file} English exports`, true);
    setLanguage("de");
    compare(de, messages, `${file} German exports`, true);
  }
});
