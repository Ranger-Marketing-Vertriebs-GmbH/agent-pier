import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { problem } from "../../lib/storage.js";
import { chromiumManifest, chromiumPlatform } from "./chromium-manifest.js";

// A managed Chrome for Testing build for the agents' browsers (AGENTPIER-121): a
// pinned, SHA-256-checked archive unpacked below <dataDir>/clis/.packages and
// activated through the <dataDir>/clis/chromium link, like the managed CLIs.
const MAX_EXPANDED = 1536 * 1024 * 1024,
  MAX_FILES = 20000,
  MAX_LINK = 4096;
const record = "agentpier-chromium.json";
const packagePrefix = "chromium-";
const bad = (message) => problem(message, 409);
const allowedHosts = new Set(["storage.googleapis.com"]);

/** The activation link of the managed browser. */
export const chromiumActivation = (root) => path.join(root, "chromium");

/**
 * The installed managed browser below `root` (<dataDir>/clis): its version and the
 * real path of its executable, or null. The real path names the version directory,
 * so an update changes what the Gateway compiles (a restart picks it up).
 */
export function managedChromium(root) {
  if (!root) return null;
  try {
    const directory = fs.realpathSync(chromiumActivation(root));
    if (!directory.startsWith(fs.realpathSync(root) + path.sep)) return null;
    const info = JSON.parse(fs.readFileSync(path.join(directory, record), "utf8"));
    if (typeof info.executable !== "string" || typeof info.version !== "string")
      return null;
    const executable = path.join(directory, info.executable);
    if (!executable.startsWith(directory + path.sep)) return null;
    fs.accessSync(executable, fs.constants.X_OK);
    return { version: info.version, executable, directory };
  } catch {
    return null;
  }
}

/**
 * The managed browser as the app's tool list shows it (GET /state utilities): it is
 * installed, its version and whether the pinned version is newer.
 */
export function chromiumUtility(root, manifest = chromiumManifest) {
  const installed = managedChromium(root);
  return {
    id: "chromium",
    name: "Chrome for Testing",
    utility: true,
    installed: !!installed,
    path: installed?.executable || null,
    version: installed?.version || null,
    pinnedVersion: manifest.version,
    updateAvailable: !!installed && installed.version !== manifest.version,
  };
}

/** Why this host cannot get the managed browser, or null. */
export function chromiumUnavailable(platform, arch, manifest = chromiumManifest) {
  const key = chromiumPlatform(platform, arch);
  return key && manifest.platforms[key]
    ? null
    : serverMessages.tools.chromiumPlatformUnavailable;
}

function downloadURL(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw bad(serverMessages.tools.chromiumDownloadFailed);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !allowedHosts.has(url.hostname)
  )
    throw bad(serverMessages.tools.chromiumDownloadFailed);
  return url;
}

/** Streams the pinned archive to `file`; size and SHA-256 must match the manifest. */
async function download({ entry, file, fetchImpl, signal, progress }) {
  let response;
  try {
    response = await fetchImpl(downloadURL(entry.url), {
      redirect: "error",
      credentials: "omit",
      signal,
      headers: { "User-Agent": "AgentPier" },
    });
  } catch (error) {
    if (signal?.aborted) throw bad(serverMessages.tools.installationAbortedOrTimedOut);
    throw error.status ? error : bad(serverMessages.tools.chromiumDownloadFailed);
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel?.();
    throw bad(serverMessages.tools.downloadHttpFailed(response.status));
  }
  const length = Number(response.headers.get("content-length"));
  if (length && length !== entry.size) {
    await response.body.cancel?.();
    throw bad(serverMessages.tools.chromiumChecksumMismatch);
  }
  const hash = createHash("sha256");
  let size = 0,
    reported = -1;
  const counted = async function* (source) {
    for await (const chunk of source) {
      size += chunk.length;
      if (size > entry.size) throw bad(serverMessages.tools.chromiumChecksumMismatch);
      hash.update(chunk);
      const percent = Math.floor((size / entry.size) * 100);
      if (percent !== reported) {
        reported = percent;
        progress?.(serverMessages.tools.chromiumDownloading(percent));
      }
      yield chunk;
    }
  };
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      counted,
      fs.createWriteStream(file, { mode: 0o600, flags: "wx" }),
      { signal },
    );
  } catch (error) {
    if (signal?.aborted) throw bad(serverMessages.tools.installationAbortedOrTimedOut);
    throw error.status ? error : bad(serverMessages.tools.chromiumDownloadFailed);
  }
  if (size !== entry.size || hash.digest("hex") !== entry.sha256)
    throw bad(serverMessages.tools.chromiumChecksumMismatch);
}

