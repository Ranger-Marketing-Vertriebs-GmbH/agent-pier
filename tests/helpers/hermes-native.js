import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { childTransport } from "../../server/features/assistants/runtimes/hermes/hermes-rpc-client.js";
import { createHermesClient } from "../../server/features/assistants/runtimes/hermes/hermes-connection.js";
import { guardProcess } from "./process-guard.js";

// The native Hermes contracts (tests/integration/hermes-*-contract.test.js) run the
// real TUI gateway, `python -m tui_gateway.entry`, of the Hermes checkout or install
// AGENTPIER_HERMES_CONTRACT_RUNTIME names: a directory with bin/python that can
// `import tui_gateway` (a uv venv of hermes-agent). Each start gets a private HOME,
// HERMES_HOME, TMPDIR and work directory in one disposable folder, an environment
// without the caller's variables, and a config.yaml pointing at the in-repo fake
// model (hermes-fake-model.js); the real ~/.hermes is never read or written.

export const hermesRuntime = process.env.AGENTPIER_HERMES_CONTRACT_RUNTIME || "";
export const hermesSkip = !hermesRuntime && "set AGENTPIER_HERMES_CONTRACT_RUNTIME";

/** A disposable folder for one contract: home, Hermes home, temp and work dirs. */
export function hermesSandbox(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "hermes-contract-")),
  );
  const dirs = {
    root,
    home: path.join(root, "home"),
    hermesHome: path.join(root, "home", ".hermes"),
    tmp: path.join(root, "tmp"),
    work: path.join(root, "work"),
  };
  for (const dir of [dirs.hermesHome, dirs.tmp, dirs.work])
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Every process started here stops before the folder goes, also after a failure:
  // a gateway still shutting down would write into it again.
  dirs.stops = [];
  t.after(async () => {
    await Promise.allSettled(dirs.stops.map((stop) => stop()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return dirs;
}

/** The minimal config.yaml: the fake model, manual approvals, no onboarding prompt. */
export function writeHermesConfig({ hermesHome, work }, { baseUrl }) {
  const config = [
    "model:",
    "  provider: custom",
    "  default: fake-1",
    `  base_url: ${baseUrl}`,
    "  api_key: contract-key",
    "  api_mode: chat_completions",
    "terminal:",
    "  backend: local",
    `  cwd: ${work}`,
    "approvals:",
    "  mode: manual",
    "compression:",
    "  enabled: false",
    "onboarding:",
    '  profile_build: "off"',
    "",
  ].join("\n");
  fs.writeFileSync(path.join(hermesHome, "config.yaml"), config, { mode: 0o600 });
}

const env = ({ home, hermesHome, tmp }) => ({
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  HOME: home,
  HERMES_HOME: hermesHome,
  TMPDIR: tmp,
  SHELL: "/bin/sh",
  LANG: "en_US.UTF-8",
  PYTHONUNBUFFERED: "1",
});

/**
 * Spawns one TUI gateway in `dirs`, leading its own process group, and connects a
 * client to it; resolves `{ child, client, stop() }` once the gateway is ready.
 * stop() closes the client and signals the whole group: Hermes starts helpers of its
 * own (a `python3 -m pip --version` probe was seen) that outlive a SIGTERM of the
 * gateway alone. SIGTERM first, SIGKILL after `graceMs`, and SIGKILL once more for
 * anything left in the group; t.after stops it whatever happens.
 */
export async function startHermes(
  t,
  dirs,
  { agentId = "hermes-agent", graceMs = 5000 } = {},
) {
  const child = spawn(
    path.join(hermesRuntime, "bin", "python"),
    ["-m", "tui_gateway.entry"],
    {
      cwd: dirs.work,
      env: env(dirs),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    },
  );
  // Killed with its group also when the test process exits early.
  guardProcess(t, child, { group: true, graceMs });
  const stderr = fs.createWriteStream(path.join(dirs.root, "stderr.log"), { flags: "a" });
  child.stderr.pipe(stderr);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const group = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      /* The group is gone already. */
    }
  };
  const client = createHermesClient(childTransport(child), { agentId, timeoutMs: 60000 });
  let stopping;
  const stop = () =>
    (stopping ??= (async () => {
      client.close();
      group("SIGTERM");
      const timer = setTimeout(() => group("SIGKILL"), graceMs);
      await exited;
      clearTimeout(timer);
      group("SIGKILL");
      stderr.end();
    })());
  dirs.stops.push(stop);
  t.after(stop);
  await client.connect({ timeoutMs: 180000 });
  return { child, client, stop };
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
