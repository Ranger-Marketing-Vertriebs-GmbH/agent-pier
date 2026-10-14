import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { download as fetchDownload } from "../operations/releases.js";
import { acquireInstallLock } from "../assistants/runtime-install-lock.js";
import { proxyEnvironment } from "../../lib/proxy-environment.js";
import { writePrivate } from "../../lib/storage.js";
import { packageError, packageProblem } from "./package-errors.js";
import { toolchainManifest, toolchainTarget } from "./toolchain-manifest.js";
import { privateFolder, regularFile, sha256Matches } from "./verified-files.js";
import { relocateSysconfig } from "./cpython-relocation.js";

const executeFile = promisify(execFile);
const downloadFile = (url) => fetchDownload(url, fetch, 256 * 1024 * 1024);
const kinds = ["node", "python"];
const npmCli = path.join("lib", "node_modules", "npm", "bin", "npm-cli.js");
const pythonPath = path.join("cpython", "bin", "python3");
const jobs = new Map();
const queues = new Map();
const unavailable = () => packageProblem("MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE", 503);

/** `<dataDir>/toolchains`, without creating it. */
export const toolchainRoot = (dataDir) => path.join(dataDir, "toolchains");
export function toolchainPaths(dataDir) {
  return { root: privateFolder(toolchainRoot(dataDir)) };
}
export const nodeDirectory = (dataDir, target, m = toolchainManifest) =>
  path.join(toolchainRoot(dataDir), `node-v${m.node.version}-${target}`);
export const pythonDirectory = (dataDir, target, m = toolchainManifest) =>
  path.join(
    toolchainRoot(dataDir),
    `python-${m.python.version}+${m.python.build}-uv${m.uv.version}-${target}`,
  );
const directoryOf = (kind, dataDir, target, m) =>
  kind === "node"
    ? nodeDirectory(dataDir, target, m)
    : pythonDirectory(dataDir, target, m);

async function fetchVerified(url, expected, download) {
  let bytes;
  try {
    bytes = await download(url);
  } catch {
    throw packageProblem("MCP_PACKAGE_DOWNLOAD_FAILED", 502);
  }
  if (!sha256Matches(bytes, expected))
    throw packageProblem("MCP_PACKAGE_DOWNLOAD_FAILED", 502);
  return bytes;
}
async function extract(bytes, into, execute, env) {
  const archive = `${into}.tar.gz`;
  fs.writeFileSync(archive, bytes, { mode: 0o600 });
  try {
    privateFolder(into);
    await execute("tar", ["-xzf", archive, "-C", into, "--strip-components=1"], {
      env,
      timeout: 120000,
      maxBuffer: 65536,
    });
  } finally {
    fs.rmSync(archive, { force: true });
  }
}
/** Only proxy settings are inherited; HOME, TMPDIR and caches stay in the stage. */
function isolated(stage, environment) {
  for (const name of ["home", "tmp", "cache"]) privateFolder(path.join(stage, name));
  return {
    ...proxyEnvironment(environment),
    HOME: path.join(stage, "home"),
    TMPDIR: path.join(stage, "tmp"),
    PATH: `/usr/bin${path.delimiter}/bin`,
    UV_NO_CONFIG: "1",
    UV_CACHE_DIR: path.join(stage, "cache"),
    UV_PYTHON_DOWNLOADS: "manual",
    PYTHONDONTWRITEBYTECODE: "1",
  };
}

async function installNode({ stage, target, m, download, execute, env }) {
  const checksum = m.node.checksums[target];
  const bytes = await fetchVerified(m.node.url(target), checksum, download);
  const content = path.join(stage, "node");
  await extract(bytes, content, execute, env);
  const node = regularFile(path.join(content, "bin", "node"));
  regularFile(path.join(content, npmCli));
  const npm = JSON.parse(
    fs.readFileSync(path.join(content, "lib/node_modules/npm/package.json"), "utf8"),
  );
  if (npm.version !== m.node.npmVersion) throw unavailable();
  const { stdout } = await execute(node, ["--version"], { env, timeout: 30000 });
  if (stdout.trim() !== `v${m.node.version}`) throw unavailable();
  return { content, receipt: { version: m.node.version, checksum } };
}

