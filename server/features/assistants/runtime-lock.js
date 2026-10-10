import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const runtimeLockDirectory = fileURLToPath(
  new URL("./runtime-lock/", import.meta.url),
);
export function dependencyLockDigest(packageBytes, lockBytes) {
  return createHash("sha256")
    .update(packageBytes)
    .update("\0")
    .update(lockBytes)
    .digest("hex");
}
export function readRuntimeLock(manifest, directory = runtimeLockDirectory) {
  const read = (name) => {
    const file = path.join(directory, name),
      stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024)
      throw Error("Unsafe assistant dependency lock file.");
    return fs.readFileSync(file);
  };
  const packageBytes = read("package.json"),
    lockBytes = read("package-lock.json");
  const digest = dependencyLockDigest(packageBytes, lockBytes);
  if (digest !== manifest.dependencyLockSha256)
    throw Error("Assistant dependency lock integrity mismatch.");
  const pkg = JSON.parse(packageBytes),
    lock = JSON.parse(lockBytes);
  const root = lock.packages?.[""],
    upstream = lock.packages?.["node_modules/openclaw"];
  if (
    pkg.name !== "agentpier-managed-assistants" ||
    pkg.private !== true ||
    JSON.stringify(pkg.dependencies) !==
      JSON.stringify({ openclaw: "file:openclaw.tgz" }) ||
    lock.lockfileVersion !== 3 ||
    (root?.name && root.name !== pkg.name) ||
    JSON.stringify(root?.dependencies) !== JSON.stringify(pkg.dependencies) ||
    upstream?.version !== manifest.version ||
    upstream?.resolved !== "file:openclaw.tgz" ||
    upstream?.integrity !== `sha512-${manifest.packageIntegrity}`
  )
    throw Error("Invalid assistant dependency lock metadata.");
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (!name) continue;
    if (
      !name.startsWith("node_modules/") ||
      name.includes("\\") ||
      name.split("/").some((part) => ["", ".", ".."].includes(part)) ||
      entry.link ||
      typeof entry.version !== "string"
    )
      throw Error("Invalid assistant dependency lock package.");
    if (entry.inBundle) {
      let ancestor = name;
      do {
        const boundary = ancestor.lastIndexOf("/node_modules/");
        ancestor = boundary < 0 ? "" : ancestor.slice(0, boundary);
      } while (ancestor && lock.packages[ancestor]?.inBundle);
      if (!ancestor || !lock.packages[ancestor]?.integrity)
        throw Error("Unverified bundled assistant dependency.");
      continue;
    }
    if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity || ""))
      throw Error("Missing assistant dependency integrity.");
    if (name === "node_modules/openclaw") continue;
    const url = new URL(entry.resolved);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "registry.npmjs.org" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    )
      throw Error("Untrusted assistant dependency source.");
  }
  return { packageBytes, lockBytes, digest };
}
