const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const launcher = new RegExp(
  `terminal-launcher\\.js'?\\s+'?.*?sessions/(${uuid})\\.launch\\.json'?`,
  "i",
);
const columns = /^\s*(\d+)\s+(\d+)\s+(.*)$/;
// What the owner sees of an orphaned process: the release's node and its first
// argument (a script, or a flag such as -e), never the rest: arguments may hold
// tokens. The last `<release>/bin/node` is the executable; an earlier one is the
// comm column, which macOS truncates (an install root may contain spaces).
const shown = (command, prefixes) => {
  let start = -1,
    end = -1;
  for (const prefix of prefixes) {
    const node = `${prefix}bin/node`;
    for (let at = command.indexOf(node); at !== -1; at = command.indexOf(node, at + 1)) {
      const after = at + node.length;
      if (after === command.length || /\s/.test(command[after]))
        if (at > start) [start, end] = [at, after];
    }
  }
  if (start === -1) return "";
  const next = /^\s+(\S+)/.exec(command.slice(end));
  return (command.slice(start, end) + (next ? ` ${next[1]}` : "")).slice(0, 300);
};
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Classify every process that references one of the release directories.
 * Lines are `<pid> <ppid> <comm> <command…>`; a process is session-owned when it
 * descends from a session's terminal launcher, whatever it runs. A process that only
 * runs the release's node, with no AgentPier script, and whose parent is gone (it
 * was reparented to launchd or init) is orphaned: typically a test fixture left
 * behind. It never pins the release; the owner may stop it (`orphaned`).
 */
export function releaseSessionReferences(output, releasePaths) {
  const result = {
    sessionIds: [],
    helpers: 0,
    helperReferences: [],
    nodeOnly: 0,
    unidentified: [],
    orphaned: [],
  };
  if (!releasePaths.length) return result;
  const prefixes = releasePaths.map((value) => value.replace(/\/+$/, "") + "/");
  const pattern = new RegExp(`(?:${prefixes.map(escape).join("|")})([^\\s'"\\\\]*)`, "g");
  const parents = new Map();
  const launchers = new Set();
  const candidates = [];
  const commands = new Map();
  for (const line of output.split("\n")) {
    const match = columns.exec(line);
    const pid = match ? match[1] : null;
    const command = match ? match[3] : line;
    if (match) {
      parents.set(pid, match[2]);
      commands.set(pid, command);
    }
    const references = [...command.matchAll(pattern)].map((item) => item[1]);
    if (!references.length) continue;
    const session = launcher.exec(command);
    if (session && references.includes("server/terminal-launcher.js")) {
      const id = session[1].toLowerCase();
      if (!result.sessionIds.includes(id)) result.sessionIds.push(id);
      if (pid !== null) launchers.add(pid);
      continue;
    }
    candidates.push({ pid, references, command });
  }
  const descendsFromLauncher = (pid) => {
    const seen = new Set();
    for (let cursor = pid; cursor !== null && !seen.has(cursor);) {
      seen.add(cursor);
      const parent = parents.get(cursor);
      if (parent === undefined) return false;
      if (launchers.has(parent)) return true;
      cursor = parent;
    }
    return false;
  };
  // Reparented to launchd/init, or to a Linux user manager acting as subreaper.
  const orphan = (pid) => {
    const parent = parents.get(pid);
    return parent === "1" || /(^|\/)systemd(\s|$)/.test(commands.get(parent) || "");
  };
  for (const { pid, references, command } of candidates) {
    const rest = references.filter((reference) => reference !== "bin/node");
    if (pid !== null && descendsFromLauncher(pid)) {
      result.helpers += 1;
      result.helperReferences.push({ reference: rest[0] || "bin/node" });
    } else if (!rest.length && pid !== null && orphan(pid))
      result.orphaned.push({ pid: Number(pid), command: shown(command, prefixes) });
    else if (!rest.length) result.nodeOnly += 1;
    else result.unidentified.push({ reference: rest[0] });
  }
  return result;
}
