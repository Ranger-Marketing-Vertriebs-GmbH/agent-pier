import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { privateDirectory, readJSON, writePrivate } from "../../lib/storage.js";
import { downloadResumed, requireSpace } from "../tools/pinned-download.js";
import { run as runTool } from "../tools/tool-run.js";
import { unpackZip } from "../tools/zip-unpack.js";
import { deviceEnvironment, ensureDeviceFolders, receiptFile } from "./device-paths.js";

/*
 * The pinned Android SDK components on disk (android-manifest.js): platform tools,
 * emulator and one system image, in that order. Each is downloaded resumably into
 * `devices/downloads`, used only with the pinned size and SHA-256, unpacked into a
 * stage folder below the SDK, checked there, given its receipt and then renamed into
 * place. A component directory without a receipt is not installed and is replaced;
 * an earlier installation stays untouched until its replacement passed its check.
 * No Java is involved: there is no sdkmanager, only three zip archives.
 */
const components = ["platformTools", "emulator", "image"];
const reserve = 2 ** 30;
// A first start may wait for macOS's check of a new executable.
const versionTimeoutMs = 120000;
const failure = (code, detail) =>
  Object.assign(Error(code), { code, ...(detail && { detail }) });
const stable = (error) => /^DEVICES_[A-Z0-9_]+$/.test(error?.code || "");
const diskFull = (error) =>
  [error?.code, error?.cause?.code].some((code) => ["ENOSPC", "EDQUOT"].includes(code));

function regularFile(file) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() ? stat : null;
  } catch {
    return null;
  }
}

function receipt(directory) {
  try {
    const stored = readJSON(path.join(directory, receiptFile), null);
    return typeof stored?.version === "string" && typeof stored?.sha256 === "string"
      ? stored
      : null;
  } catch {
    return null;
  }
}

// Where a component lives, what its receipt names, and its pinned archive.
function component(paths, manifest, key, name) {
  const archive = manifest[name]?.archives?.[key] ?? null;
  if (name === "image")
    return {
      name,
      archive,
      version: manifest.image.id,
      directory: paths.image(manifest.image.id, archive?.abi),
    };
  const directory = name === "emulator" ? paths.emulator : paths.platformTools;
  const executable = name === "emulator" ? paths.emulatorBin : paths.adbBin;
  return { name, archive, version: manifest[name].version, directory, executable };
}

function imageIds(paths, abi) {
  let names = [];
  try {
    names = fs.readdirSync(paths.images);
  } catch {
    // No image folder yet.
  }
  return names
    .filter((id) => abi && receipt(paths.image(id, abi))?.version === id)
    .sort();
}

/**
 * What is installed below `paths`, read from the receipts; nothing is downloaded.
 * `{ emulator, platformTools }` are the installed versions or null, `images` the ids
 * of the installed images, and `current` says that all three are the pinned ones.
 */
export function installedSdk(paths, manifest, key) {
  const installed = {};
  let current = true;
  for (const name of components) {
    const part = component(paths, manifest, key, name);
    const stored = receipt(part.directory);
    const usable = stored && (!part.executable || regularFile(part.executable));
    if (name !== "image") installed[name] = usable ? stored.version : null;
    if (!usable || !part.archive || stored.sha256 !== part.archive.sha256)
      current = false;
  }
  return {
    emulator: installed.emulator,
    platformTools: installed.platformTools,
    images: imageIds(paths, manifest.image.archives?.[key]?.abi),
    current,
  };
}

/** Removes stage folders an interrupted installation left below the SDK. */
export function sweepSdk(paths) {
  let names = [];
  try {
    names = fs.readdirSync(paths.sdk);
  } catch {
    return;
  }
  for (const name of names)
    if (name.startsWith(".stage-"))
      fs.rmSync(path.join(paths.sdk, name), { recursive: true, force: true });
}

/** Removes every installed image whose id is not in `keep`. */
export function pruneImages(paths, keep) {
  let names = [];
  try {
    names = fs.readdirSync(paths.images);
  } catch {
    return;
  }
  for (const name of names)
    if (!keep.includes(name))
      fs.rmSync(path.join(paths.images, name), { recursive: true, force: true });
}

/**
 * Removes the SDK, unfinished downloads and the home of its processes (adb keys,
 * emulator state). Devices and settings are not touched here.
 */
