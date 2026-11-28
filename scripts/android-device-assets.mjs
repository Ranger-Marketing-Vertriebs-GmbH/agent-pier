import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { parseArgs } from "node:util";
import { isMainModule } from "../server/lib/is-main-module.js";
import {
  androidManifest,
  androidPlatform,
} from "../server/features/devices/android-manifest.js";
import { ensureSdk } from "../server/features/devices/android-sdk-install.js";
import { devicePaths } from "../server/features/devices/device-paths.js";
import { changedFiles } from "./assistant-runtime-paths.mjs";

// For the Android device contract (tests/integration/android-devices-contract.test.js),
// in CI (.github/workflows/android-devices.yml) and by hand:
//
//   node scripts/android-device-assets.mjs --root <data folder> [--archives <folder>] [--base <sha>]
//
// puts the pinned emulator, platform tools and system image below
// <root>/devices/sdk as AgentPier's own installation does: from the job's cache
// (receipts that name the pin: nothing is fetched), from the zip archives in
// `--archives` (by their file names; about 2.2 GB that need not be downloaded twice)
// or from Google's servers. Every archive is used only with its pinned size and
// SHA-256, wherever it comes from. It writes `available=true|false` to
// $GITHUB_OUTPUT.
//
// An outage of the download host must not fail runs that have nothing to do with
// the feature, and must never pass a change of the feature unseen:
// - a pull request (`--base`, its base commit) that changes the feature, or whose
//   changes cannot be read: the fetch failure fails the job;
// - any other run (another pull request, nightly, release, on demand): the contract
//   is left out of that run with a warning annotation that names the reason.

/** Paths whose change is a change of Android devices themselves. */
export const deviceFeaturePaths = [
  /^server\/features\/devices\//,
  /^server\/features\/tools\/(pinned-download|zip-unpack)\.js$/,
  /^scripts\/android-device-assets\.mjs$/,
  /^tests\/integration\/android-devices-contract\.test\.js$/,
  /^\.github\/workflows\/android-devices\.yml$/,
];

/**
 * Whether a failed fetch fails the job: `changed` are the files a pull request
 * changes (null when they cannot be read), `base` its base commit ("" outside one).
 */
export function fetchFailureIsFatal({ base, changed }) {
  if (!base) return false;
  if (!changed) return true;
  return changed.some((file) => deviceFeaturePaths.some((path) => path.test(file)));
}

/**
 * A `fetch` that answers an archive's URL from the file of the same name in
 * `folder`, range requests included, and everything else from the network.
 */
export function archiveFetch(folder, network = fetch) {
  return async (url, options = {}) => {
    const file = path.join(folder, path.basename(new URL(url).pathname));
    let size;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) throw Error("not a file");
      size = stat.size;
    } catch {
      return network(url, options);
    }
    const range = options.headers?.range ?? null;
    const from = range ? Number(/^bytes=(\d+)-$/.exec(range)?.[1]) : 0;
    if (!Number.isSafeInteger(from) || from >= size)
      return new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${size}` },
      });
    return new Response(Readable.toWeb(fs.createReadStream(file, { start: from })), {
      status: range ? 206 : 200,
      headers: range ? { "content-range": `bytes ${from}-${size - 1}/${size}` } : {},
    });
  };
}

export async function fetchDeviceAssets(
  { root, base = "", archives = "" },
  {
    ensure = ensureSdk,
    changed = changedFiles,
    log = console.log,
    manifest = androidManifest,
    host = { platform: process.platform, arch: process.arch },
  } = {},
) {
  try {
    await ensure({
      paths: devicePaths(root, manifest, host),
      manifest,
      key: androidPlatform(host.platform, host.arch),
      ...(archives && { fetchImpl: archiveFetch(archives) }),
    });
    return { available: true };
  } catch (error) {
    // Only the stable code: an error can carry a path.
    const code = /^[A-Z][A-Z0-9_]*$/.test(error?.code || "") ? error.code : "FAILED";
    const fatal = fetchFailureIsFatal({ base, changed: base ? changed(base) : null });
    log(
      fatal
        ? `::error title=Android SDK unavailable::The pinned Android emulator, platform tools or system image could not be installed (${code}), and this pull request changes Android devices: their contract must run.`
        : `::warning title=Android device contract not run::The pinned Android emulator, platform tools or system image could not be installed (${code}) and the cache holds none. The Android device contract is left out of this run.`,
    );
    return { available: false, fatal, code };
  }
}

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
      archives: { type: "string" },
      base: { type: "string" },
    },
  });
  if (
    !values.root ||
    !path.isAbsolute(values.root) ||
    (values.archives && !path.isAbsolute(values.archives))
  )
    throw Error(
      "Usage: node scripts/android-device-assets.mjs --root <absolute-data-folder> [--archives <absolute-folder>] [--base <sha>]",
    );
  fs.mkdirSync(values.root, { recursive: true, mode: 0o700 });
  const result = await fetchDeviceAssets(values);
  if (process.env.GITHUB_OUTPUT)
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `available=${result.available}\n`);
  if (result.available)
    console.log("Pinned Android emulator, platform tools and system image are in place.");
  process.exitCode = result.fatal ? 1 : 0;
}