function entryName(name, top) {
  if (
    typeof name !== "string" ||
    name.length > 1024 ||
    /[\\\x00-\x1f\x7f]/.test(name) ||
    name.startsWith("/") ||
    name.split("/").some((part) => part === "." || part === "..") ||
    !(name === `${top}/` || name.startsWith(`${top}/`))
  )
    throw bad(serverMessages.tools.unsafeArchivePath);
  return name.replace(/\/$/, "");
}

// Every parent below `dest` must be a real directory: a link unpacked earlier never
// redirects a later entry.
async function realParents(dest, relative) {
  let current = dest;
  for (const part of path.posix.dirname(relative).split("/")) {
    if (part === ".") continue;
    current = path.join(current, part);
    const stat = await fsp.lstat(current).catch(() => null);
    if (!stat) await fsp.mkdir(current, { mode: 0o700 });
    else if (!stat.isDirectory() || stat.isSymbolicLink())
      throw bad(serverMessages.tools.unsafeArchivePath);
  }
}

/** Unpacks the archive into `dest`, keeping modes and the app bundle's links. */
export async function unpackChromium(file, dest, top, signal) {
  // Loaded on use: the installer scripts import this module before dependencies exist.
  const { open: openZip } = await import("yauzl");
  return new Promise((resolve, reject) => {
    openZip(
      file,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, zip) => {
        if (error) return reject(bad(serverMessages.tools.chromiumArchiveInvalid));
        let failed = false,
          count = 0,
          expanded = 0;
        const seen = new Set(),
          links = [];
        const fail = (cause) => {
          if (failed) return;
          failed = true;
          zip.close();
          reject(
            cause?.status ? cause : bad(serverMessages.tools.chromiumArchiveInvalid),
          );
        };
        zip.on("error", fail);
        // Each link stays inside on its own; a chain of them may not. Once all are
        // there, every link must resolve to a path inside the browser's folder.
        zip.on("end", () => {
          if (failed) return;
          try {
            const inside = fs.realpathSync.native(path.join(dest, top));
            for (const link of links) {
              const real = fs.realpathSync.native(link);
              if (real !== inside && !real.startsWith(inside + path.sep))
                throw bad(serverMessages.tools.unsafeArchivePath);
            }
            resolve();
          } catch (cause) {
            reject(cause?.status ? cause : bad(serverMessages.tools.unsafeArchivePath));
          }
        });
        const read = (entry) =>
          new Promise((done, stop) =>
            zip.openReadStream(entry, (err, stream) => (err ? stop(err) : done(stream))),
          );
        zip.on("entry", async (entry) => {
          try {
            if (signal?.aborted)
              throw bad(serverMessages.tools.installationAbortedOrTimedOut);
            const relative = entryName(entry.fileName, top);
            const mode = (entry.externalFileAttributes >>> 16) & 0o177777;
            const kind = mode & 0o170000;
            const directory = entry.fileName.endsWith("/") || kind === 0o040000;
            if (entry.generalPurposeBitFlag & 1)
              throw bad(serverMessages.tools.encryptedArchivesForbidden);
            if (
              ++count > MAX_FILES ||
              (expanded += entry.uncompressedSize) > MAX_EXPANDED
            )
              throw bad(serverMessages.tools.archiveSizeExceeded);
            const key = relative.toLowerCase();
            if (seen.has(key)) throw bad(serverMessages.tools.duplicateArchivePaths);
            seen.add(key);
            const target = path.join(dest, relative);
            await realParents(dest, directory ? `${relative}/x` : relative);
            if (directory) {
              const stat = await fsp.lstat(target).catch(() => null);
              if (!stat) await fsp.mkdir(target, { mode: 0o755 });
              else if (!stat.isDirectory())
                throw bad(serverMessages.tools.unsafeArchivePath);
            } else if (kind === 0o120000) {
              if (entry.uncompressedSize > MAX_LINK)
                throw bad(serverMessages.tools.unsafeArchivePath);
              const chunks = [];
              for await (const chunk of await read(entry)) chunks.push(chunk);
              const link = Buffer.concat(chunks).toString("utf8");
              const resolved = path.posix.normalize(
                path.posix.join(path.posix.dirname(relative), link),
              );
              // Links stay relative and inside the browser's own folder.
              if (
                !link ||
                link.startsWith("/") ||
                /[\\\x00-\x1f]/.test(link) ||
                !(resolved === top || resolved.startsWith(`${top}/`))
              )
                throw bad(serverMessages.tools.unsafeArchivePath);
              await fsp.symlink(link, target);
              links.push(target);
            } else if (kind === 0o100000 || kind === 0) {
              await pipeline(
                await read(entry),
                fs.createWriteStream(target, {
                  flags: "wx",
                  mode: (mode & 0o111 ? 0o755 : 0o644) & 0o755,
                }),
                { signal },
              );
            } else throw bad(serverMessages.tools.specialArchiveFilesForbidden);
            zip.readEntry();
          } catch (cause) {
            fail(cause);
          }
        });
        zip.readEntry();
      },
    );
  });
}

