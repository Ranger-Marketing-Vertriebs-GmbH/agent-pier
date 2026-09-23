import test from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { serverCatalogs } from "../../server/lib/i18n/catalogs.js";
import {
  createMessageIndex,
  messageEntries,
  resolveMessage,
} from "../../server/lib/i18n/message-keys.js";

const base = new URL("../../server/lib/i18n/", import.meta.url);
// Operator script output is terminal-only and has no browser translation.
const terminalOnly = new Set(["scripts.js"]);

function compare(german, english, path) {
  assert.equal(typeof english, typeof german, path);
  if (typeof german === "function") {
    assert.equal(english.length, german.length, `${path} arguments`);
    const args = Array.from({ length: german.length }, (_, i) => `__ARG_${i}__`);
    const expected = german(...args);
    const actual = english(...args);
    assert.equal(typeof actual, "string", path);
    for (const arg of args)
      assert.equal(actual.includes(arg), expected.includes(arg), `${path}: ${arg}`);
  } else if (german && typeof german === "object") {
    assert.deepEqual(Object.keys(english).sort(), Object.keys(german).sort(), path);
    for (const key of Object.keys(german))
      compare(german[key], english[key], `${path}.${key}`);
  } else assert.ok(english.length > 0, path);
}

test("server messages have matching German and English catalogs", async () => {
  const files = (await readdir(new URL("de/", base)))
    .filter((name) => name.endsWith(".js") && !terminalOnly.has(name))
    .sort();
  assert.deepEqual((await readdir(new URL("en/", base))).sort(), files);
  const published = new Set(Object.values(serverCatalogs.de));
  for (const file of files) {
    const de = await import(new URL(`de/${file}`, base));
    const en = await import(new URL(`en/${file}`, base));
    compare(de, en, file);
    for (const [name, catalog] of Object.entries(de))
      assert.ok(published.has(catalog), `${file} ${name} has stable browser keys`);
  }
  compare(serverCatalogs.de, serverCatalogs.en, "serverCatalogs");
  assert.equal(Object.hasOwn(serverCatalogs.de, "scripts"), false);
});

test("identical German messages keep identical English translations", () => {
  const english = new Map(messageEntries(serverCatalogs.en));
  const seen = new Map();
  for (const [key, text] of messageEntries(serverCatalogs.de)) {
    if (typeof text !== "string") continue;
    if (seen.has(text))
      assert.equal(
        english.get(key),
        english.get(seen.get(text)),
        `${key} vs ${seen.get(text)}`,
      );
    else seen.set(text, key);
  }
});

test("every German server message traces back to a key that resolves in English", () => {
  const identify = createMessageIndex(serverCatalogs.de);
  for (const [key, message] of messageEntries(serverCatalogs.de)) {
    const args = Array.from({ length: message.length }, (_, i) => `Arg${i}`);
    const text = typeof message === "function" ? message(...args) : message;
    if (!text.trim()) continue;
    const found = identify(text);
    assert.ok(found, key);
    assert.equal(
      resolveMessage(serverCatalogs.en, found.key, found.args),
      resolveMessage(serverCatalogs.en, key, args),
      key,
    );
  }
});
