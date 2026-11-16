import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { processTrees } from "../system-status/process-stats.js";
import { processIdentity } from "../../lib/process-identity.js";
import { inside } from "./deletion-paths.js";

const exec = promisify(execFile);
const LSOF_ARGS = ["-w", "-n", "-P", "-F0pcufn"];
const NAMED_ESCAPES = { 8: "\\b", 9: "\\t", 10: "\\n", 12: "\\f", 13: "\\r" };

/*
 * Processes whose working directory or open files lie inside a project folder that is
 * about to be deleted. Folders are real paths; lsof and /proc report real paths too.
 */

const hexBytes = (text) =>
  [...Buffer.from(text, "utf8")]
    .map((byte) => `\\x${byte.toString(16).padStart(2, "0")}`)
    .join("");

/**
 * lsof prints a backslash as "\\", common controls as "\n" etc., other controls as
 * "^X", and bytes it cannot print as "\xNN"; non-ASCII text stays as is in a UTF-8
 * locale and turns into "\xNN" bytes in the C locale. Escaping is a function, its
 * inverse is not ("^A" may be literal), so the folder is escaped to match the output.
 */
function lsofForms(folder) {
  const escape = (asBytes) => {
    let out = "";
    for (const ch of folder) {
      const code = ch.codePointAt(0);
      if (ch === "\\") out += "\\\\";
      else if (NAMED_ESCAPES[code]) out += NAMED_ESCAPES[code];
      else if (code < 0x20) out += `^${String.fromCharCode(code + 64)}`;
      else if (code >= 0x7f && (asBytes || code < 0xa0)) out += hexBytes(ch);
      else out += ch;
    }
    return out;
  };
  return [...new Set([escape(false), escape(true)])];
}

/** Parses `lsof -F0pcufn`: NUL-terminated fields, each field set ended by "\n". */
export function parseLsof(stdout, folders) {
  const forms = folders.flatMap(lsofForms);
  const found = new Map();
  let current = null,
    fd = "";
  for (const raw of String(stdout).split("\0")) {
    const field = raw.replace(/^\n/, "");
    const tag = field[0],
      value = field.slice(1);
    if (tag === "p") {
      current = { pid: Number(value), name: "", uid: null, uses: null };
      fd = "";
    } else if (!current) continue;
    else if (tag === "c") current.name = value;
    else if (tag === "u") current.uid = /^\d+$/.test(value) ? Number(value) : null;
    else if (tag === "f") fd = value;
    else if (tag === "n" && forms.some((form) => inside(form, value))) {
      current.uses = fd === "cwd" || current.uses === "cwd" ? "cwd" : "files";
      if (Number.isSafeInteger(current.pid) && current.pid > 0)
        found.set(current.pid, current);
    }
  }
  return found;
}

const defaultProc = {
  readdir: (dir) => fs.readdir(dir),
  readlink: (link) => fs.readlink(link),
  stat: (target) => fs.stat(target),
  readFile: (file, encoding) => fs.readFile(file, encoding),
};

/** Linux without lsof: cwd and fd links of every process this user may read. */
async function procScan(folders, readProc, signal) {
  const matches = (target) => folders.some((folder) => inside(folder, target));
  const found = new Map();
  for (const entry of await readProc.readdir("/proc")) {
    if (signal.aborted) break;
    if (!/^\d+$/.test(entry)) continue;
    const base = `/proc/${entry}`;
    let uses = null;
    try {
      if (matches(await readProc.readlink(`${base}/cwd`))) uses = "cwd";
    } catch {
      // Another user's process, or one that ended meanwhile.
    }
    if (!uses) {
      try {
        for (const fd of await readProc.readdir(`${base}/fd`)) {
          if (signal.aborted) break;
          try {
            if (matches(await readProc.readlink(`${base}/fd/${fd}`))) {
              uses = "files";
              break;
            }
          } catch {
            // The descriptor closed meanwhile.
          }
        }
      } catch {
        // Unreadable descriptors: another user's process, or it ended.
      }
    }
    if (!uses) continue;
    const pid = Number(entry);
    let uid = null,
      name = "";
    try {
      uid = (await readProc.stat(base)).uid;
    } catch {
      // Ended meanwhile; listed without an owner, so never endable.
    }
    try {
      name = (await readProc.readFile(`${base}/comm`, "utf8")).trim();
    } catch {
      // Ended meanwhile.
    }
    found.set(pid, { pid, name, uid, uses });
  }
  return found;
}

async function lsofScan(folders, { platform, run, readProc, signal }) {
  const file = platform === "darwin" ? "/usr/sbin/lsof" : "lsof";
  let stdout;
  try {
    ({ stdout } = await run(file, LSOF_ARGS, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      signal,
    }));
  } catch (error) {
    if (error?.code === "ENOENT" && platform === "linux")
      return procScan(folders, readProc, signal);
    // lsof exits 1 when one of many processes could not be read; its list still counts.
    // Anything else (a full buffer, a signal) may have cut the list short.
    if (signal.aborted || error?.code !== 1 || typeof error.stdout !== "string")
      throw error;
    if (!error.stdout) throw error;
    stdout = error.stdout;
  }
  return parseLsof(stdout, folders);
}

