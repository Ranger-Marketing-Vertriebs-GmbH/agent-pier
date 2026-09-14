import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  releaseManifest,
  releaseVersion,
} from "../server/features/operations/release-archive.js";
import { requireDataCompatibility } from "../server/features/operations/release-schema.js";
import { readFile, readJson } from "../server/features/operations/files.js";
export const receiptName = ".setup.json";
export function canonicalPath(input) {
  if (!input || !path.isAbsolute(input))
    throw Error("Absolute setup paths are required.");
  const resolved = path.resolve(input);
  try {
    return fs.realpathSync(resolved);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return path.join(canonicalPath(path.dirname(resolved)), path.basename(resolved));
  }
}
function info(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
export function verifyRelease(installRoot, dataDir, version) {
  releaseVersion(version);
  const directory = path.join(installRoot, "releases", version);
  if (fs.realpathSync(directory) !== directory)
    throw Error("Release directory is not owned.");
  const manifest = releaseManifest(readJson(path.join(directory, "release.json")));
  if (manifest.version !== version) throw Error("Release version mismatch.");
  for (const file of [
    "release.json",
    "bin/node",
    "server/index.js",
    "package.json",
    "dist/index.html",
    "node_modules/node-pty/package.json",
  ]) {
    const target = path.join(directory, file);
    if (!fs.statSync(target).isFile() || fs.realpathSync(target) !== target)
      throw Error("Release file is not owned.");
  }
  requireDataCompatibility(manifest, dataDir);
  return version;
}
export function inspectSetup({ installRoot, dataDir }) {
  let receipt = null;
  try {
    installRoot = canonicalPath(installRoot);
    dataDir = canonicalPath(dataDir);
    if (installRoot === path.parse(installRoot).root)
      throw Error("Filesystem root cannot be an install root.");
    if (
      dataDir === installRoot ||
      dataDir.startsWith(`${installRoot}/`) ||
      installRoot.startsWith(`${dataDir}/`)
    )
      throw Error("Application and data paths must be separate.");
    if (info(installRoot) && !info(installRoot).isDirectory())
      throw Error("Install root is not a directory.");
    for (const directory of [installRoot, dataDir]) {
      const stat = info(directory);
      if (
        stat &&
        (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid()))
      )
        throw Error("Setup directory must be owned by the current user.");
    }
    const file = path.join(installRoot, receiptName);
    if (!info(file)) {
      if (info(installRoot) && fs.readdirSync(installRoot).length)
        throw Error(
          "Unknown nonempty installation; legacy installations cannot be adopted.",
        );
      if (
        info(dataDir) &&
        (!info(dataDir).isDirectory() || fs.readdirSync(dataDir).length)
      )
        throw Error("Unknown nonempty data directory; existing data cannot be adopted.");
      return { state: "fresh", receipt: null, activeVersion: null, installRoot, dataDir };
    }
    const stat = info(file);
    if (
      !stat.isFile() ||
      stat.mode & 0o077 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw Error("Receipt must be private and owned.");
    receipt = readJson(file);
    if (
      receipt.schema !== 1 ||
      receipt.installRoot !== installRoot ||
      receipt.dataDir !== dataDir ||
      !["prepared", "staged", "selected", "service", "healthy"].includes(receipt.phase)
    )
      throw Error("Incompatible setup receipt or changed paths.");
    releaseVersion(receipt.initialVersion);
    if (!/^[a-f0-9]{64}$/.test(receipt.target?.sha256))
      throw Error("Invalid recorded target checksum.");
    if (receipt.target.url) {
      const target = new URL(receipt.target.url);
      const official =
        "https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/releases/latest/download/";
      const base =
        receipt.initialChannel === official
          ? new URL(`../../download/v${receipt.initialVersion}/`, official).href
          : receipt.initialChannel;
      if (
        target.protocol !== "https:" ||
        target.username ||
        target.password ||
        !target.href.startsWith(base) ||
        !/^[A-Za-z0-9._-]+\.aprelease$/.test(target.href.slice(base.length))
      )
        throw Error("Invalid recorded target URL.");
    }
    const cache = info(path.join(installRoot, ".setup-target.aprelease"));
    if (cache && (!cache.isFile() || cache.nlink !== 1))
      throw Error("Setup archive must be an owned regular file.");
    for (const channel of [receipt.channel, receipt.initialChannel]) {
      if (typeof channel !== "string") throw Error("Invalid receipt channel.");
      const url = new URL(channel);
      if (url.protocol !== "https:" || url.username || url.password)
        throw Error("Invalid receipt channel.");
    }
    for (const entry of fs.readdirSync(installRoot)) {
      if (
        ![
          receiptName,
          ".setup.lock",
          ".setup-recovery.lock",
          ".setup-target.aprelease",
          "bin",
          "releases",
          "current",
        ].includes(entry) &&
        !/^\.staging-[a-f0-9-]+$/.test(entry) &&
        !/^\.setup-[a-f0-9-]+\.tmp$/.test(entry)
      )
        throw Error("Unknown installation files.");
      if (
        ["bin", "releases"].includes(entry) &&
        !info(path.join(installRoot, entry)).isDirectory()
      )
        throw Error("Installation directory must not be a link.");
    }
    const current = path.join(installRoot, "current");
    if (!info(current)) {
      const staged = path.join(installRoot, "releases", receipt.initialVersion);
      if (info(staged)) verifyRelease(installRoot, dataDir, receipt.initialVersion);
      else if (receipt.phase === "staged")
        throw Error("Recorded staged release is missing.");
    }
    let activeVersion = null;
    if (info(current)) {
      if (!info(current).isSymbolicLink())
        throw Error("Current release must be an owned pointer.");
      const target = fs.readlinkSync(current);
      if (!/^releases\/[^/]+$/.test(target))
        throw Error("Current release is outside its owned layout.");
      activeVersion = verifyRelease(installRoot, dataDir, target.slice(9));
      const launcher = path.join(installRoot, "bin/agentpier");
      if (!info(launcher)?.isFile()) throw Error("Missing or unowned launcher.");
      const quotedData = `'${dataDir.replaceAll("'", "'\\''")}'`;
      if (
        !readFile(launcher, 1024 * 1024)
          .toString("utf8")
          .includes(`AGENTPIER_DATA_DIR=${quotedData};`)
      )
        throw Error("Launcher data path does not match.");
    } else if (["selected", "service", "healthy"].includes(receipt.phase))
      throw Error("Selected release pointer is missing.");
    return {
      state: activeVersion ? "installed" : "incomplete",
      receipt,
      activeVersion,
      installRoot,
      dataDir,
    };
  } catch (error) {
    return { state: "conflict", receipt, activeVersion: null, reason: error.message };
  }
}
export function writeReceipt(root, receipt) {
  const file = path.join(root, `.setup-${randomUUID()}.tmp`);
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(receipt)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(file, path.join(root, receiptName));
  const directory = fs.openSync(root, "r");
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}
export function acquireSetupLock(root, inspected) {
  const file = path.join(root, ".setup.lock");
  // Every claimant uses the same exclusive guard, including claimants that observed
  // no lock. A stale-lock observer can never unlink a replacement owner's lock.
  const guard = path.join(root, ".setup-recovery.lock");
  let guardFd;
  try {
    guardFd = fs.openSync(guard, "wx", 0o600);
  } catch {
    throw Error("Setup lock recovery is in progress; inspect .setup-recovery.lock.");
  }
  try {
    if (info(file)) {
      const stat = info(file);
      if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077)
        throw Error("Setup lock conflict.");
      let lock;
      try {
        lock = readJson(file);
      } catch {
        throw Error("Setup lock conflict: invalid owner.");
      }
      if (
        !Number.isSafeInteger(lock.pid) ||
        lock.pid < 1 ||
        lock.installRoot !== root ||
        lock.dataDir !== inspected.dataDir
      )
        throw Error("Setup lock conflict: invalid owner.");
      let live = true;
      try {
        process.kill(lock.pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") live = false;
      }
      if (live) throw Error("Another setup is running (live setup lock).");
      const actual = inspectSetup({ installRoot: root, dataDir: inspected.dataDir });
      if (!inspected.receipt || actual.state === "conflict")
        throw Error("Dead setup lock requires matching ownership.");
      fs.unlinkSync(file);
    }
    let fd;
    try {
      fd = fs.openSync(file, "wx", 0o600);
    } catch {
      throw Error("Another setup is running (setup lock).");
    }
    fs.writeFileSync(
      fd,
      JSON.stringify({ pid: process.pid, installRoot: root, dataDir: inspected.dataDir }),
    );
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  } finally {
    fs.closeSync(guardFd);
    fs.unlinkSync(guard);
  }
  return () => fs.unlinkSync(file);
}
