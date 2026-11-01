import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { download as fetchDownload } from "../../../operations/releases.js";
import { readJSON, writePrivate } from "../../../../lib/storage.js";
import { proxyEnvironment } from "../../../../lib/proxy-environment.js";
import { privateFolder } from "../../runtime-paths.js";
import { acquireInstallLock, withInstallLock } from "../../runtime-install-lock.js";
import { hermesManifest, uvArchiveUrl } from "./hermes-manifest.js";
import { hermesExecutables, hermesPaths } from "./hermes-paths.js";

const jobs = new Map();
const executeFile = promisify(execFile);
const downloadFile = (url) => fetchDownload(url, fetch, 512 * 1024 * 1024);
// Only stable codes: they reach the owner as codes, never as text.
const failure = (code) => Object.assign(Error(code), { code });

// The fields that name one installation; a record is opaque to AgentPier otherwise.
const identityKeys = [
  "version",
  "pythonVersion",
  "uvVersion",
  "uvLockSha256",
  "pythonPath",
];
/** True when two Hermes install records name the same installation. */
export const sameHermesRuntime = (a, b) =>
  !!a && !!b && identityKeys.every((key) => a[key] === b[key]);
// The extras of a manifest or record as one sorted key ("mcp+messaging").
const extrasKey = (value) => [...(value?.extras || [])].sort().join("+");

/**
 * True when a record is the commit, Python, uv, lock and extras `manifest` pins: an
 * installation built without an extra the pin added (`mcp`) is due for an update.
 */
export const shippedHermesRuntime = (record, manifest = hermesManifest) =>
  !!record &&
  record.version === manifest.version &&
  record.commit === manifest.commit &&
  record.pythonVersion === manifest.pythonVersion &&
  record.uvVersion === manifest.uvVersion &&
  record.uvLockSha256 === manifest.uvLockSha256 &&
  extrasKey(record) === extrasKey(manifest);

/** The folder name of the installation `manifest` pins on `target`, extras included. */
export const hermesIdentity = (manifest, target) =>
  `${manifest.version}-py${manifest.pythonVersion}-uv${manifest.uvVersion}-${target}` +
  `-lock${manifest.uvLockSha256.slice(0, 12)}-${extrasKey(manifest)}`;

function sha256(bytes, expected) {
  if (createHash("sha256").update(bytes).digest("hex") !== expected)
    throw failure("HERMES_CHECKSUM_MISMATCH");
}
function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw failure("HERMES_RUNTIME_UNSAFE");
}
/** Hermes's entry points are uv's venv links and scripts: present and executable. */
function executable(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || !(stat.mode & 0o100)) throw failure("HERMES_RUNTIME_UNSAFE");
}

function recordOf(manifest, directory) {
  const { python, hermes } = hermesExecutables(directory);
  return {
    version: manifest.version,
    commit: manifest.commit,
    releaseDate: manifest.releaseDate,
    pythonVersion: manifest.pythonVersion,
    uvVersion: manifest.uvVersion,
    uvLockSha256: manifest.uvLockSha256,
    extras: [...manifest.extras],
    directory,
    pythonPath: python,
    hermesPath: hermes,
  };
}

/**
 * The environment of every uv and Python call of an installation: proxy settings
 * are the only inherited variables. uv's cache, managed CPython and tool folders
 * stay inside AgentPier's folder; uv reads no user or system configuration and never
 * uses or links a Python of the host.
 */
export function hermesInstallEnvironment({ paths, directory, scratch, environment }) {
  return {
    ...proxyEnvironment(environment),
    HOME: scratch,
    TMPDIR: scratch,
    LANG: "C.UTF-8",
    PATH: `${path.join(directory, "uv")}${path.delimiter}/usr/bin${path.delimiter}/bin`,
    UV_NO_CONFIG: "1",
    UV_NO_PROGRESS: "1",
    UV_LINK_MODE: "copy",
    UV_CACHE_DIR: path.join(paths.root, "uv-cache"),
    UV_PYTHON_INSTALL_DIR: path.join(directory, "python"),
    UV_PYTHON_BIN_DIR: path.join(directory, "python", "bin"),
    UV_PYTHON_PREFERENCE: "only-managed",
    UV_TOOL_DIR: path.join(scratch, "uv-tools"),
    UV_TOOL_BIN_DIR: path.join(scratch, "uv-tools", "bin"),
    UV_PROJECT_ENVIRONMENT: path.join(directory, "venv"),
    XDG_CONFIG_HOME: path.join(scratch, "config"),
    XDG_DATA_HOME: path.join(scratch, "data"),
    XDG_CACHE_HOME: path.join(scratch, "cache"),
  };
}

