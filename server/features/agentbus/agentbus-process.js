import { execFile } from "node:child_process";
import { realpathSync, readlinkSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { pidStart } from "../../../vendor/agentbus/core/proc.js";

const exec = promisify(execFile);
const validPid = (value) => Number.isSafeInteger(value) && value > 1;

function reject() {
  const error = new Error("AgentBus runtime process could not be verified");
  error.code = "AGENTBUS_PROCESS_UNVERIFIED";
  throw error;
}

async function processTable() {
  const { stdout } = await exec("/bin/ps", ["-A", "-o", "pid=,ppid=,comm="], {
    encoding: "utf8",
    timeout: 3000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  const result = new Map();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (match)
      result.set(Number(match[1]), {
        pid: Number(match[1]),
        parent: Number(match[2]),
        command: match[3],
      });
  }
  return result;
}

function chainToPane(table, claimedPid, panePid) {
  const chain = [];
  const seen = new Set();
  let pid = claimedPid;
  while (chain.length < 128 && validPid(pid) && !seen.has(pid)) {
    seen.add(pid);
    const entry = table.get(pid);
    if (!entry) reject();
    chain.push(entry);
    if (pid === panePid) return chain;
    pid = entry.parent;
  }
  reject();
}

function runtimePid(chain, launch, claimedPid) {
  const names = new Set([launch.tool, path.basename(launch.command)]);
  try {
    names.add(path.basename(realpathSync(launch.command)));
  } catch {
    // A removed installation does not relax matching to an arbitrary interpreter.
  }
  // Hook claims identify the hook process. Its interpreter is never a runtime.
  // OpenCode executes the plugin in the native runtime itself.
  // Linux comm is a mutable thread title (Node may report MainThread). Verify
  // the executable link instead; re-check it with the second ancestry snapshot.
  const candidates = chain.filter(
    (entry) =>
      (launch.tool === "opencode" || entry.pid !== claimedPid) &&
      names.has(
        path.basename(
          process.platform === "linux"
            ? readlinkSync(`/proc/${entry.pid}/exe`)
            : entry.command,
        ),
      ),
  );
  if (candidates.length !== 1) reject();
  if (launch.tool === "opencode" && candidates[0].pid !== claimedPid) reject();
  return candidates[0].pid;
}

/** Authenticate a client PID claim against the host-owned tmux pane and launch. */
export async function resolveAgentBusProcess({ session, launch, claimedPid, sessions }) {
  try {
    if (
      !validPid(claimedPid) ||
      session?.status !== "running" ||
      !session.id ||
      launch?.id !== session.id ||
      !["codex", "claude", "opencode"].includes(launch.tool) ||
      (session.tool && session.tool !== launch.tool) ||
      typeof launch.command !== "string" ||
      !launch.command
    )
      reject();
    const pane = async () => {
      const value = await sessions.tmux([
        "display-message",
        "-p",
        "-t",
        `${sessions.target(session.id)}:0.0`,
        "#{pane_pid}",
      ]);
      const pid = Number(String(value).trim());
      if (!validPid(pid)) reject();
      return pid;
    };
    const panePid = await pane();
    const chain = chainToPane(await processTable(), claimedPid, panePid);
    const pid = runtimePid(chain, launch, claimedPid);
    const start = pidStart(pid);
    if (!start || (await pane()) !== panePid || session.status !== "running") reject();
    const checked = chainToPane(await processTable(), claimedPid, panePid);
    if (
      JSON.stringify(checked.map(({ pid, parent }) => [pid, parent])) !==
        JSON.stringify(chain.map(({ pid, parent }) => [pid, parent])) ||
      runtimePid(checked, launch, claimedPid) !== pid ||
      pidStart(pid) !== start
    )
      reject();
    return { pid, pidStart: start };
  } catch {
    reject();
  }
}