export async function removeSdk(paths) {
  for (const directory of [paths.sdk, paths.downloads, paths.home, paths.tmp])
    await fsp.rm(directory, { recursive: true, force: true });
}

// The binary that runs a device without a window on this host
// (`<emulator>/qemu/<host>/qemu-system-<arch>-headless`): the launcher starts it. The
// archive also holds headless binaries that emulate other architectures; AgentPier
// never starts those.
const headless = { "linux-x64": "qemu/linux-x86_64/qemu-system-x86_64-headless" };
const libraryMissing =
  /error while loading shared libraries: (\S+): cannot open shared object file/g;

// Libraries `ldd` cannot resolve for `binary`. `ldd` itself missing or failing
// names nothing: the start below decides then.
async function unresolved(binary, { run, env, directory, signal }) {
  const listed = await run("ldd", [binary], env, directory, signal, 60000).catch(
    () => "",
  );
  return [...listed.matchAll(/^\s*(\S+)\s+=>\s+not found/gm)].map((match) => match[1]);
}

// The component runs and is the pinned version. On Linux, `ldd` names libraries the
// host lacks, for the launcher and for the headless binary it starts. That binary
// loads the emulator's own libraries from `<emulator>/lib64`, which the launcher puts
// on LD_LIBRARY_PATH, so `ldd` gets the same path: without it every bundled library
// reads as missing on a host where the emulator runs. A library the emulator only
// loads later (libX11-xcb) shows as a start that fails; the loader's message names
// it. The emulator is asked with `-no-window`: a bare `-version` starts the windowed
// binary on Linux, which needs X libraries a server does not have and AgentPier
// never uses.
async function check(part, directory, { manifest, key, run, env, signal }) {
  const executable = path.join(directory, path.basename(part.executable));
  if (!regularFile(executable)) throw failure("DEVICES_ARCHIVE_INVALID");
  if (key.startsWith("linux") && part.name === "emulator") {
    const context = { run, env, directory, signal };
    const missing = new Set(await unresolved(executable, context));
    const qemu = headless[key] && path.join(directory, headless[key]);
    if (qemu && regularFile(qemu)) {
      const bundled = path.join(directory, "lib64");
      const LD_LIBRARY_PATH = [bundled, env?.LD_LIBRARY_PATH].filter(Boolean).join(":");
      for (const name of await unresolved(qemu, {
        ...context,
        env: { ...env, LD_LIBRARY_PATH },
      }))
        missing.add(name);
    }
    if (missing.size) throw failure("DEVICES_SDK_UNUSABLE", { missing: [...missing] });
  }
  const output = await run(
    executable,
    part.name === "emulator" ? ["-no-window", "-version"] : ["version"],
    env,
    directory,
    signal,
    versionTimeoutMs,
  ).catch((error) => {
    if (signal.aborted || diskFull(error)) throw error;
    // The loader names a library it could not open (the runner keeps the output).
    const missing = [
      ...new Set(
        [...String(error?.output ?? "").matchAll(libraryMissing)].map((m) => m[1]),
      ),
    ];
    throw failure("DEVICES_SDK_UNUSABLE", missing.length ? { missing } : undefined);
  });
  const version =
    part.name === "emulator"
      ? /Android emulator version (\d+\.\d+\.\d+)/.exec(output)?.[1]
      : /^Version (\d+\.\d+\.\d+)/m.exec(output)?.[1];
  const build =
    part.name === "emulator" ? /\(build_id (\d+)\)/.exec(output)?.[1] : undefined;
  if (
    version !== manifest[part.name].version ||
    (part.name === "emulator" && build !== manifest.emulator.build)
  )
    throw failure("DEVICES_SDK_UNUSABLE");
}

/**
 * Installs or updates every component whose receipt does not name the pinned
 * archive, then removes images that are neither the pinned one nor in `keepImages`.
 * Resolves installedSdk(). `onProgress({ component, phase, received, total })`
 * reports the bytes downloaded over all components that are being installed, with
 * `phase` "downloading", "unpacking" or "checking". Rejects with a stable `code`:
 * DEVICES_DOWNLOAD_*, DEVICES_CHECKSUM_MISMATCH, DEVICES_DISK_SPACE,
 * DEVICES_ARCHIVE_INVALID, DEVICES_SDK_UNUSABLE (with `detail.missing` where `ldd`
 * names libraries) or DEVICES_INSTALL_FAILED. A partial download stays for the next
 * call. `run` and `unpack` are the process runner and the unpacker; tests replace
 * them.
 */
