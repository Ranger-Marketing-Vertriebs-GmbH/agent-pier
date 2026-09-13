const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const launcher = new RegExp(
  `terminal-launcher\\.js'?\\s+'?.*?sessions/(${uuid})\\.launch\\.json'?`,
  "i",
);
// Scripts that run detached from any session. Everything else a session spawns from its
// release (server/… and vendor/… helpers, hooks, MCP servers) exits with the session.
const detachedScripts = [
  "server/features/pipelines/verify-supervisor.js",
  "server/features/pipelines/verify-executor.js",
  "server/features/operations/release-helper.js",
  "server/index.js",
  "server/terminal-launcher.js",
];
const owned = (reference) =>
  (reference.startsWith("server/") || reference.startsWith("vendor/")) &&
  !detachedScripts.includes(reference);
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Classify every process line that references one of the release directories. */
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
  for (const line of output.split("\n")) {
    const references = [...line.matchAll(pattern)].map((match) => match[1]);
    if (!references.length) continue;
    const session = launcher.exec(line);
    if (session && references.includes("server/terminal-launcher.js")) {
      const id = session[1].toLowerCase();
      if (!result.sessionIds.includes(id)) result.sessionIds.push(id);
      continue;
    }
    const rest = references.filter((reference) => reference !== "bin/node");
    if (!rest.length) {
      result.nodeOnly += 1;
      continue;
    }
    const detached = rest.find((reference) => detachedScripts.includes(reference));
    if (detached) {
      result.unidentified.push({ reference: detached });
      continue;
    }
    if (rest.every(owned)) {
      result.helpers += 1;
      result.helperReferences.push({ reference: rest[0] });
      continue;
    }
    result.unidentified.push({
      reference: rest.find((reference) => !owned(reference)),
    });
  }
  return result;
}
