const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const launcher = new RegExp(
  `terminal-launcher\\.js'?\\s+'?.*?sessions/(${uuid})\\.launch\\.json'?`,
  "i",
);
// Helpers a native CLI session spawns from its own release. They exit with the session.
const sessionHelpers = [
  "vendor/agentbus/",
  "server/native-session-binding.js",
  "server/native-session-opencode.js",
  "server/github-credentials.js",
  "server/git-credential.mjs",
  "server/ssh.mjs",
  "server/lib/",
];
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Classify every process line that references one of the release directories. */
export function releaseSessionReferences(output, releasePaths) {
  const prefixes = releasePaths.map((value) => value.replace(/\/+$/, "") + "/");
  const pattern = new RegExp(`(?:${prefixes.map(escape).join("|")})([^\\s'"\\\\]*)`, "g");
  const result = {
    sessionIds: [],
    helpers: 0,
    helperReferences: [],
    nodeOnly: 0,
    unidentified: [],
  };
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
    if (
      rest.every((reference) =>
        sessionHelpers.some((helper) => reference.startsWith(helper)),
      )
    ) {
      result.helpers += 1;
      result.helperReferences.push({ reference: rest[0] });
      continue;
    }
    result.unidentified.push({
      reference: rest.find(
        (reference) => !sessionHelpers.some((helper) => reference.startsWith(helper)),
      ),
    });
  }
  return result;
}