export async function ensureSdk({
  paths,
  manifest,
  key,
  fetchImpl = fetch,
  run = runTool,
  unpack = unpackZip,
  env = deviceEnvironment(paths),
  signal = new AbortController().signal,
  onProgress = () => {},
  keepImages = [],
}) {
  const parts = components.map((name) => component(paths, manifest, key, name));
  if (parts.some((part) => !part.archive)) throw failure("DEVICES_PLATFORM_UNSUPPORTED");
  try {
    ensureDeviceFolders(paths);
    sweepSdk(paths);
    const wanted = parts.filter(
      (part) => receipt(part.directory)?.sha256 !== part.archive.sha256,
    );
    const file = (part) => path.join(paths.downloads, path.basename(part.archive.url));
    // A finished download whose installation did not finish is checked again as a
    // partial file: its bytes are hashed, and a range request fetches nothing.
    for (const part of wanted)
      if (regularFile(file(part))) await fsp.rename(file(part), `${file(part)}.partial`);
    const have = (part) =>
      Math.min(regularFile(`${file(part)}.partial`)?.size || 0, part.archive.size);
    const total = wanted.reduce((sum, part) => sum + part.archive.size, 0);
    if (wanted.length)
      await requireSpace(
        paths.root,
        wanted.reduce(
          (sum, part) =>
            sum + part.archive.size - have(part) + part.archive.expandedBytes,
          reserve,
        ),
        "DEVICES_DISK_SPACE",
      );
    let done = 0;
    for (const part of wanted) {
      const report = (phase, received) =>
        onProgress({ component: part.name, phase, received: done + received, total });
      await downloadResumed({
        url: part.archive.url,
        file: file(part),
        size: part.archive.size,
        sha256: part.archive.sha256,
        fetchImpl,
        signal,
        prefix: "DEVICES",
        hosts: manifest.hosts,
        onProgress: ({ received }) => report("downloading", received),
      });
      done += part.archive.size;
      const stage = path.join(paths.sdk, `.stage-${randomUUID()}`);
      try {
        privateDirectory(stage);
        report("unpacking", 0);
        await unpack(file(part), stage, part.archive.top, signal, {
          maxExpanded: part.archive.expandedBytes,
          // Folder entries count too; an archive has fewer folders than files.
          maxFiles: part.archive.files * 2 + 64,
        }).catch((error) => {
          if (signal.aborted || diskFull(error)) throw error;
          throw failure("DEVICES_ARCHIVE_INVALID");
        });
        const unpacked = path.join(stage, part.archive.top);
        report("checking", 0);
        if (part.executable)
          await check(part, unpacked, { manifest, key, run, env, signal });
        else if (!fs.readdirSync(unpacked).length)
          throw failure("DEVICES_ARCHIVE_INVALID");
        writePrivate(path.join(unpacked, receiptFile), {
          version: part.version,
          sha256: part.archive.sha256,
        });
        // The earlier installation leaves only now, and returns if the swap fails.
        privateDirectory(path.dirname(part.directory));
        const previous = path.join(stage, ".previous");
        const replaced = fs.existsSync(part.directory);
        if (replaced) await fsp.rename(part.directory, previous);
        try {
          await fsp.rename(unpacked, part.directory);
        } catch (error) {
          if (replaced) await fsp.rename(previous, part.directory).catch(() => {});
          throw error;
        }
        await fsp.rm(file(part), { force: true });
      } finally {
        await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
      }
    }
    // Everything pinned is installed: what is left of earlier downloads is not needed.
    for (const name of fs.readdirSync(paths.downloads))
      await fsp.rm(path.join(paths.downloads, name), { recursive: true, force: true });
    pruneImages(paths, [manifest.image.id, ...keepImages]);
    return installedSdk(paths, manifest, key);
  } catch (error) {
    if (signal.aborted) throw failure("DEVICES_DOWNLOAD_CANCELLED");
    if (diskFull(error)) throw failure("DEVICES_DISK_SPACE");
    throw stable(error) ? error : failure("DEVICES_INSTALL_FAILED");
  }
}
