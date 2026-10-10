import { provisionTeamPlugin } from "./team-plugin-install.js";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { download as fetchDownload } from "../operations/releases.js";
import { readJSON, writePrivate } from "../../lib/storage.js";
import { readRuntimeLock } from "./runtime-lock.js";
import { runtimeManifest } from "./runtime-manifest.js";
import { runtimePaths, privateFolder } from "./runtime-paths.js";
import { acquireInstallLock, withInstallLock } from "./runtime-install-lock.js";
import { proxyEnvironment } from "./runtime-config.js";
import { readAssistantFeature } from "./assistant-feature.js";

const jobs = new Map();
const executeFile = promisify(execFile);
const downloadFile = (url) => fetchDownload(url, fetch, 256 * 1024 * 1024);
const identityKeys = [
  "version",
  "nodeVersion",
  "dependencyLockSha256",
  "nodePath",
  "entryPath",
];
/** True when two runtime descriptors name the same installed runtime. */
export function sameRuntime(a, b) {
  return !!a && !!b && identityKeys.every((key) => a[key] === b[key]);
}
// A candidate is recorded only when it differs from the selected runtime.
function recordCandidate(root, result) {
  const file = path.join(root, "candidate.json");
  if (sameRuntime(result, readJSON(path.join(root, "runtime.json"), null)))
    fs.rmSync(file, { force: true });
  else writePrivate(file, result);
}
export function stageAssistantRuntime(options) {
  const key = path.resolve(options.dataDir);
  if (jobs.has(key)) return jobs.get(key);
  const paths = runtimePaths(options.dataDir);
  // The candidate is recorded before the lock is released, so runtime retention
  // never sees a fresh installation as unreferenced.
  const job = Promise.resolve()
    .then(() =>
      withInstallLock(paths, async () => {
        const result = await install(options);
        recordCandidate(paths.root, result);
        return result;
      }),
    )
    .finally(() => jobs.delete(key));
  jobs.set(key, job);
  return job;
}
export async function ensureAssistantRuntime(options) {
  const result = await stageAssistantRuntime(options);
  const { root } = runtimePaths(options.dataDir);
  const file = path.join(root, "runtime.json");
  if (!fs.existsSync(file)) {
    const release = acquireInstallLock(runtimePaths(options.dataDir));
    try {
      if (!fs.existsSync(file)) {
        writePrivate(file, result);
        recordCandidate(root, result);
      }
    } finally {
      release();
    }
  }
  return result;
}
const lockMissing = () =>
  Object.assign(Error("Assistant runtime selection has no dependency lock."), {
    code: "RUNTIME_LOCK_MISSING",
  });
