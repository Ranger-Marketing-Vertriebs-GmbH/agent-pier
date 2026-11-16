import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// Scanners behind tests/unit/runtime-id-rules.test.js (ADR 0007): product code
// outside the runtime modules names no runtime.

export const root = path.resolve(import.meta.dirname, "../..");
/** Where a runtime's own code lives, on the server and in the web app. */
export const runtimeModuleDirectories = [
  "server/features/assistants/runtimes/",
  "web/features/assistants/runtimes/",
];
// Product copy names the runtimes; the catalogs are no code.
const catalogDirectories = ["server/lib/i18n/", "web/lib/i18n/"];

async function walk(directory, out = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(file, out);
    else out.push(file);
  }
  return out;
}

// Whole-line comments only: stripping block comments would also eat globs in strings.
const withoutCommentLines = (text) => text.replace(/^[ \t]*(?:\/\/|\/\*|\*).*$/gm, "");

/** Every server and web source outside the runtime modules and the catalogs. */
export async function productSources() {
  const files = [
    ...(await walk(path.join(root, "server"))),
    ...(await walk(path.join(root, "web"))),
  ].filter((file) => /\.(?:m?js|jsx)$/.test(file));
  const sources = await Promise.all(
    files.sort().map(async (file) => ({
      file: path.relative(root, file).split(path.sep).join("/"),
      text: withoutCommentLines(await readFile(file, "utf8")),
    })),
  );
  const skipped = [...runtimeModuleDirectories, ...catalogDirectories];
  return sources.filter(({ file }) => !skipped.some((prefix) => file.startsWith(prefix)));
}

// A string literal that is exactly a runtime id, in any quotes: `"hermes"`, never
// `"openclaw:"`, `"Hermes Agent"` or the name of a file.
const idLiteral = /(["'`])(?:hermes|openclaw)\1/g;

// An unquoted object key that is exactly a runtime id: `{ hermes: … }`, `openclaw: 1,`.
// Never part of a longer word, a member (`x.hermes`), a ternary's branch (`a ? hermes
// : b`, which Prettier writes with a space before the colon) or text inside a string,
// a pattern or a path (`"agent:x:hermes:cron"`, `"openclaw:"`, `/^openclaw:/`, `/hermes:`).
const idKey = /(?<![\w$.:/"'`^-])(?:hermes|openclaw):(?!:)/g;

/**
 * { file: count } of the runtime ids each file names: its string literals and its
 * unquoted object keys.
 */
export function runtimeIdLiterals(sources) {
  const found = {};
  for (const { file, text } of sources) {
    const count = (text.match(idLiteral)?.length ?? 0) + (text.match(idKey)?.length ?? 0);
    if (count) found[file] = count;
  }
  return found;
}

// An import (static or dynamic) of a module in a `runtimes/` folder.
const runtimeModuleImport = /(?:from|import\()\s*["'][^"']*\/runtimes\/[^"']*["']/;

/**
 * The web sources that import a web runtime module (`web/features/assistants/
 * runtimes/`), sorted. `sources` are productSources: outside the runtime modules.
 */
export const webRuntimeImporters = (sources) =>
  sources
    .filter(({ file, text }) => file.startsWith("web/") && runtimeModuleImport.test(text))
    .map(({ file }) => file)
    .sort();

/** The files named after a runtime (`hermes-*`, `openclaw-*`), sorted. */
export const runtimeNamedFiles = (sources) =>
  sources
    .map(({ file }) => file)
    .filter((file) => /^(?:hermes|openclaw)-/.test(path.posix.basename(file)))
    .sort();

// Code without its block comments, string and template literals and trailing
// comments (whole-line comments are gone from the sources already). A regular
// expression stays: a pattern that spells a runtime's name knows that runtime.
const codeOnly = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(["'])(?:\\.|(?!\1)[^\\\n])*\1/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, "``")
    .replace(/\/\/.*$/gm, "");

// An identifier with a runtime's name as a word part, in any position: an import, a
// call, a member, a key, a declaration (`hermesFleetOf`, `openClawFrameEvent`,
// `services.hermesRuntime`, `hermes.state()`, `stripOpenClawRows`).
const namedIdentifier = /[\w$]*(?:[Hh]ermes|[Oo]pen[Cc]law)[\w$]*/g;

/**
 * { file: [name, …] } of the identifiers each file spells with a runtime's name,
 * sorted. It reads code only: no comment, no string, no template literal (so not an
 * expression inside one either). A helper that hides a runtime behind a neutral name
 * is still invisible to it.
 */
export function runtimeNamedIdentifiers(sources) {
  const found = {};
  for (const { file, text } of sources) {
    const names = [...new Set(codeOnly(text).match(namedIdentifier) ?? [])];
    if (names.length) found[file] = names.sort();
  }
  return found;
}
