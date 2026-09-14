const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const launcher = new RegExp(
  `terminal-launcher\\.js'?\\s+'?.*?sessions/(${uuid})\\.launch\\.json'?`,
  "i",
);
const columns = /^\s*(\d+)\s+(\d+)\s+(.*)$/;
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Classify every process that references one of the release directories.
 * Lines are `<pid> <ppid> <comm> <command…>`; a process is session-owned when it
 * descends from a session's terminal launcher, whatever it runs.
 */
export function releaseSessionReferences(output, releasePaths) {
  const result = {
    sessionIds: [],
    helpers: 0,
    helperReferences: [],
    nodeOnly: 0,
    unidentified: [],
  };
  if (!releasePaths.length) return result;
  const prefixes = releasePaths.map((value) => value.replace(/\/+$/, "") + "/");
  const pattern = new RegExp(`(?:${prefixes.map(escape).join("|")})([^\\s'"\\\\]*)`, "g");
  const parents = new Map();
  const launchers = new Set();
  const candidates = [];
  for (const line of output.split("\n")) {
    const match = columns.exec(line);
    const pid = match ? match[1] : null;
    const command = match ? match[3] : line;
    if (match) parents.set(pid, match[2]);
    const references = [...command.matchAll(pattern)].map((item) => item[1]);
    if (!references.length) continue;
    const session = launcher.exec(command);
    if (session && references.includes("server/terminal-launcher.js")) {
      const id = session[1].toLowerCase();
      if (!result.sessionIds.includes(id)) result.sessionIds.push(id);
      if (pid !== null) launchers.add(pid);
      continue;
    }
    candidates.push({ pid, references });
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
  for (const { pid, references } of candidates) {
    const rest = references.filter((reference) => reference !== "bin/node");
    if (pid !== null && descendsFromLauncher(pid)) {
      result.helpers += 1;
      result.helperReferences.push({ reference: rest[0] || "bin/node" });
    } else if (!rest.length) result.nodeOnly += 1;
    else result.unidentified.push({ reference: rest[0] });
  }
  return result;
}
