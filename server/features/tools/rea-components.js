import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { problem } from "../../lib/storage.js";
import { reaSources, verifiedDownload } from "./verified-download.js";
import { unpackTarGz } from "./tar-unpack.js";
import { unpackZip } from "./zip-unpack.js";
import { checkCraftAnything, checkGhidra, checkJdk, insideReal } from "./rea-checks.js";
import { run as defaultRun } from "./tool-run.js";
import { heldPaths } from "../../lib/process-commands.js";

// The pinned Ghidra and JDK of the managed REA tool (AGENTPIER-104) and the Craft
// Anything binary: each archive is downloaded and checked, unpacked into
// <root>/.packages/<id>-<uuid> and activated through the <root>/<id> link, like the
// managed browser (chromium-installer.js). Callers that place or remove Ghidra and the
// JDK name "rea-ghidra" and "rea-jdk" explicitly; only the sweep covers every id.
export const reaComponentIds = Object.freeze(["rea-ghidra", "rea-jdk", "craft-anything"]);
const record = "agentpier-rea.json";
// REA's own work-folder prefix: the browser's and the CLI installers' sweeps remove
// `.install-*`, so neither can ever touch an REA install in flight, nor REA theirs.
const workPrefix = ".rea-install-";
const bad = (message) => problem(message, 409);
// Ghidra unpacks to about 0.9 GB in some 20000 files; the limits leave headroom while
// still stopping an archive bomb.
const limits = { maxExpanded: 4 * 1024 * 1024 * 1024, maxFiles: 100000 };
const reaMessages = {
  downloading: (name, percent) => serverMessages.rea.downloading(name, percent),
  unpacking: (name) => serverMessages.rea.unpacking(name),
  checking: (name) => serverMessages.rea.checking(name),
};
const craftMessages = {
  downloading: (_name, percent) => serverMessages.craft.downloading(percent),
  unpacking: () => serverMessages.craft.unpacking,
  checking: () => serverMessages.craft.checking,
};
const components = {
  "rea-ghidra": {
    name: "Ghidra",
    home: (entry) => entry.installDir,
    check: checkGhidra,
    messages: reaMessages,
  },
  "rea-jdk": {
    name: "JDK",
    home: (entry) => entry.home,
    check: checkJdk,
    messages: reaMessages,
  },
  // The folder holding the binary; the unpacker keeps the archive's top folder.
  "craft-anything": {
    name: "Craft Anything",
    home: (entry) => path.posix.join(entry.top, path.posix.dirname(entry.binary)),
    check: checkCraftAnything,
    messages: craftMessages,
  },
};
const diskFull = (error) =>
  ["ENOSPC", "EDQUOT"].includes(error?.code) ||
  ["ENOSPC", "EDQUOT"].includes(error?.cause?.code);

function component(id) {
  if (!Object.hasOwn(components, id)) throw new TypeError(`Unknown REA component ${id}`);
  return components[id];
}

const activation = (root, id) => path.join(root, id);

// Deletes the files `entry.remove` lists, only inside the version directory: a path
// that is absolute, climbs out or whose folder resolves outside is refused. The paths
// are relative to the archive's top folder `top`, which the unpacker keeps.
async function removeListed(directory, top, remove = []) {
  for (const listed of remove) {
    const valid =
      typeof listed === "string" &&
      listed &&
      !path.isAbsolute(listed) &&
      !listed.split("/").includes("..");
    const relative = valid ? path.posix.join(top, listed) : null;
    const folder = relative && insideReal(directory, path.posix.dirname(relative));
    if (!folder) throw bad(serverMessages.craft.layoutInvalid);
    await fsp.rm(path.join(folder, path.posix.basename(relative)), { force: true });
  }
}
const prefix = (id) => `${id}-`;

/**
 * The installed component `id` below `root` (<dataDir>/clis): its version, its version
 * directory and the real path of its home (GHIDRA_INSTALL_DIR or JAVA_HOME), or null
 * unless the link, the record and the home all check out.
 */
export function managedReaComponent(root, id) {
  if (!root || !Object.hasOwn(components, id)) return null;
  try {
    const directory = fs.realpathSync(activation(root, id));
    const packages = fs.realpathSync(path.join(root, ".packages"));
    if (
      path.dirname(directory) !== packages ||
      !path.basename(directory).startsWith(prefix(id))
    )
      return null;
    const info = JSON.parse(fs.readFileSync(path.join(directory, record), "utf8"));
    if (info.id !== id || typeof info.version !== "string") return null;
    const home = insideReal(directory, info.home);
    if (!home || !fs.statSync(home).isDirectory()) return null;
    return { version: info.version, directory, home };
  } catch {
    return null;
  }
}

