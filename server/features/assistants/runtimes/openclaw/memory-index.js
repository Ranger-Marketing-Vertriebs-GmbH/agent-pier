import fs from "node:fs";
import { spawn as spawnProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { writePrivate, writePrivateText } from "../../../../lib/storage.js";
import { runtimeEnvironment } from "./runtime-config.js";
import { stateOwned } from "./offline-commands.js";
import { indexEveryAgent } from "./openclaw-config/semantic-memory.js";

/*
 * The offline rebuild of every agent's memory index: `openclaw memory index --force`
 * (the pinned runtime's docs/cli/memory.md). OpenClaw pauses an agent's memory
 * search, keyword hits included, once the embedding provider in openclaw.json
 * differs from the one its index was built with, and rebuilds only through this
 * command, which refuses beside a running Gateway. AgentPier therefore runs it while
 * its Gateway is stopped, against the openclaw.json the next start uses.
 *
 * One call covers every agent of the configuration; each prints "Memory index
 * updated (<id>): …" when done, or "Memory index failed (<id>): …" and the command
 * exits 1. An interrupted or failed rebuild never replaces an agent's published
 * index. Nothing of its output is kept: it names workspace paths.
 *
 * A rebuild for local embeddings is then checked (`openclaw memory status --deep
 * --json`): where no index held vectors yet, OpenClaw indexes by keyword alone when
 * the local provider cannot start (a model file it cannot load, a missing system
 * library) and still reports success. Every agent must report a valid index of the
 * local provider and a working embedding probe.
 */
const failure = (code) => Object.assign(Error(code), { code });
const updated = /^Memory index updated \(([^)]+)\)/;

/** The agents `config` holds an index for: every entry AgentPier manages memory of. */
export const indexedAgents = (config) =>
  Object.entries(config?.agents?.entries || {})
    .filter(
      ([, entry]) => entry?.memory?.search && typeof entry.memory.search === "object",
    )
    .map(([id]) => id);

/**
 * Rebuilds every agent's memory index for the configuration at `paths.config`.
 * `runtime` is the installed runtime (`nodePath`, `entryPath`). `onProgress({ done,
 * total })` hears each finished agent. `signal` stops the command (SIGTERM).
 * `semantic`: the file compiles local embeddings, so the result is checked. Rejects
 * with code MEMORY_INDEX_FAILED (the command failed), MEMORY_INDEX_UNVERIFIED (an
 * agent's index does not hold working local embeddings), MEMORY_INDEX_TIMEOUT (no
 * agent finished for `idleMs`) or MEMORY_INDEX_STOPPED (`signal`).
 */
export async function rebuildMemoryIndex({
  runtime,
  paths,
  onProgress = () => {},
  signal,
  semantic = false,
  spawn = spawnProcess,
  idleMs = 30 * 60000,
  ownershipWaitMs = [250, 500, 1000, 2000, 4000],
}) {
  const original = fs.readFileSync(paths.config, "utf8");
  const config = JSON.parse(original);
  const total = indexedAgents(config).length;
  // Agents whose memory is off are indexed too (indexEveryAgent); the start that
  // follows compiles the file again, and a crash before that leaves a file the next
  // start replaces as well.
  writePrivate(paths.config, indexEveryAgent(config));
  const options = { runtime, paths, signal, spawn, idleMs };
  const index = { args: ["memory", "index", "--force"], total, onProgress };
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await run({ ...options, ...index });
        if (semantic) await verify(options);
        return result;
      } catch (error) {
        // The stopped Gateway's state lock is still being released.
        if (!error.stateOwned || attempt >= ownershipWaitMs.length) throw error;
        await delay(ownershipWaitMs[attempt]);
      }
    }
  } finally {
    // Nothing else writes the file while the Gateway is stopped and its start waits.
    writePrivateText(paths.config, original);
  }
}

/** Whether one agent of `memory status --deep --json` searches by local embeddings. */
const embeds = (agent) =>
  agent?.embeddingProbe?.ok === true &&
  agent.status?.provider === "local" &&
  agent.status.custom?.indexIdentity?.status === "valid";

async function verify(options) {
  const { output } = await run({
    ...options,
    args: ["memory", "status", "--deep", "--json"],
  });
  let agents = null;
  try {
    agents = JSON.parse(output.slice(output.indexOf("[")));
  } catch {
    // No report to read counts as unverified.
  }
  if (!Array.isArray(agents) || !agents.length || !agents.every(embeds))
    throw failure("MEMORY_INDEX_UNVERIFIED");
}

// One offline `openclaw` command; resolves `{ agents, output }` (the agents an
// index rebuild finished and the command's standard output, read only here).
function run({
  runtime,
  paths,
  args,
  total = 0,
  onProgress = () => {},
  signal,
  spawn,
  idleMs,
}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(failure("MEMORY_INDEX_STOPPED"));
    const child = spawn(runtime.nodePath, [runtime.entryPath, ...args], {
      cwd: paths.root,
      env: runtimeEnvironment(paths, runtime.nodePath),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let done = 0,
      stderr = "",
      output = "",
      pending = "",
      outcome = null,
      timer;
    const stop = (code) => {
      outcome ||= code;
      child.kill("SIGTERM");
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => stop("MEMORY_INDEX_TIMEOUT"), idleMs);
    };
    const aborted = () => stop("MEMORY_INDEX_STOPPED");
    signal?.addEventListener("abort", aborted, { once: true });
    arm();
    onProgress({ done, total });
    child.stdout.on("data", (chunk) => {
      output = (output + chunk).slice(-4 * 1024 * 1024);
      const lines = (pending + chunk).split("\n");
      pending = lines.pop();
      for (const line of lines)
        if (updated.test(line)) {
          arm();
          onProgress({ done: ++done, total: Math.max(total, done) });
        }
    });
    // Only the last part is read, for the ownership refusal; never kept or logged.
    child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-4096)));
    child.once("error", () => {
      outcome ||= "MEMORY_INDEX_FAILED";
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      if (!outcome && code === 0) return resolve({ agents: done, output });
      const error = failure(outcome || "MEMORY_INDEX_FAILED");
      if (!outcome && stateOwned(stderr)) error.stateOwned = true;
      reject(error);
    });
  });
}