/**
 * Runs the installed Python once and reads what it ships: the release date of
 * hermes_cli, the CPython version, and whether what the RPC bridge
 * (hermes-rpc-bridge.py) needs imports: the gateway discovery and client, and
 * websockets; and the MCP SDK the agents' MCP servers need (the `mcp` extra).
 * HOME and HERMES_HOME point at a scratch folder, so nothing reaches `~/.hermes`.
 */
export async function hermesIdentityCheck(
  record,
  { scratch, execute = executeFile, manifest = hermesManifest },
) {
  // The answer goes to file descriptor 1 directly: an import may move print().
  const probe =
    "import json, os, platform, hermes_cli, hermes_cli.gateway_client, " +
    "hermes_cli.gateway_runtime, hermes_cli.gateway_runtime_discovery, " +
    "websockets.asyncio.client, mcp.client.stdio; " +
    "os.write(1, (json.dumps({'releaseDate': hermes_cli.__release_date__, " +
    "'python': platform.python_version()}) + '\\n').encode())";
  const env = {
    HOME: scratch,
    HERMES_HOME: path.join(scratch, "hermes-home"),
    TMPDIR: scratch,
    LANG: "C.UTF-8",
    PATH: "/usr/bin:/bin",
  };
  fs.mkdirSync(env.HERMES_HOME, { recursive: true, mode: 0o700 });
  const { stdout } = await execute(record.pythonPath, ["-I", "-c", probe], {
    cwd: scratch,
    env,
    timeout: 120000,
    maxBuffer: 65536,
  });
  let found;
  try {
    found = JSON.parse(String(stdout).trim().split("\n").at(-1));
  } catch {
    found = null;
  }
  if (
    found?.releaseDate !== manifest.releaseDate ||
    found?.python !== manifest.pythonVersion
  )
    throw failure("HERMES_VERSION_MISMATCH");
  await execute(record.hermesPath, ["--version"], {
    cwd: scratch,
    env,
    timeout: 120000,
    maxBuffer: 65536,
  });
  return found;
}

/**
 * Puts the agent-browser binary the manifest pins into the installation's `tools/`
 * (hermesExecutables `agentBrowser`), on Hermes's PATH: its npm archive, checked
 * against the pinned SHA-256, holds one native binary per platform. Hermes's browser
 * tools find it there (tools/browser_tool_install.py `_find_agent_browser`), so they
 * never install it, nor the Chromium it would bring, at run time. Idempotent: a
 * matching binary stays.
 */
export async function installAgentBrowser(
  directory,
  { manifest, target, download, run, scratch },
) {
  const { tools, agentBrowser } = hermesExecutables(directory);
  const marker = path.join(tools, "agent-browser.json");
  if (
    fs.existsSync(agentBrowser) &&
    readJSON(marker, null)?.sha256 === manifest.agentBrowser.sha256
  )
    return;
  const bytes = await download(manifest.agentBrowser.url);
  sha256(bytes, manifest.agentBrowser.sha256);
  const archive = path.join(scratch, `${randomUUID()}.tgz`);
  const unpacked = privateFolder(path.join(scratch, `agent-browser-${randomUUID()}`));
  fs.writeFileSync(archive, bytes, { mode: 0o600 });
  const member = `package/bin/agent-browser-${target}`;
  await run("tar", ["-xzf", archive, "-C", unpacked, member], { timeout: 300000 });
  const binary = path.join(unpacked, member);
  regular(binary);
  privateFolder(tools);
  fs.copyFileSync(binary, agentBrowser);
  fs.chmodSync(agentBrowser, 0o755);
  writePrivate(marker, {
    version: manifest.agentBrowser.version,
    sha256: manifest.agentBrowser.sha256,
  });
}

/** Whether the installation in `directory` holds the agent-browser `manifest` pins. */
export const hasAgentBrowser = (directory, manifest = hermesManifest) =>
  fs.existsSync(hermesExecutables(directory).agentBrowser) &&
  readJSON(path.join(hermesExecutables(directory).tools, "agent-browser.json"), null)
    ?.sha256 === manifest.agentBrowser.sha256;