export async function selectedAssistantRuntime(options) {
  const paths = runtimePaths(options.dataDir);
  const file = path.join(paths.root, "runtime.json");
  const selected = readJSON(file, null);
  if (!selected) return ensureAssistantRuntime(options);
  for (const key of ["nodePath", "entryPath"])
    if (
      typeof selected[key] !== "string" ||
      !path.resolve(selected[key]).startsWith(paths.runtimes + path.sep)
    )
      throw Error("Unsafe assistant runtime selection.");
  const installed = path.join(
    paths.runtimes,
    path.relative(paths.runtimes, path.resolve(selected.nodePath)).split(path.sep)[0],
  );
  if (!fs.existsSync(installed) && !isLink(installed)) {
    // The selected installation was removed: reset the selection and reinstall.
    fs.rmSync(file);
    const result = await ensureAssistantRuntime(options);
    return { ...result, diagnostic: "RUNTIME_REINSTALLED" };
  }
  for (const key of ["nodePath", "entryPath"]) {
    for (
      let directory = path.dirname(path.resolve(selected[key]));
      directory !== paths.runtimes;
      directory = path.dirname(directory)
    ) {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw Error("Unsafe assistant runtime selection.");
    }
    regular(selected[key]);
  }
  // A legacy selection cannot prove its dependency graph; it is never started
  // silently. Staging and activating the qualified runtime replaces it.
  if (!selected.dependencyLockSha256) throw lockMissing();
  const directory = path.resolve(selected.entryPath, "../../../..");
  const receipt = path.join(directory, "receipt.json");
  regular(receipt);
  const saved = readJSON(receipt);
  if (saved.dependencyLockSha256 !== selected.dependencyLockSha256)
    throw Error("Assistant dependency lock integrity mismatch.");
  readRuntimeLock({ ...saved, version: selected.version }, path.join(directory, "app"));
  return {
    ...selected,
    teamPlugin: provisionTeamPlugin({ paths, runtimeVersion: selected.version }),
  };
}
export async function provisionEnabledRuntime(options) {
  if (!readAssistantFeature(options.dataDir).enabled) return null;
  return ensureAssistantRuntime(options);
}
function checksum(bytes, algorithm, encoding, expected) {
  if (createHash(algorithm).update(bytes).digest(encoding) !== expected)
    throw Error("Assistant runtime checksum mismatch.");
}
function isLink(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}
function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw Error("Unsafe assistant runtime file.");
}
async function install({
  dataDir,
  platform = process.platform,
  arch = process.arch,
  download = downloadFile,
  execute = executeFile,
  manifest = runtimeManifest,
  lockDirectory,
  environment = process.env,
}) {
  const target = `${platform}-${arch}`;
  if (!manifest.nodeChecksums[target])
    throw Error("Unsupported assistant runtime platform.");
  const lock = readRuntimeLock(manifest, lockDirectory);
  const paths = runtimePaths(dataDir);
  const identity = `${manifest.version}-node${manifest.nodeVersion}-${target}-lock${lock.digest.slice(0, 12)}`;
  const directory = path.join(paths.runtimes, identity);
  const result = {
    version: manifest.version,
    nodeVersion: manifest.nodeVersion,
    dependencyLockSha256: lock.digest,
    nodePath: path.join(directory, "node", "bin", "node"),
    entryPath: path.join(directory, "app", "node_modules", "openclaw", "openclaw.mjs"),
  };
  const receipt = path.join(directory, "receipt.json");
  if (fs.existsSync(receipt)) {
    privateFolder(directory);
    regular(receipt);
    const saved = readJSON(receipt);
    if (
      saved.dependencyLockSha256 !== lock.digest ||
      saved.packageIntegrity !== manifest.packageIntegrity ||
      saved.nodeChecksum !== manifest.nodeChecksums[target]
    )
      throw Error("Assistant runtime installation integrity changed.");
    readRuntimeLock(manifest, path.join(directory, "app"));
    regular(result.nodePath);
    regular(result.entryPath);
    result.teamPlugin = provisionTeamPlugin({ paths, runtimeVersion: manifest.version });
    return result;
  }
  const stage = privateFolder(path.join(paths.runtimes, `.stage-${randomUUID()}`));
  try {
    const base = `node-v${manifest.nodeVersion}-${target}`;
    const nodeBytes = await download(
      `https://nodejs.org/dist/v${manifest.nodeVersion}/${base}.tar.gz`,
    );
    checksum(nodeBytes, "sha256", "hex", manifest.nodeChecksums[target]);
    const packageBytes = await download(manifest.packageUrl);
    checksum(packageBytes, "sha512", "base64", manifest.packageIntegrity);
    const archive = path.join(stage, "node.tar.gz");
    fs.writeFileSync(archive, nodeBytes, { mode: 0o600 });
    const nodeDir = privateFolder(path.join(stage, "node"));
    await execute("tar", ["-xzf", archive, "-C", nodeDir, "--strip-components=1"], {
      timeout: 60000,
      maxBuffer: 32768,
    });
    const node = path.join(nodeDir, "bin", "node");
    regular(node);
    const app = privateFolder(path.join(stage, "app"));
    const tarball = path.join(app, "openclaw.tgz");
    fs.writeFileSync(tarball, packageBytes, { mode: 0o600 });
    fs.writeFileSync(path.join(app, "package.json"), lock.packageBytes, { mode: 0o600 });
    fs.writeFileSync(path.join(app, "package-lock.json"), lock.lockBytes, {
      mode: 0o600,
    });
    const npmRoot = path.join(nodeDir, "lib", "node_modules", "npm");
    if (readJSON(path.join(npmRoot, "package.json")).version !== manifest.npmVersion)
      throw Error("Assistant installer npm version mismatch.");
    for (const name of ["user.npmrc", "global.npmrc"])
      fs.writeFileSync(path.join(stage, name), "", { mode: 0o600 });
    // Proxy settings are the only inherited variables; npm reads them natively.
    const env = {
      ...proxyEnvironment(environment),
      HOME: paths.home,
      TMPDIR: paths.tmp,
      PATH: `${path.join(nodeDir, "bin")}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      npm_config_cache: path.join(paths.root, "npm-cache"),
      npm_config_userconfig: path.join(stage, "user.npmrc"),
      npm_config_globalconfig: path.join(stage, "global.npmrc"),
      npm_config_update_notifier: "false",
    };
    await execute(
      node,
      [
        path.join(npmRoot, "bin", "npm-cli.js"),
        "ci",
        "--include=optional",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--registry=https://registry.npmjs.org",
      ],
      { cwd: app, env, timeout: 600000, maxBuffer: 2 * 1024 * 1024 },
    );
    const entry = path.join(app, "node_modules", "openclaw", "openclaw.mjs");
    regular(entry);
    if (
      readJSON(path.join(app, "node_modules", "openclaw", "package.json")).version !==
      manifest.version
    )
      throw Error("Assistant runtime version mismatch.");
    await execute(node, [entry, "--version"], {
      cwd: app,
      env,
      timeout: 60000,
      maxBuffer: 32768,
    });
    fs.rmSync(archive);
    fs.rmSync(tarball);
    writePrivate(path.join(stage, "receipt.json"), {
      dependencyLockSha256: lock.digest,
      packageIntegrity: manifest.packageIntegrity,
      nodeChecksum: manifest.nodeChecksums[target],
    });
    fs.renameSync(stage, directory);
    // The verified installation no longer needs downloaded package tarballs.
    fs.rmSync(env.npm_config_cache, { recursive: true, force: true });
    result.teamPlugin = provisionTeamPlugin({ paths, runtimeVersion: manifest.version });
    return result;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
