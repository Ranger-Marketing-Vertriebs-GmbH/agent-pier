import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";

// The translation lock records, per message key, a hash of the German source and
// of the English translation at the last review (`npm run i18n:confirm`). When the
// German text changes but the English one still matches the lock, the English
// translation was probably not updated. See AGENTS.md.

const root = new URL("../", import.meta.url);
export const lockPaths = {
  web: "web/lib/i18n/translation-lock.json",
  server: "server/lib/i18n/translation-lock.json",
};

/** Placeholder arguments that make a message function render its template. */
export function placeholderArgs(length) {
  return Array.from({ length }, (_, i) => `__ARG_${i}__`);
}

/** Renders a catalog message: strings as is, functions with placeholder arguments. */
export function renderMessage(message) {
  return typeof message === "function"
    ? message(...placeholderArgs(message.length))
    : message;
}

/** Flattens a catalog into key path → rendered text, for strings and functions. */
export function flattenMessages(value, prefix = "", found = new Map()) {
  if (typeof value === "string" || typeof value === "function") {
    const text = renderMessage(value);
    if (typeof text === "string") found.set(prefix, text);
  } else if (value && typeof value === "object") {
    for (const key of Object.keys(value))
      flattenMessages(value[key], prefix ? `${prefix}.${key}` : key, found);
  }
  return found;
}

// Whitespace-only edits (rewrapping, trailing spaces) do not need a new review.
export function textHash(text) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

function entry(german, english) {
  return `de:${textHash(german)} en:${textHash(english)}`;
}
function parseEntry(value) {
  const match = /^de:([0-9a-f]+) en:([0-9a-f]+)$/.exec(value);
  return match ? { de: match[1], en: match[2] } : null;
}

/** The lock for the current texts: every key present in both languages. */
export function createLock(german, english) {
  const lock = {};
  for (const key of [...german.keys()].sort())
    if (english.has(key)) lock[key] = entry(german.get(key), english.get(key));
  return lock;
}

/** One key per line, sorted, so parallel changes to the lock merge cleanly. */
export function serializeLock(lock) {
  const sorted = Object.fromEntries(
    Object.keys(lock)
      .sort()
      .map((key) => [key, lock[key]]),
  );
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/**
 * Keys whose German text changed since the lock while the English text did not.
 * Keys missing from either language or from the lock are left to the parity
 * tests; a key whose German and English texts both changed counts as translated.
 */
export function findUntranslated(german, english, lock) {
  const found = [];
  for (const [key, germanText] of german) {
    const locked = typeof lock[key] === "string" ? parseEntry(lock[key]) : null;
    if (!locked || !english.has(key)) continue;
    const englishText = english.get(key);
    if (textHash(germanText) !== locked.de && textHash(englishText) === locked.en)
      found.push({ key, german: germanText, english: englishText });
  }
  return found;
}

/** Keys whose lock entry is missing or differs; `npm run i18n:confirm` refreshes them. */
export function findStale(german, english, lock) {
  const current = createLock(german, english);
  const keys = new Set([...Object.keys(current), ...Object.keys(lock)]);
  return [...keys].filter((key) => current[key] !== lock[key]).sort();
}

export function describeUntranslated(found) {
  const lines = found.flatMap(({ key, german, english }) => [
    `  ${key}`,
    `    de: ${JSON.stringify(german)}`,
    `    en: ${JSON.stringify(english)}`,
  ]);
  return [
    "The German text of these messages changed, but their English text did not:",
    ...lines,
    "Update the English text, or run `npm run i18n:confirm` once it has been reviewed.",
  ].join("\n");
}

async function webCatalogs() {
  const base = new URL("web/lib/i18n/", root);
  const german = new Map();
  const english = new Map();
  const files = (await readdir(new URL("de/", base)))
    .filter((name) => name.endsWith(".js"))
    .sort();
  for (const file of files) {
    const prefix = file.replace(/\.js$/, ":");
    const de = await import(new URL(`de/${file}`, base));
    let en = {};
    try {
      en = await import(new URL(`en/${file}`, base));
    } catch {
      // A missing English catalog is reported by the parity test.
    }
    for (const [key, text] of flattenMessages({ ...de })) german.set(prefix + key, text);
    for (const [key, text] of flattenMessages({ ...en })) english.set(prefix + key, text);
  }
  return { german, english };
}

// Terminal-only script output (de/scripts.js) is not part of the server catalogs.
async function serverCatalogs() {
  const { serverCatalogs: catalogs } = await import(
    new URL("server/lib/i18n/catalogs.js", root)
  );
  return { german: flattenMessages(catalogs.de), english: flattenMessages(catalogs.en) };
}

/** Flattened German and English catalogs of `kind` ("web" or "server"). */
export function loadCatalogs(kind) {
  if (kind === "web") return webCatalogs();
  if (kind === "server") return serverCatalogs();
  throw new Error(`Unknown catalog kind: ${kind}`);
}

export async function readLock(kind) {
  try {
    return JSON.parse(await readFile(new URL(lockPaths[kind], root), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

/** Rewrites the lock of `kind` from the current catalogs; returns the changed keys. */
export async function confirmLock(kind) {
  const { german, english } = await loadCatalogs(kind);
  const changed = findStale(german, english, await readLock(kind));
  await writeFile(
    new URL(lockPaths[kind], root),
    serializeLock(createLock(german, english)),
  );
  return changed;
}