async function installPython({ stage, final, target, m, download, execute, env }) {
  const uvBytes = await fetchVerified(m.uv.url(target), m.uv.checksums[target], download);
  const content = privateFolder(path.join(stage, "python"));
  await extract(uvBytes, path.join(content, "uv"), execute, env);
  const uv = regularFile(path.join(content, "uv", "uv"));
  const version = await execute(uv, ["--version"], { env, timeout: 30000 });
  if (!version.stdout.startsWith(`uv ${m.uv.version}`)) throw unavailable();
  const archive = await fetchVerified(
    m.python.url(target),
    m.python.checksums[target],
    download,
  );
  // The relocatable archive is unpacked as is; only sysconfig learns the final path.
  const cpython = path.join(content, "cpython");
  await extract(archive, cpython, execute, env);
  relocateSysconfig(cpython, path.join(final, "cpython"), m.python.version);
  const python = containedPython(content, fs.realpathSync(content), pythonPath, m);
  const reported = await execute(python, ["--version"], { env, timeout: 30000 });
  if (reported.stdout.trim() !== `Python ${m.python.version}`) throw unavailable();
  return {
    content,
    receipt: {
      uvChecksum: m.uv.checksums[target],
      pythonChecksum: m.python.checksums[target],
      uvVersion: m.uv.version,
      pythonVersion: m.python.version,
      pythonPath,
    },
  };
}

/** A directory reached without any link: its real path is the expected one. */
function realDirectory(directory, expected) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || fs.realpathSync(directory) !== expected) throw unavailable();
  return expected;
}
/** `relative` inside `directory`, a regular file reached without any link. */
function containedFile(directory, real, relative) {
  const file = path.join(directory, relative);
  regularFile(file);
  if (fs.realpathSync(file) !== path.join(real, relative)) throw unavailable();
  return file;
}
/** CPython's `bin/python3` links to `bin/python3.x`, a regular file with one name. */
function containedPython(directory, real, relative, m) {
  const minor = m.python.version.split(".").slice(0, 2).join(".");
  const file = path.join(directory, relative);
  const program = path.join(real, "cpython", "bin", `python${minor}`);
  if (fs.realpathSync(file) !== program) throw unavailable();
  regularFile(path.join(directory, "cpython", "bin", `python${minor}`));
  return file;
}
function readReceipt(file) {
  regularFile(file);
  const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt))
    throw unavailable();
  return receipt;
}
function verified(kind, directory, target, m) {
  const root = path.dirname(directory);
  const real = path.join(
    realDirectory(root, fs.realpathSync(root)),
    path.basename(directory),
  );
  realDirectory(directory, real);
  const receipt = readReceipt(path.join(directory, "receipt.json"));
  if (receipt.kind !== kind || receipt.target !== target) throw unavailable();
  if (kind === "node") {
    if (
      receipt.version !== m.node.version ||
      receipt.checksum !== m.node.checksums[target]
    )
      throw unavailable();
    return {
      kind: "node",
      version: m.node.version,
      directory,
      nodePath: containedFile(directory, real, path.join("bin", "node")),
      npmCliPath: containedFile(directory, real, npmCli),
    };
  }
  if (
    receipt.uvChecksum !== m.uv.checksums[target] ||
    receipt.pythonChecksum !== m.python.checksums[target] ||
    receipt.uvVersion !== m.uv.version ||
    receipt.pythonVersion !== m.python.version ||
    receipt.pythonPath !== pythonPath
  )
    throw unavailable();
  return {
    kind: "python",
    directory,
    uvPath: containedFile(directory, real, path.join("uv", "uv")),
    uvVersion: m.uv.version,
    pythonVersion: m.python.version,
    pythonPath: containedPython(directory, real, pythonPath, m),
  };
}

/**
 * The installed toolchain from its verified receipt; null when none is installed.
 * Anything present but not exactly as installed is MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE.
 */
export function readToolchain(
  kind,
  { dataDir, platform, arch, glibc, manifest: m = toolchainManifest } = {},
) {
  if (!kinds.includes(kind)) throw unavailable();
  const target = toolchainTarget({ platform, arch, glibc });
  const directory = directoryOf(kind, dataDir, target, m);
  try {
    fs.lstatSync(directory);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw unavailable();
  }
  try {
    return verified(kind, directory, target, m);
  } catch {
    throw unavailable();
  }
}