/** Every process using one of `folders` (real paths), bounded by `timeoutMs`. */
export async function scanFolderProcesses(
  folders,
  {
    timeoutMs = 10_000,
    platform = process.platform,
    run = exec,
    readProc = defaultProc,
  } = {},
) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ status: "timeout", processes: [] });
    }, timeoutMs);
  });
  const scan = lsofScan(folders, { platform, run, readProc, signal: controller.signal })
    .then((found) => ({ status: "ok", processes: [...found.values()] }))
    .catch(() => ({ status: "failed", processes: [] }));
  try {
    const result = await Promise.race([scan, deadline]);
    return controller.signal.aborted ? { status: "timeout", processes: [] } : result;
  } finally {
    clearTimeout(timer);
  }
}

function exists(pid, signal = process.kill) {
  try {
    signal(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function ancestors(table, pid) {
  const seen = new Set();
  let current = table?.get(pid);
  while (current && !seen.has(current.ppid) && current.ppid > 0) {
    seen.add(current.ppid);
    current = table.get(current.ppid);
  }
  return seen;
}

/**
 * Marks what AgentPier knows about each found process and whether it may be offered:
 * never its server and the server's ancestors, the tmux server, the Gateway or pid 1,
 * and never another user's process.
 */
export function classifyProcesses(
  found,
  {
    serverPid = process.pid,
    gatewayPid = null,
    tmuxPid = null,
    sessionPanes = [],
    table = new Map(),
    uid = process.getuid?.(),
    identity = processIdentity,
    alive = exists,
  } = {},
) {
  const isPid = (pid) => Number.isSafeInteger(pid) && pid > 0;
  // This process and its parent stay protected even without a process table.
  const guarded = new Set(
    [1, process.pid, process.ppid, serverPid, tmuxPid, gatewayPid].filter(isPid),
  );
  for (const pid of ancestors(table, serverPid)) guarded.add(pid);
  const trees = processTrees(table, [
    ["gateway", gatewayPid],
    ...sessionPanes.map((pane) => [`session:${pane.id}`, pane.pid]),
  ]);
  const knownOf = (pid) => {
    if (trees.get("gateway")?.has(pid)) return { kind: "agent-command" };
    for (const pane of sessionPanes)
      if (trees.get(`session:${pane.id}`)?.has(pid))
        return { kind: "session", sessionId: pane.id };
    return null;
  };
  const result = [];
  for (const { pid, name, uid: owner, uses } of found) {
    let startTime = null,
      executable = null;
    try {
      ({ startTime = null, executable = null } = identity(pid));
      startTime ||= null;
    } catch {
      if (!alive(pid)) continue; // Ended since the scan.
    }
    const isProtected = guarded.has(pid);
    const mine = owner != null && owner === uid;
    result.push({
      pid,
      startTime,
      executable,
      name,
      uses,
      owner: mine ? "self" : "other",
      known: isProtected ? null : knownOf(pid),
      endable: !isProtected && mine && startTime !== null,
      protected: isProtected,
    });
  }
  return result;
}

/** "sent", "gone" (ESRCH) or "denied" (EPERM: not ours to signal). */
function send(signal, pid, sig) {
  try {
    signal(pid, sig);
    return "sent";
  } catch (error) {
    if (error?.code === "ESRCH") return "gone";
    if (error?.code === "EPERM") return "denied";
    throw error;
  }
}

/**
 * SIGTERM, then SIGKILL after `graceMs`. Start time and executable are checked before
 * each signal, so a pid reused by another process is never signalled. "changed" means
 * the process could not be confirmed as the one found, or could not be signalled.
 */
export async function endProcess(
  { pid, startTime, executable = null },
  { graceMs = 5000, signal = process.kill, identity = processIdentity } = {},
) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || !startTime) return "changed";
  // "same", "other" (the pid now names another process), "gone", or "unknown".
  const check = () => {
    let now;
    try {
      now = identity(pid);
    } catch {
      return exists(pid, signal) ? "unknown" : "gone";
    }
    const same =
      now.startTime === startTime && (!executable || now.executable === executable);
    return same ? "same" : "other";
  };
  const before = check();
  if (before === "gone") return "gone";
  if (before !== "same") return "changed";
  const term = send(signal, pid, "SIGTERM");
  if (term !== "sent") return term === "gone" ? "gone" : "changed";
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(1, Math.min(100, deadline - Date.now()))),
    );
    if (!exists(pid, signal)) return "ended";
  }
  const after = check();
  if (after === "gone" || after === "other") return "ended";
  if (after !== "same") return "changed";
  const kill = send(signal, pid, "SIGKILL");
  return kill === "denied" ? "changed" : "ended";
}
