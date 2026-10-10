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
  "tool-guard.js",
  "openclaw.plugin.json",
  "package.json",
];
export function provisionTeamPlugin({ paths, runtimeVersion }) {
  // The shipped runtime and its declared rollback targets; nothing else is assumed.
  if (
    ![runtimeManifest.version, ...runtimeManifest.rollbackTargets].includes(
      runtimeVersion,
    )
  )
    throw Error("Incompatible assistant team runtime.");
  const contents = files.map((name) => fs.readFileSync(path.join(source, name)));
  const integrity = createHash("sha256").update(Buffer.concat(contents)).digest("hex");
  const directory = privateFolder(
    path.join(
      privateFolder(path.join(paths.root, "plugins")),
      `teams-${integrity.slice(0, 16)}`,
    ),
  );
  for (let n = 0; n < files.length; n++) {
    const file = path.join(directory, files[n]);
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
