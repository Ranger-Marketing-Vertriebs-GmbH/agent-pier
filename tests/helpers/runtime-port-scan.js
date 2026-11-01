import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// Scanners behind tests/unit/runtime-port-rules.test.js (ADR 0006): server code outside
// server/features/assistants/runtimes/ reaches a runtime only through the port.

export const root = path.resolve(import.meta.dirname, "../..");
export const portDirectory = "server/features/assistants/runtimes/";

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

/** Every server source outside the port as { file: "server/…", text }. */
export async function serverSources() {
  const files = (await walk(path.join(root, "server"))).filter((file) =>
    /\.m?js$/.test(file),
  );
  const sources = await Promise.all(
    files.sort().map(async (file) => ({
      file: path.relative(root, file).split(path.sep).join("/"),
      text: withoutCommentLines(await readFile(file, "utf8")),
    })),
  );
  return sources.filter(({ file }) => !file.startsWith(portDirectory));
}

// `.call("sessions.list", …)` or `.request("chat.history", …)`, also across a line break.
const gatewayMethod =
  /\.(?:call|request)\(\s*["'`]([a-z][a-zA-Z]*(?:\.[a-zA-Z]+)+)["'`]/g;
// `runtime.client`, `runtime?.client`, `this.assistants.runtime.client`,
// `assistantRuntime.client`; never `runtime.clientFactory`.
const clientAccess = /[rR]untime\??\.client\b/g;

/** { file: [method, …] } for the Gateway methods each file names, sorted. */
export function gatewayMethods(sources) {
  const found = {};
  for (const { file, text } of sources) {
    const methods = [...new Set([...text.matchAll(gatewayMethod)].map((m) => m[1]))];
    if (methods.length) found[file] = methods.sort();
  }
  return found;
}

/** { file: count } for the files that reach the runtime's client. */
export function clientAccesses(sources) {
  const found = {};
  for (const { file, text } of sources) {
    const count = text.match(clientAccess)?.length ?? 0;
    if (count) found[file] = count;
  }
  return found;
}
