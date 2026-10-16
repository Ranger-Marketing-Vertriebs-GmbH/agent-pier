import { splitCommandLine } from "./command-mapper.js";
import { mapEntry } from "./paste-entry.js";
import { parseRelaxedJson, PasteJsonError } from "./paste-json.js";

// Reads a guide's setup block in this browser: no network, no eval, deterministic.
export const pasteLimit = 64 * 1024;
export const serverLimit = 20;
const blocks = ["mcpServers", "servers", "mcp", "context_servers"];
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isEntry = (value) =>
  isRecord(value) &&
  (value.command !== undefined ||
    typeof value.url === "string" ||
    typeof value.serverUrl === "string");
// A pasted line is read only when it starts a package runner (decision Q10).
const runnerLine = /^(?:npx|bunx|uvx|(?:pnpm|yarn)\s+dlx|uv\s+tool\s+run|pipx\s+run)\s/;
const failure = (code, extra = {}) => ({ ok: false, error: { code, ...extra } });

function readJson(text) {
  try {
    return parseRelaxedJson(text);
  } catch (error) {
    const trimmed = text.trim();
    if (!(error instanceof PasteJsonError) || /^[{[]/.test(trimmed)) throw error;
    // A fragment such as "mcpServers": {…} or "opnsense": {…}, (outer braces missing).
    try {
      return parseRelaxedJson(`{${trimmed.replace(/,\s*$/, "")}}`);
    } catch {
      throw error;
    }
  }
}

function entriesOf(root) {
  if (!isRecord(root)) return [];
  for (const block of blocks)
    if (isRecord(root[block])) {
      const list = Object.entries(root[block]).filter(([, value]) => isRecord(value));
      if (list.length) return list;
    }
  if (isEntry(root)) return [["", root]];
  return Object.entries(root).filter(([, value]) => isEntry(value));
}

function inputsOf(root) {
  if (!isRecord(root) || !Array.isArray(root.inputs)) return {};
  const inputs = Object.create(null);
  for (const input of root.inputs)
    if (isRecord(input) && typeof input.id === "string")
      inputs[input.id] = {
        description: typeof input.description === "string" ? input.description : "",
        password: input.password === true,
      };
  return inputs;
}

function finish(entries, { duplicates = [], taken, inputs = {} }) {
  const used = [...taken];
  const servers = entries.slice(0, serverLimit).map(([key, entry], index) => {
    let n = 0;
    const server = mapEntry(key, entry, {
      taken: used,
      inputs,
      nextKey: () => `paste-${index}-${++n}`,
    });
    if (server.name) used.push(server.name);
    return server;
  });
  return {
    ok: true,
    servers,
    warnings: [
      ...(entries.length > serverLimit ? [{ code: "tooManyServers" }] : []),
      ...duplicates.map((name) => ({
        code: "duplicateKey",
        name: String(name).slice(0, 60),
      })),
    ],
  };
}

/** The servers in a pasted block, or why none could be read. */
export function parsePaste(text, { taken = [] } = {}) {
  if (typeof text !== "string") return failure("noServer");
  if (text.length > pasteLimit) return failure("tooLong");
  const trimmed = text.trim();
  if (!trimmed) return failure("noServer");
  // Codex TOML and `claude mcp add` are a follow-up (decision Q10).
  if (/^\s*\[\[?mcp_servers/m.test(trimmed) || /^claude\s+mcp\s+add\b/.test(trimmed))
    return failure("notJson");
  if (!/^[{["]/.test(trimmed)) {
    const words = runnerLine.test(trimmed) ? splitCommandLine(trimmed) : null;
    if (!words?.length) return failure("notJson");
    return finish([["", { command: words[0], args: words.slice(1) }]], { taken });
  }
  let parsed;
  try {
    parsed = readJson(text);
  } catch (error) {
    if (error instanceof PasteJsonError)
      return failure(
        error.code,
        error.code === "invalidJson" ? { line: error.line, column: error.column } : {},
      );
    throw error;
  }
  const entries = entriesOf(parsed.value);
  if (!entries.length) return failure("noServer");
  return finish(entries, {
    duplicates: parsed.duplicates,
    taken,
    inputs: inputsOf(parsed.value),
  });
}

/**
 * One server of a result with the block's warnings, and the names of the other
 * servers still waiting (`done` lists the ones already set up).
 */
export function pickServer(result, index = 0, done = []) {
  const server = result.servers[index];
  return {
    ...server,
    warnings: [...result.warnings, ...server.warnings],
    others: result.servers
      .filter((_, at) => at !== index && !done.includes(at))
      .map((item) => item.name || item.key),
  };
}