/**
 * Checks that the unpacked browser can run from the agent service: on macOS the app
 * loses any quarantine attribute; on Linux every shared
 * library resolves. Then `--version` must name the pinned version.
 */
async function checkBrowser({
  directory,
  entry,
  platform,
  version,
  run,
  env,
  signal,
  userns,
}) {
  const executable = path.join(directory, entry.executable);
  if (platform === "darwin") {
    const app = path.join(directory, entry.app);
    // Downloaded by AgentPier, not a browser, so Gatekeeper never set it; cleared
    // anyway so a copy from elsewhere cannot block the service.
    await run("/usr/bin/xattr", ["-cr", app], env, directory, signal, 60000).catch(
      () => {},
    );
    // Chrome for Testing is only linker-signed (ad hoc, no sealed resources), so
    // `codesign --verify` refuses even an untouched copy; it runs all the same, which
    // the --version check below proves. The SHA-256 of the archive is the check.
  } else {
    const output = await run("ldd", [executable], env, directory, signal, 60000).catch(
      () => "",
    );
    const missing = [
      ...new Set(
        [...output.matchAll(/^\s*(\S+)\s+=>\s+not found/gm)].map((match) => match[1]),
      ),
    ];
    if (missing.length)
      throw bad(serverMessages.tools.chromiumMissingLibraries(missing.join(", ")));
  }
  const notStarting = (error) => {
    if (error?.code === "ENOSPC") throw error;
    throw bad(serverMessages.tools.chromiumNotStarting);
  };
  const output = await run(
    executable,
    ["--version"],
    env,
    directory,
    signal,
    120000,
  ).catch(notStarting);
  if (!output.includes(version)) notStarting();
  // A real, short start: --version passes even where Chrome then aborts with "No
  // usable sandbox". The sandbox is never switched off.
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), "agentpier-chromium-check-"));
  try {
    const page = await run(
      executable,
      [
        "--headless=new",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--dump-dom",
        "about:blank",
      ],
      env,
      directory,
      signal,
      60000,
    );
    if (!/<html/i.test(page)) throw Error("no page");
  } catch (error) {
    if (error?.code === "ENOSPC") throw error;
    // Ubuntu 23.10 and later restrict unprivileged user namespaces through AppArmor,
    // which Chrome's sandbox needs outside a package (docs/linux.md).
    if (platform === "linux" && userns() === "1")
      throw bad(serverMessages.tools.chromiumSandboxBlocked);
    throw bad(serverMessages.tools.chromiumNotStarting);
  } finally {
    await fsp.rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}
const appArmorUserns = () => {
  try {
    return fs
      .readFileSync("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf8")
      .trim();
  } catch {
    return null;
  }
};

