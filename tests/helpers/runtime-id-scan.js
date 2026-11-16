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

/** { file: count } of the runtime id literals each file holds. */
export function runtimeIdLiterals(sources) {
  const found = {};
  for (const { file, text } of sources) {
    const count = text.match(idLiteral)?.length ?? 0;
    if (count) found[file] = count;
  }
  return found;
}

/** The files named after a runtime (`hermes-*`, `openclaw-*`), sorted. */
export const runtimeNamedFiles = (sources) =>
  sources
    .map(({ file }) => file)
    .filter((file) => /^(?:hermes|openclaw)-/.test(path.posix.basename(file)))
    .sort();
