import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { privateFolder, writePrivateText } from "../../../../lib/storage.js";
import { hermesError } from "./hermes-rpc-client.js";
import { boundPort } from "./hermes-connection.js";
import {
  entryDelimiter,
  memoryChars,
  memoryFolder,
  memoryLimits,
} from "./hermes-config/memory.js";

// The files of one Hermes agent the agentFiles sub-port serves, by the names
// AgentPier uses for OpenClaw's (agents.files.*): its memory (Hermes's MEMORY.md and
// USER.md, hermes-config/memory.js), its instructions (SOUL.md in HERMES_HOME, which
// Hermes loads as the agent's identity and AgentPier compiles from the desired state)
// and AGENTS.md in its work folder, which Hermes loads as project context
// (website/docs/user-guide/features/context-files.md). Hermes has no API for them:
// they are files of the agent's own home, read and written while its set runs.
const places = Object.freeze({
  "MEMORY.md": (agent) => [agent.hermesHome, memoryFolder, "MEMORY.md"],
  "USER.md": (agent) => [agent.hermesHome, memoryFolder, "USER.md"],
  "SOUL.md": (agent) => [agent.hermesHome, "SOUL.md"],
  "AGENTS.md": (agent) => [agent.workspace, "AGENTS.md"],
});
const memoryNames = Object.keys(memoryLimits);

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const refusal = (code, status, message, extra = {}) =>
  Object.assign(Error(message), { code, status, ...extra });

// The folder and file of `name`; a name Hermes has no file for is refused as
// OpenClaw refuses an unknown one.
function placeOf(agent, name) {
  const place = Object.hasOwn(places, name) ? places[name](agent) : null;
  if (!place)
    throw refusal("INVALID_REQUEST", 400, `Hermes agents have no file ${String(name)}.`);
  return { dir: path.join(...place.slice(0, -1)), file: path.join(...place) };
}

// A folder or file the agent replaced with a link, or with something else, is never
// read through: the owner's view shows only the agent's own files.
const unsafe = (name) => refusal("UNSAFE", 409, `The Hermes file ${name} is not a file.`);

function readFile({ dir, file }, name) {
  const folder = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!folder) return null;
  if (!folder.isDirectory()) throw unsafe(name);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile()) throw unsafe(name);
  return fs.readFileSync(file, "utf8");
}

const fileOf = (name, content) =>
  content === null
    ? { name, missing: true, content: "" }
    : { name, missing: false, content, hash: sha256(content) };

// Where `query` appears in a memory file: one result per entry naming its lines, the
// best matches (most query words) first.
function searchText(name, text, words) {
  const results = [];
  let offset = 0;
  for (const part of text.split(entryDelimiter)) {
    const start = offset;
    offset += part.length + entryDelimiter.length;
    const entry = part.trim();
    if (!entry) continue;
    const lower = entry.toLowerCase();
    const score = words.filter((word) => lower.includes(word)).length;
    if (!score) continue;
    const lead = part.length - part.trimStart().length;
    const startLine = text.slice(0, start + lead).split("\n").length;
    results.push({
      path: name,
      snippet: entry.slice(0, 700),
      startLine,
      endLine: startLine + entry.split("\n").length - 1,
      score,
    });
  }
  return results;
}

/**
 * The agentFiles sub-port (../agent-runtime.js) of one Hermes agent over its
 * supervisor (hermes-supervisor.js): get, set and searchMemory reject while the set
 * is not ready (UNAVAILABLE, 503) and views bound to a replaced connection reach
 * nothing, as OpenClaw's do. `get` answers `{ file: { name, content, hash, missing } }`
 * (`hash` the SHA-256 of the content); `set` writes atomically and owner-only, only
 * over the expected hash or absence (CONFLICT, 409, otherwise), and refuses a memory
 * file over Hermes's limit (TOO_LARGE, 413, with `limit` and `chars`): Hermes would
 * keep loading it but refuse every later memory write of the agent. An edit reaches
 * the agent's next session; Hermes freezes memory into a session's prompt at its
 * start. searchMemory finds entries of MEMORY.md and USER.md that hold the query's
 * words (Hermes's own search covers past sessions, not memory).
 */
export const hermesAgentFiles = (supervisor) =>
  boundPort((current) => filesOver(current, supervisor), supervisor);

function filesOver(current, supervisor) {
  const agent = () => {
    if (!current()?.ready) throw hermesError();
    return supervisor.agentPaths();
  };
  const get = async ({ name }) => {
    const place = placeOf(agent(), name);
    return { file: fileOf(name, readFile(place, name)) };
  };
  return {
    get,
    async set({ name, content, expectedHash, expectedMissing }) {
      const place = placeOf(agent(), name);
      const text = String(content ?? "");
      if (memoryNames.includes(name) && memoryChars(text) > memoryLimits[name])
        throw refusal("TOO_LARGE", 413, `${name} is over Hermes's memory limit.`, {
          limit: memoryLimits[name],
          chars: memoryChars(text),
        });
      // A link in the file's place matches no expectation; without one it is replaced.
      let now;
      try {
        now = readFile(place, name);
      } catch (error) {
        if (error.code !== "UNSAFE") throw error;
      }
      if (
        (expectedMissing === true && now !== null) ||
        (expectedHash !== undefined &&
          (typeof now !== "string" || sha256(now) !== expectedHash))
      )
        throw refusal("CONFLICT", 409, `${name} changed meanwhile.`);
      privateFolder(place.dir, () => unsafe(name));
      writePrivateText(place.file, text);
      return { ok: true, file: fileOf(name, text) };
    },
    async searchMemory({ query, maxResults = 10 }) {
      const words = [
        ...new Set(
          String(query ?? "")
            .toLowerCase()
            .split(/\s+/)
            .filter(Boolean),
        ),
      ];
      const results = [];
      for (const name of memoryNames) {
        const text = readFile(placeOf(agent(), name), name);
        if (text && words.length) results.push(...searchText(name, text, words));
      }
      results.sort((a, b) => b.score - a.score);
      return {
        ok: true,
        output: {
          details: {
            results: results.slice(0, maxResults).map(({ score: _score, ...r }) => r),
          },
        },
      };
    },
  };
}
