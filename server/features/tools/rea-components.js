import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { problem } from "../../lib/storage.js";
import { reaSources, verifiedDownload } from "./verified-download.js";
import { unpackTarGz } from "./tar-unpack.js";
import { unpackZip } from "./zip-unpack.js";
import { checkGhidra, checkJdk, insideReal } from "./rea-checks.js";
import { run as defaultRun } from "./tool-run.js";

// The pinned Ghidra and JDK of the managed REA tool (AGENTPIER-104): each archive is
// downloaded and checked, unpacked into <root>/.packages/<id>-<uuid> and activated
// through the <root>/<id> link, like the managed browser (chromium-installer.js).
export const reaComponentIds = Object.freeze(["rea-ghidra", "rea-jdk"]);
const record = "agentpier-rea.json";
// REA's own work-folder prefix: the browser's and the CLI installers' sweeps remove
// `.install-*`, so neither can ever touch an REA install in flight, nor REA theirs.
const workPrefix = ".rea-install-";
const bad = (message) => problem(message, 409);
// Ghidra unpacks to about 0.9 GB in some 20000 files; the limits leave headroom while
// still stopping an archive bomb.
const limits = { maxExpanded: 4 * 1024 * 1024 * 1024, maxFiles: 100000 };
const components = {
  "rea-ghidra": { name: "Ghidra", home: (entry) => entry.installDir, check: checkGhidra },
  "rea-jdk": { name: "JDK", home: (entry) => entry.home, check: checkJdk },
};
const diskFull = (error) =>
  ["ENOSPC", "EDQUOT"].includes(error?.code) ||
  ["ENOSPC", "EDQUOT"].includes(error?.cause?.code);

function component(id) {
  if (!Object.hasOwn(components, id)) throw new TypeError(`Unknown REA component ${id}`);
  return components[id];
}

const activation = (root, id) => path.join(root, id);
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
 * the link atomically. The previous version stays until the next install, so a
 * running REA keeps its files. Nothing is published unless every step passed.
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
}) {
  const { name, home, check } = component(id);
  const packages = path.join(root, ".packages");
  await fsp.mkdir(packages, { recursive: true, mode: 0o700 });
  const work = await fsp.mkdtemp(path.join(root, workPrefix));
  const directory = path.join(packages, `${prefix(id)}${randomUUID()}`);
  let published = false;
  try {
    // A fresh name in a fresh folder: a file left by a crash never blocks this one.
    const archive = path.join(work, `${id}-${randomUUID()}`);
    progress?.(serverMessages.rea.downloading(name, 0));
    await verifiedDownload({
      entry,
      file: archive,
      allow: reaSources,
      fetchImpl,
      signal,
      progress: (percent) => progress?.(serverMessages.rea.downloading(name, percent)),
    });
    progress?.(serverMessages.rea.unpacking(name));
    await fsp.mkdir(directory, { mode: 0o700 });
    await unpack(entry, archive, directory, signal);
    await fsp.rm(archive, { force: true });
    progress?.(serverMessages.rea.checking(name));
    await check({ directory, entry, version, platform, run, env, signal });
    await fsp.writeFile(
      path.join(directory, record),
      JSON.stringify({ id, version, platform, home: home(entry) }),
      { mode: 0o600, flag: "wx" },
    );
    const previous = managedReaComponent(root, id)?.directory;
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
    // Published: an old version that cannot be removed now goes at the next install.
    await prune(root, id, [directory, previous].filter(Boolean)).catch((error) =>
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

// Keeps `keep` and whatever the link points at when pruning runs (like
// pruneGithubMcpPackages); only this component's version directories are touched.
// The server runs one installation job at a time, so no two prunes overlap.
async function prune(root, id, keep) {
  const packages = path.join(root, ".packages");
  const active = await fsp.realpath(activation(root, id)).catch(() => null);
  const kept = new Set(
    [...keep, active].filter(Boolean).map((dir) => path.basename(dir)),
  );
  for (const name of await fsp.readdir(packages).catch(() => []))
    if (name.startsWith(prefix(id)) && !kept.has(name))
      await fsp.rm(path.join(packages, name), { recursive: true, force: true });
}

/** Removes component `id`: its link and every version directory; a no-op when absent. */
export async function removeReaComponent(root, id) {
  component(id);
  const link = activation(root, id);
  const stat = await fsp.lstat(link).catch(() => null);
  if (stat && !stat.isSymbolicLink())
    throw bad(serverMessages.tools.installationDirectoryInvalid);
  if (stat) await fsp.unlink(link);
  await prune(root, id, []);
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