async function install({
  dataDir,
  platform = process.platform,
  arch = process.arch,
  download = downloadFile,
  execute = executeFile,
  manifest = hermesManifest,
  environment = process.env,
}) {
  const target = `${platform}-${arch}`;
  if (!manifest.uvChecksums[target]) throw failure("HERMES_PLATFORM_UNSUPPORTED");
  const paths = hermesPaths(dataDir);
  const directory = path.join(paths.runtimes, hermesIdentity(manifest, target));
  const record = recordOf(manifest, directory);
  const receiptFile = path.join(directory, "receipt.json");
  if (fs.existsSync(receiptFile)) {
    verifyInstalled(record, {
      commit: manifest.commit,
      archiveSha256: manifest.archiveSha256,
      uvLockSha256: manifest.uvLockSha256,
      pythonVersion: manifest.pythonVersion,
      uvChecksum: manifest.uvChecksums[target],
    });
    // An installation from before the browser gets its agent-browser now.
    if (!hasAgentBrowser(directory, manifest)) {
      const scratch = privateFolder(path.join(paths.tmp, `.install-${randomUUID()}`));
      try {
        await installAgentBrowser(directory, {
          manifest,
          target,
          download,
          scratch,
          run: (file, args, options) =>
            execute(file, args, { cwd: scratch, maxBuffer: 1024 * 1024, ...options }),
        });
      } catch (error) {
        if (!error.code || !/^HERMES_/.test(error.code))
          error.code = "HERMES_INSTALL_FAILED";
        throw error;
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    }
    return record;
  }
  // uv's environment holds absolute paths, so it is built in place; the receipt is
  // written last and marks a complete installation. A folder without one is a
  // crashed attempt (the caller holds the installation lock).
  fs.rmSync(directory, { recursive: true, force: true });
  const scratch = privateFolder(path.join(paths.tmp, `.install-${randomUUID()}`));
  const env = hermesInstallEnvironment({ paths, directory, scratch, environment });
  const run = (file, args, options = {}) =>
    execute(file, args, {
      env,
      cwd: scratch,
      timeout: 900000,
      maxBuffer: 8 * 1024 * 1024,
      ...options,
    });
  try {
    privateFolder(directory);
    const uvBytes = await download(uvArchiveUrl(manifest, target));
    sha256(uvBytes, manifest.uvChecksums[target]);
    const sourceBytes = await download(manifest.archiveUrl);
    sha256(sourceBytes, manifest.archiveSha256);
    const uvDirectory = privateFolder(path.join(directory, "uv"));
    const source = privateFolder(path.join(directory, "src"));
    for (const [bytes, folder] of [
      [uvBytes, uvDirectory],
      [sourceBytes, source],
    ]) {
      const archive = path.join(scratch, `${randomUUID()}.tar.gz`);
      fs.writeFileSync(archive, bytes, { mode: 0o600 });
      await run("tar", ["-xzf", archive, "-C", folder, "--strip-components=1"], {
        timeout: 300000,
      });
      fs.rmSync(archive);
    }
    const uv = path.join(uvDirectory, "uv");
    regular(uv);
    for (const [name, expected] of [
      ["pyproject.toml", manifest.pyprojectSha256],
      ["uv.lock", manifest.uvLockSha256],
    ]) {
      const file = path.join(source, name);
      regular(file);
      try {
        sha256(fs.readFileSync(file), expected);
      } catch {
        throw failure("HERMES_LOCK_MISMATCH");
      }
    }
    if (!String((await run(uv, ["--version"])).stdout).includes(manifest.uvVersion))
      throw failure("HERMES_INSTALLER_MISMATCH");
    await run(uv, ["python", "install", "--no-bin", manifest.pythonVersion]);
    await run(
      uv,
      [
        "sync",
        "--frozen",
        "--no-dev",
        ...manifest.extras.flatMap((extra) => ["--extra", extra]),
        "--python",
        manifest.pythonVersion,
      ],
      { cwd: source, env: { ...env, UV_PYTHON_DOWNLOADS: "never" } },
    );
    executable(record.pythonPath);
    executable(record.hermesPath);
    await hermesIdentityCheck(record, { scratch, execute, manifest });
    await installAgentBrowser(directory, { manifest, target, download, run, scratch });
    writePrivate(receiptFile, {
      commit: manifest.commit,
      archiveSha256: manifest.archiveSha256,
      pyprojectSha256: manifest.pyprojectSha256,
      uvLockSha256: manifest.uvLockSha256,
      uvChecksum: manifest.uvChecksums[target],
      pythonVersion: manifest.pythonVersion,
      extras: [...manifest.extras],
    });
    return record;
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    if (!error.code || !/^HERMES_/.test(error.code)) error.code = "HERMES_INSTALL_FAILED";
    throw error;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
    // The verified environment no longer needs downloaded wheels.
    fs.rmSync(env.UV_CACHE_DIR, { recursive: true, force: true });
  }
}

/**
 * Throws unless the installation of `record` still matches its receipt and each pin
 * `expected` names (commit, archive, lock, Python, uv archive).
 */
function verifyInstalled(record, expected) {
  const receiptFile = path.join(record.directory, "receipt.json");
  regular(receiptFile);
  const saved = readJSON(receiptFile);
  if (
    Object.entries(expected).some(([key, value]) => saved[key] !== value) ||
    saved.uvLockSha256 !== record.uvLockSha256 ||
    saved.commit !== record.commit
  )
    throw failure("HERMES_RUNTIME_CHANGED");
  sha256(
    fs.readFileSync(path.join(record.directory, "src", "uv.lock")),
    saved.uvLockSha256,
  );
  executable(record.pythonPath);
  executable(record.hermesPath);
}

// A candidate is recorded only when it differs from the selected installation.
function recordCandidate(root, record) {
  const file = path.join(root, "candidate.json");
  if (sameHermesRuntime(record, readJSON(path.join(root, "runtime.json"), null)))
    fs.rmSync(file, { force: true });
  else writePrivate(file, record);
}

/**
 * Installs the pinned Hermes beside the selected one under the Hermes installation
 * lock, and records it as the candidate unless it is the selection. One job per data
 * directory; a second call joins it.
 */
export function stageHermesRuntime(options) {
  const key = path.resolve(options.dataDir);
  if (jobs.has(key)) return jobs.get(key);
  const paths = hermesPaths(options.dataDir);
  const job = Promise.resolve()
    .then(() =>
      withInstallLock(paths, async () => {
        const record = await install(options);
        recordCandidate(paths.root, record);
        return record;
      }),
    )
    .finally(() => jobs.delete(key));
  jobs.set(key, job);
  return job;
}

/** Stages the pinned Hermes and selects it when nothing is selected yet. */
export async function ensureHermesRuntime(options) {
  const record = await stageHermesRuntime(options);
  const paths = hermesPaths(options.dataDir);
  const file = path.join(paths.root, "runtime.json");
  if (!fs.existsSync(file)) {
    const release = acquireInstallLock(paths);
    try {
      if (!fs.existsSync(file)) {
        writePrivate(file, record);
        recordCandidate(paths.root, record);
      }
    } finally {
      release();
    }
  }
  return readJSON(file);
}

/**
 * The selected Hermes installation, verified against its receipt; installs and
 * selects the pinned one when none is selected or the selected folder is gone. A
 * selection outside AgentPier's runtime folder is refused.
 */
export async function selectedHermesRuntime(options) {
  const paths = hermesPaths(options.dataDir);
  const file = path.join(paths.root, "runtime.json");
  const selected = readJSON(file, null);
  if (!selected) return ensureHermesRuntime(options);
  const directory = path.resolve(String(selected.directory || ""));
  if (
    path.dirname(directory) !== paths.runtimes ||
    selected.pythonPath !== hermesExecutables(directory).python ||
    selected.hermesPath !== hermesExecutables(directory).hermes
  )
    throw failure("HERMES_SELECTION_UNSAFE");
  if (!fs.existsSync(directory)) {
    fs.rmSync(file);
    return { ...(await ensureHermesRuntime(options)), diagnostic: "RUNTIME_REINSTALLED" };
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw failure("HERMES_SELECTION_UNSAFE");
  // The selection's own pins, so a rolled-back installation verifies against itself.
  verifyInstalled(selected, {
    commit: selected.commit,
    pythonVersion: selected.pythonVersion,
  });
  return selected;
}