/** The shared pid/start-time lock (`<root>/.install.lock`), never waited for. */
function lock(root) {
  try {
    return acquireInstallLock({ runtimes: root });
  } catch (error) {
    if (error?.code === "RUNTIME_BUSY")
      throw packageProblem("MCP_PACKAGE_BUSY", 409, "toolchainBusy");
    throw unavailable();
  }
}
/** Under the lock: clears abandoned stages, installs into a new one, moves it in. */
async function staged(kind, root, target, options) {
  const {
    dataDir,
    download = downloadFile,
    execute = executeFile,
    manifest: m,
    environment = process.env,
  } = options;
  let stage;
  try {
    // Under the lock no other installer is staging: every stage is abandoned.
    for (const name of fs.readdirSync(root))
      if (name.startsWith(".stage-"))
        fs.rmSync(path.join(root, name), { recursive: true, force: true });
    stage = privateFolder(path.join(root, `.stage-${randomUUID()}`));
    const work = kind === "node" ? installNode : installPython;
    const env = isolated(stage, environment);
    const { content, receipt } = await work({
      stage,
      final: path.resolve(directoryOf(kind, dataDir, target, m)),
      target,
      m,
      download,
      execute,
      env,
    });
    writePrivate(path.join(content, "receipt.json"), { kind, target, ...receipt });
    fs.renameSync(content, directoryOf(kind, dataDir, target, m));
  } catch (error) {
    throw packageError(error, "MCP_PACKAGE_INSTALL_FAILED", 502);
  } finally {
    try {
      if (stage) fs.rmSync(stage, { recursive: true, force: true });
    } catch {
      /* The next install clears it. */
    }
  }
}
async function install(kind, options) {
  const target = toolchainTarget(options);
  const existing = readToolchain(kind, options);
  if (existing) return existing;
  const { root } = toolchainPaths(options.dataDir);
  const release = lock(root);
  try {
    const current = readToolchain(kind, options);
    if (current) return current;
    await staged(kind, root, target, options);
    return readToolchain(kind, options);
  } finally {
    release();
  }
}

/** Runs installs for one data directory one after another inside this process. */
function serialized(root, operation) {
  const next = (queues.get(root) ?? Promise.resolve()).then(operation);
  const tail = next.catch(() => {});
  queues.set(root, tail);
  tail.then(() => queues.get(root) === tail && queues.delete(root));
  return next;
}

/**
 * Installs the pinned toolchain once; concurrent callers of one kind share one job,
 * and installs of both kinds in this process wait for each other instead of
 * failing with MCP_PACKAGE_BUSY. Another process installing still reports BUSY.
 * An installed toolchain is returned at once, without queueing.
 */
export function ensureToolchain(kind, options) {
  if (!kinds.includes(kind)) return Promise.reject(unavailable());
  let root;
  try {
    root = path.resolve(toolchainRoot(options.dataDir));
  } catch {
    return Promise.reject(unavailable());
  }
  const settings = { ...options, manifest: options.manifest ?? toolchainManifest };
  try {
    // A ready toolchain never waits behind an install of the other kind.
    const ready = readToolchain(kind, settings);
    if (ready) return Promise.resolve(ready);
  } catch {
    /* Fails the same way, with its code, on the queued path. */
  }
  const key = `${root}:${kind}`;
  if (jobs.has(key)) return jobs.get(key);
  // Whatever fails without a package code (storage, file system) never shows a path.
  const job = serialized(root, () => install(kind, settings))
    .catch((error) => {
      throw packageError(error, "MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE", 503);
    })
    .finally(() => jobs.delete(key));
  jobs.set(key, job);
  return job;
}

/** The toolchain folder name `entry` lies in, or null when it lies elsewhere. */
function toolchainName(root, entry) {
  if (typeof entry !== "string" || !entry) return null;
  const relative = path.relative(root, path.resolve(entry));
  const name = relative.split(path.sep)[0];
  return !name || name === ".." || path.isAbsolute(relative) ? null : name;
}
/**
 * Removes this target's node-* and python-* toolchains that are neither the current
 * pins nor in `inUse` (toolchain directories, or paths inside them). Any entry that
 * cannot be resolved disables pruning; a held install lock skips it. Returns the
 * removed folder names.
 */
export async function pruneToolchains(
  dataDir,
  inUse = [],
  { platform, arch, glibc, manifest: m = toolchainManifest } = {},
) {
  try {
    return await prune(dataDir, inUse, toolchainTarget({ platform, arch, glibc }), m);
  } catch (error) {
    throw packageError(error, "MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE", 503);
  }
}
async function prune(dataDir, inUse, target, m) {
  const root = toolchainRoot(dataDir);
  if (!fs.existsSync(root)) return [];
  let release;
  try {
    release = acquireInstallLock({ runtimes: root });
  } catch (error) {
    if (error.code === "RUNTIME_BUSY") return [];
    throw error;
  }
  try {
    const keep = new Set(
      kinds.map((kind) => path.basename(directoryOf(kind, dataDir, target, m))),
    );
    for (const entry of inUse ?? []) {
      const name = toolchainName(root, entry);
      if (!name) return [];
      keep.add(name);
    }
    const removed = [];
    for (const name of fs.readdirSync(root)) {
      const ours = /^(node|python)-/.test(name) && name.endsWith(`-${target}`);
      if (!ours || keep.has(name)) continue;
      await fsp.rm(path.join(root, name), { recursive: true, force: true });
      removed.push(name);
    }
    return removed;
  } finally {
    release();
  }
}
