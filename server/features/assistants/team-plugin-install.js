import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { privateFolder } from "./runtime-paths.js";
import { runtimeManifest } from "./runtime-manifest.js";
const source = fileURLToPath(new URL("./team-plugin/", import.meta.url));
const files = [
  "index.js",
  "workflow-tools.js",
  "ssh-tool.js",
  "ssh-access-tool.js",
  "share-tool.js",
  "goal-tool.js",
  "coding-session-tool.js",
  "mail-tool.js",
  "project-tool.js",
  "member-tools.js",
  "chat-title.js",
  "tool-guard.js",
  "dreams-guard.js",
  "file-urls.js",
  "secrets-guard.js",
  "patch-paths.js",
  "exec-processes.js",
  "background-commands.js",
  "managed-folder.js",
  "openclaw.plugin.json",
  "package.json",
  // AgentPier's built-in skills (built-in-skills.js); the manifest's "skills" names
  // their folder.
  "skills/agentpier-shopping/SKILL.md",
];
// The shipped files and their digest, read afresh each time like every start does.
function shippedPlugin() {
  const contents = files.map((name) => fs.readFileSync(path.join(source, name)));
  const integrity = createHash("sha256").update(Buffer.concat(contents)).digest("hex");
  return { contents, integrity };
}
/**
 * The folder this AgentPier version provisions its team plugin to, below the runtime
 * root; it names the shipped files' digest, so another version uses another folder.
 */
export const teamPluginDirectory = (root, integrity = shippedPlugin().integrity) =>
  path.join(root, "plugins", `teams-${integrity.slice(0, 16)}`);
export function provisionTeamPlugin({ paths, runtimeVersion }) {
  // The shipped runtime and its declared rollback targets; nothing else is assumed.
  if (
    ![runtimeManifest.version, ...runtimeManifest.rollbackTargets].includes(
      runtimeVersion,
    )
  )
    throw Error("Incompatible assistant team runtime.");
  const { contents, integrity } = shippedPlugin();
  privateFolder(path.join(paths.root, "plugins"));
  const directory = privateFolder(teamPluginDirectory(paths.root, integrity));
  for (let n = 0; n < files.length; n++) {
    const file = path.join(directory, files[n]);
    // A nested asset's folders are private too, and never a symlink (privateFolder).
    const nested = path.dirname(files[n]);
    if (nested !== ".")
      nested
        .split("/")
        .reduce((folder, part) => privateFolder(path.join(folder, part)), directory);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw Error("Unsafe team plugin asset.");
      if (fs.readFileSync(file).equals(contents[n])) continue;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const temporary = path.join(directory, `.${randomUUID()}`);
    try {
      fs.writeFileSync(temporary, contents[n], { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  return { directory, version: "1.0.0", integrity };
}