/**
 * Installs or updates the managed browser below `root`: downloads and checks the
 * pinned archive, unpacks it into a new version directory, checks it starts and
 * switches the activation link to it. The previous version stays until the next
 * install, so a browser still running from it is not pulled away.
 */
export async function installChromium({
  root,
  platform = process.platform,
  arch = process.arch,
  manifest = chromiumManifest,
  fetchImpl = fetch,
  signal,
  run,
  env = process.env,
  progress,
  userns = appArmorUserns,
}) {
  const key = chromiumPlatform(platform, arch);
  const entry = key && manifest.platforms[key];
  if (!entry) throw bad(serverMessages.tools.chromiumPlatformUnavailable);
  const packages = path.join(root, ".packages");
  await fsp.mkdir(packages, { recursive: true, mode: 0o700 });
  const work = await fsp.mkdtemp(path.join(root, ".install-"));
  const directory = path.join(packages, `${packagePrefix}${randomUUID()}`);
  let published = false;
  try {
    const archive = path.join(work, "chromium.zip");
    progress?.(serverMessages.tools.chromiumDownloading(0));
    await download({ entry, file: archive, fetchImpl, signal, progress });
    progress?.(serverMessages.tools.chromiumUnpacking);
    await fsp.mkdir(directory, { mode: 0o700 });
    await unpackChromium(archive, directory, entry.executable.split("/")[0], signal);
    await fsp.rm(archive, { force: true });
    progress?.(serverMessages.tools.chromiumChecking);
    await checkBrowser({
      directory,
      entry,
      platform,
      version: manifest.version,
      run,
      env,
      signal,
      userns,
    });
    await fsp.writeFile(
      path.join(directory, record),
      JSON.stringify({
        version: manifest.version,
        platform: key,
        executable: entry.executable,
      }),
      { mode: 0o600, flag: "wx" },
    );
    const previous = managedChromium(root)?.directory;
    // The link is replaced atomically: a reader sees the old or the new version.
    const link = path.join(root, `.chromium-${randomUUID()}`);
    await fsp.symlink(path.relative(root, directory), link, "dir");
    await fsp.rename(link, chromiumActivation(root));
    published = true;
    await prunePackages(packages, [directory, previous].filter(Boolean));
    return {
      version: manifest.version,
      executable: path.join(directory, entry.executable),
    };
  } catch (error) {
    if (error?.code === "ENOSPC" || error?.cause?.code === "ENOSPC")
      throw bad(serverMessages.tools.chromiumDiskFull);
    throw error;
  } finally {
    if (!published)
      await fsp.rm(directory, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

// One process prunes at a time: the AgentPier server runs one installation job at a
// time, and the installer scripts provision before the service starts and hold the
// setup lock (setup-resume.mjs) while they do; the two never share a data directory
// concurrently.
async function prunePackages(packages, keep) {
  const kept = new Set(keep.map((dir) => path.basename(dir)));
  for (const name of await fsp.readdir(packages).catch(() => []))
    if (name.startsWith(packagePrefix) && !kept.has(name))
      await fsp.rm(path.join(packages, name), { recursive: true, force: true });
}

/**
 * What an interrupted install left behind, swept at a server start while no job
 * runs: work folders, stray activation links and version directories that were
 * never published (no record). Published versions stay.
 */
export function sweepChromium(root) {
  const entries = (directory) => {
    try {
      return fs.readdirSync(directory);
    } catch {
      return [];
    }
  };
  for (const name of entries(root))
    if (name.startsWith(".install-") || name.startsWith(".chromium-"))
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
  const packages = path.join(root, ".packages");
  for (const name of entries(packages))
    if (
      name.startsWith(packagePrefix) &&
      !fs.existsSync(path.join(packages, name, record))
    )
      fs.rmSync(path.join(packages, name), { recursive: true, force: true });
}

/** Removes the managed browser: the link and every version directory. */
export async function removeChromium(root) {
  const link = chromiumActivation(root);
  const stat = await fsp.lstat(link).catch(() => null);
  if (!stat) throw bad(serverMessages.tools.chromiumNotInstalled);
  if (!stat.isSymbolicLink())
    throw bad(serverMessages.tools.installationDirectoryInvalid);
  await fsp.unlink(link);
  await prunePackages(path.join(root, ".packages"), []);
}
