import fs from "node:fs";
import path from "node:path";

export function privateFolder(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw Object.assign(Error("Unsafe assistant storage."), {
      code: "ASSISTANT_STORAGE_UNSAFE",
    });
  fs.chmodSync(directory, 0o700);
  return directory;
}
export function runtimePaths(dataDir) {
  const root = privateFolder(path.join(dataDir, "assistants"));
  const paths = { root };
  for (const name of ["home", "state", "workspaces", "logs", "runtimes", "tmp"])
    paths[name] = privateFolder(path.join(root, name));
  paths.config = path.join(paths.state, "openclaw.json");
  return paths;
}
