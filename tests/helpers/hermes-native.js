import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { desiredAgent } from "../../server/features/assistants/agent-desired-state.js";
import { createHermesRuntime } from "../../server/features/assistants/runtimes/hermes/hermes-runtime.js";
import { hermesExecutables } from "../../server/features/assistants/runtimes/hermes/hermes-paths.js";
import { guardProcess } from "./process-guard.js";

// The native Hermes contracts (tests/integration/*hermes*-contract.test.js) run the
// installation AGENTPIER_HERMES_CONTRACT_RUNTIME names (made by
// scripts/provision-hermes-contracts.mjs from the pinned manifest) the way AgentPier
// runs it: the Hermes runtime (hermes-runtime.js) compiles the agent's home, and its
// supervisor runs the messaging gateway and the RPC bridge (hermes-supervisor.js)
// inside one disposable data directory: private HOME, HERMES_HOME, TMPDIR and work
// directory, an environment built from nothing, and the in-repo fake model
// (hermes-fake-model.js) as the agent's model connection. The real ~/.hermes is never
// read or written.

export const hermesRuntime = process.env.AGENTPIER_HERMES_CONTRACT_RUNTIME || "";
export const hermesSkip = !hermesRuntime && "set AGENTPIER_HERMES_CONTRACT_RUNTIME";

/** The install record of the contract installation, as hermes-install.js writes it. */
export function contractRecord(directory = hermesRuntime) {
  const { python, hermes } = hermesExecutables(directory);
  return { version: "contract", directory, pythonPath: python, hermesPath: hermes };
}

/** A disposable data directory for one contract (`root`); `stops` run before it goes. */
export function hermesSandbox(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "hermes-contract-")),
  );
  const dirs = { root, stops: [] };
  // Every process started here stops before the folder goes, also after a failure:
  // a gateway still shutting down would write into it again.
  t.after(async () => {
    await Promise.allSettled(dirs.stops.map((stop) => stop()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return dirs;
}

/**
 * The agent AgentPier would run, as its desired state reads it: shell on approval
 * (Hermes asks before dangerous commands), memory, and the fake model at `baseUrl` as
 * its model connection, with its key; `provider` adds fields of another endpoint
 * kind (assistant-provider-endpoint.js), such as a key in an `api-key` header.
 * `extra`: more fields of its stored record (`shell`, skills); `inputs`: what
 * desiredAgent takes besides (its MCP server ids).
 */
export function contractAgent(
  agentId,
  { baseUrl, provider = {} },
  extra = {},
  inputs = {},
) {
  const profile = {
    id: agentId,
    name: `Agent ${agentId}`,
    runtimeAgentId: agentId,
    revision: 1,
    capabilities: { memory: true },
    ...extra,
    // An extra `shell` left undefined keeps the default.
    shell: extra.shell ?? "approval",
  };
  return desiredAgent(profile, {
    ...inputs,
    instructions: `# ${agentId}\n\nYou help the owner.\n`,
    model: {
      ref: "ap-contract/fake-1",
      providerId: "ap-contract",
      provider: {
        baseUrl,
        api: "openai-completions",
        apiKey: "contract-key",
        models: [
          { id: "fake-1", name: "Fake 1", contextWindow: 128000, maxTokens: 4096 },
        ],
        ...provider,
      },
    },
  });
}

/**
 * Starts the agent `agentId` in `dirs` through the Hermes runtime with `model` (the
 * fake model) and its shell level `shell` (default approval) and resolves `{ supervisor, runtime, sessions, events, approvals,
 * agent, stop() }` once its host is ready. Its home starts with compression off, so
 * no turn calls the model a second time; the compiled home is merged over it. The
 * process groups are guarded, so they end also when the test process exits early.
 */
export async function startHermes(
  t,
  dirs,
  { agentId = "hermes-agent", model, strict = false, shell } = {},
) {
  const { supervisor, runtime } = createHermesRuntime({
    dataDir: dirs.root,
    agentId,
    runtime: async () => contractRecord(),
    desired: () => contractAgent(agentId, model, { shell }),
    // Every-command approval (the guard plugin) when `strict`.
    strict,
    readyTimeoutMs: 180000,
    callTimeoutMs: 60000,
  });
  const agent = supervisor.agentPaths();
  const config = path.join(agent.hermesHome, "config.yaml");
  if (!fs.existsSync(config))
    fs.writeFileSync(config, "compression:\n  enabled: false\n", { mode: 0o600 });
  const stop = () => runtime.host.stop();
  dirs.stops.push(stop);
  t.after(stop);
  const guard = () => {
    for (const pid of supervisor.pids())
      guardProcess(t, pid, { group: true, graceMs: 5000 });
  };
  supervisor.on("status", ({ availability }) => availability === "ready" && guard());
  await runtime.host.start();
  guard();
  const { sessions, events, approvals } = runtime;
  return { supervisor, runtime, sessions, events, approvals, agent, stop };
}

/**
 * Processes still running from `dirs`, as `{ pid, command }`: any whose command line
 * names the sandbox, and any holding a file in it open (lsof), such as a gateway
 * Hermes detached on its own (parent pid 1), whose command line names neither.
 */
export function strayHermesProcesses(dirs) {
  return processesIn(dirs);
}

/** strayHermesProcesses after giving killed processes up to `waitMs` to go. */
export async function strayAfterStop(dirs, waitMs = 3000) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const left = processesIn(dirs);
    if (!left.length || Date.now() > deadline) return left;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function processesIn(dirs) {
  const listing = execFileSync("ps", ["-Ao", "pid=,command="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map(([, pid, command]) => ({ pid: Number(pid), command }));
  let holders = [];
  try {
    holders = execFileSync("lsof", ["-t", "+D", dirs.root], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .map(Number)
      .filter(Number.isSafeInteger);
  } catch (error) {
    // lsof exits 1 when no process holds a file there.
    holders = String(error?.stdout || "")
      .split("\n")
      .map(Number)
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  }
  return listing.filter(
    ({ pid, command }) =>
      pid !== process.pid &&
      (holders.includes(pid) ||
        (command.includes(dirs.root) && !command.includes("lsof"))),
  );
}

/**
 * The run events of `events` (the Hermes events sub-port), with `until(predicate,
 * timeoutMs)` resolving the first event, seen or still to come, that matches.
 */
export function collectEvents(events) {
  const seen = [];
  const waiters = new Set();
  const unsubscribe = events.subscribe((event) => {
    seen.push(event);
    for (const waiter of [...waiters])
      if (waiter.match(event)) {
        waiters.delete(waiter);
        waiter.resolve(event);
      }
  });
  const until = (match, timeoutMs = 120000) => {
    const hit = seen.find(match);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const waiter = {
        match,
        resolve: (event) => {
          clearTimeout(timer);
          resolve(event);
        },
      };
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error("timed out waiting for a Hermes event"));
      }, timeoutMs);
      waiters.add(waiter);
    });
  };
  return { seen, until, unsubscribe };
}

/** Whether `event` ends run `runId`. */
export const endsRun = (runId) => (event) =>
  event.runId === runId && ["finished", "aborted", "failed"].includes(event.kind);