/** Unpacks the archive into `directory`; `entry.kind` is "tar.gz" (default) or "zip". */
function unpack(entry, archive, directory, signal) {
  if (entry.kind === "zip")
    return unpackZip(archive, directory, entry.top, signal, limits);
  return unpackTarGz(archive, directory, entry.top, signal, limits);
}

/**
 * Installs or updates component `id` from the pinned `entry`: download and check,
 * unpack into a new version directory, check the version, write the record and switch
 * the link atomically. An older version a running process still uses (an idle MCP
 * server of a session started before) stays until it exits (`held`, heldPaths by
 * default; pruneReaVersions removes it later). Nothing is published unless every step
 * passed.
 */
export async function installReaComponent({
  root,
  id,
  version,
  entry,
  fetchImpl = fetch,
  signal = new AbortController().signal,
  run = defaultRun,
  env = process.env,
  platform = process.platform,
  progress,
  held = heldPaths(),
}) {
  const { name, home, check, messages } = component(id);
  const packages = path.join(root, ".packages");
  await fsp.mkdir(packages, { recursive: true, mode: 0o700 });
  const work = await fsp.mkdtemp(path.join(root, workPrefix));
  const directory = path.join(packages, `${prefix(id)}${randomUUID()}`);
  let published = false;
  try {
    // A fresh name in a fresh folder: a file left by a crash never blocks this one.
    const archive = path.join(work, `${id}-${randomUUID()}`);
    progress?.(messages.downloading(name, 0));
    await verifiedDownload({
      entry,
      file: archive,
      allow: reaSources,
      fetchImpl,
      signal,
      progress: (percent) => progress?.(messages.downloading(name, percent)),
    });
    progress?.(messages.unpacking(name));
    await fsp.mkdir(directory, { mode: 0o700 });
    await unpack(entry, archive, directory, signal);
    await fsp.rm(archive, { force: true });
    await removeListed(directory, entry.top, entry.remove);
    progress?.(messages.checking(name));
    await check({ directory, entry, version, platform, run, env, signal });
    await fsp.writeFile(
      path.join(directory, record),
      JSON.stringify({ id, version, platform, home: home(entry) }),
      { mode: 0o600, flag: "wx" },
    );
    // The link is replaced atomically: a reader sees the old or the new version.
    const link = path.join(root, `.${id}-link-${randomUUID()}`);
    await fsp.symlink(path.relative(root, directory), link, "dir");
    try {
      await fsp.rename(link, activation(root, id));
    } catch (error) {
      await fsp.rm(link, { force: true }).catch(() => {});
      throw error;
    }
    published = true;
    // Published: an old version a process runs, or one that cannot be removed now,
    // goes at a later sweep.
    await prune(root, id, [directory], { sparesRecent: true, held }).catch((error) =>
      console.warn(
        `AgentPier could not remove an old version of ${id} (${error?.code ?? "error"}).`,
      ),
    );
    const real = await fsp.realpath(directory);
    return { version, directory: real, home: insideReal(real, home(entry)) };
  } catch (error) {
    if (diskFull(error)) throw bad(serverMessages.rea.diskFull);
    throw error;
  } finally {
    if (!published)
      await fsp.rm(directory, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

// An unpublished version folder (no record) changed this recently may belong to an
// install still running in another process (an installer run beside the server).
const inFlightMs = 10 * 60 * 1000;

async function recent(directory) {
  const stat = await fsp.stat(directory).catch(() => null);
  return !!stat && Date.now() - stat.mtimeMs < inFlightMs;
}

async function inFlight(directory) {
  if (await fsp.stat(path.join(directory, record)).catch(() => null)) return false;
  return recent(directory);
}

// The paths a process may name a version directory by: the folder itself (also its
// real path) and, for a published one, its home through the activation link, such as
// <root>/craft-anything/craft-anything-cli-0.5.0-macos-universal. The link moves on
// with an update, but the home's name carries the version.
async function versionPaths(root, id, directory) {
  const paths = [directory, await fsp.realpath(directory).catch(() => null)];
  try {
    const info = JSON.parse(await fsp.readFile(path.join(directory, record), "utf8"));
    if (typeof info.home === "string" && info.home && !info.home.startsWith("."))
      for (const base of [root, await fsp.realpath(root).catch(() => null)])
        if (base) paths.push(path.join(base, id, info.home));
    return { paths, version: typeof info.version === "string" ? info.version : null };
  } catch {
    return { paths, version: null };
  }
}

// Keeps `keep` and whatever the link points at when pruning runs (like
// pruneGithubMcpPackages); only this component's version directories are touched.
// The server runs one installation job at a time; with `sparesRecent` an install also
// leaves another process's recent unpublished folder alone (the next start sweeps it).
// With `held` a version a running process uses stays too; with `sparesNew` (a sweep
// beside a job of either tool or an installer run) every version changed recently.
// Returns the versions kept for either reason: `[{ id, version, directory, running }]`.
async function prune(
  root,
  id,
  keep,
  { sparesRecent = false, sparesNew = false, held = null } = {},
) {
  const packages = path.join(root, ".packages");
  const active = await fsp.realpath(activation(root, id)).catch(() => null);
  const kept = new Set(
    [...keep, active].filter(Boolean).map((dir) => path.basename(dir)),
  );
  const lingering = [];
  for (const name of await fsp.readdir(packages).catch(() => [])) {
    if (!name.startsWith(prefix(id)) || kept.has(name)) continue;
    const directory = path.join(packages, name);
    if (sparesRecent && (await inFlight(directory))) continue;
    if (held) {
      const { paths, version } = await versionPaths(root, id, directory);
      if (held(paths, id)) {
        lingering.push({ id, version, directory, running: true });
        continue;
      }
    }
    if (sparesNew && (await recent(directory))) {
      lingering.push({ id, version: null, directory, running: false });
      continue;
    }
    await fsp.rm(directory, { recursive: true, force: true });
  }
  return lingering;
}

/**
 * Removes component `id`: its link and every version directory no running process
 * uses (`held`, heldPaths by default); pruneReaVersions removes those later. A no-op
 * when absent.
 */
export async function removeReaComponent(root, id, { held = heldPaths() } = {}) {
  component(id);
  const link = activation(root, id);
  const stat = await fsp.lstat(link).catch(() => null);
  if (stat && !stat.isSymbolicLink())
    throw bad(serverMessages.tools.installationDirectoryInvalid);
  if (stat) await fsp.unlink(link);
  return prune(root, id, [], { held });
}

/**
 * Removes the version directories of `ids` that are neither active, nor used by a
 * running process (`held`), nor changed in the last minutes (an install in flight):
 * what an update or a removal left for a session's idle MCP server, once that process
 * exited. Returns what stays: `[{ id, version, directory, running }]`.
 */
export async function pruneReaVersions(
  root,
  { ids = reaComponentIds, held = heldPaths() } = {},
) {
  const lingering = [];
  for (const id of ids)
    lingering.push(...(await prune(root, id, [], { sparesNew: true, held })));
  return lingering;
}

/**
 * What an interrupted install left behind, swept at a server start while no job runs:
 * work folders, stray temporary links and version directories that were never
 * published (no record). Published versions stay.
 */
export function sweepReaComponents(root) {
  const entries = (directory) => {
    try {
      return fs.readdirSync(directory);
    } catch {
      return [];
    }
  };
  const links = reaComponentIds.map((id) => `.${id}-link-`);
  for (const name of entries(root))
    if (name.startsWith(workPrefix) || links.some((link) => name.startsWith(link)))
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
  const packages = path.join(root, ".packages");
  for (const name of entries(packages))
    if (
      reaComponentIds.some((id) => name.startsWith(prefix(id))) &&
      !fs.existsSync(path.join(packages, name, record))
    )
      fs.rmSync(path.join(packages, name), { recursive: true, force: true });
}

/**
 * Places the pinned JDK and Ghidra (`host` is reaPlatform's result, `manifest` REA's
 * manifest) below `root`, shared by REA and Craft Anything: a component already there
 * stays unless `update` asks for the pin and its version differs, and always with
 * `keep` (the other tool's session runs it; the part stays outdated for a later
 * update). A missing component is installed either way. `progress(step, message)`
 * reports each step ("jdk", "ghidra").
 */
export async function placeGhidra({
  root,
  manifest,
  host,
  update,
  keep = false,
  signal,
  fetchImpl,
  run,
  env,
  platform,
  progress,
  held,
}) {
  const parts = [
    ["rea-jdk", "jdk", host.ghidra.jdk, manifest.jdk.version],
    ["rea-ghidra", "ghidra", host.ghidra.entry, manifest.ghidra.version],
  ];
  for (const [id, step, entry, version] of parts) {
    const current = managedReaComponent(root, id);
    if (current && (!update || keep || current.version === version)) continue;
    progress(step);
    await installReaComponent({
      root,
      id,
      version,
      entry,
      fetchImpl,
      signal,
      run,
      env,
      platform,
      progress: (message) => progress(step, message),
      ...(held && { held }),
    });
  }
}
