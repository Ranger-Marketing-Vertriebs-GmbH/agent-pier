import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readJSON, writePrivate } from "../../../../lib/storage.js";
import { privateFolder } from "../../runtime-paths.js";
import { runtimeManifest } from "./runtime-manifest.js";

/*
 * What local memory embeddings need beside the locked plugin (runtime-manifest.js
 * `embeddingPlugin`): the llama.cpp server the plugin starts and the embedding model
 * it loads. Both are pinned in the manifest by URL, size and SHA-256 and kept below
 * `<data>/assistants/embeddings/`, outside Git, the agents' workspaces, the update
 * snapshot and host backups (they are downloads, not data):
 *
 *   embeddings/llama.cpp/<release>-<platform>-<arch>/llama-server (+ receipt.json)
 *   embeddings/models/<model file> (+ <model file>.json, its receipt)
 *
 * The server (11 to 17 MB) is installed with the runtime (the installer and the
 * update path, runtime-provisioning.js) and again when the owner switches semantic
 * memory search on; the model (about 329 MB) only then. The Gateway is compiled with
 * both paths and never downloads either (openclaw-config/semantic-memory.js).
 */
const executeFile = promisify(execFile);
const failure = (code, message = code) => Object.assign(Error(message), { code });
// Bytes without progress before a transfer is given up and resumed.
const idleMs = 30000;
// A server start may wait for macOS's first-run check of a new executable.
const versionTimeoutMs = 120000;

/** Where the embedding assets of data directory root `root` (`<data>/assistants`) live. */
export function embeddingPaths(
  root,
  manifest = runtimeManifest,
  { platform = process.platform, arch = process.arch } = {},
) {
  const base = path.join(root, "embeddings");
  const target = `${platform}-${arch}`;
  const serverDirectory = path.join(
    base,
    "llama.cpp",
    `${manifest.embeddingServer.release}-${target}`,
  );
  const models = path.join(base, "models");
  return {
    base,
    target,
    serverDirectory,
    command: path.join(serverDirectory, "llama-server"),
    models,
    model: path.join(models, manifest.embeddingModel.file),
    // The router preset the plugin writes for the server it starts.
    preset: path.join(base, "llama-models.ini"),
    // The server's pid, written by its start wrapper (semantic-memory.js compile).
    pidFile: path.join(base, "llama-server.pid"),
  };
}

function regularFile(file) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() ? stat : null;
  } catch {
    return null;
  }
}

/** Why this host cannot run the pinned server at all, as a stable code, or null. */
export function embeddingPlatformProblem(
  manifest = runtimeManifest,
  { platform = process.platform, arch = process.arch } = {},
) {
  return manifest.embeddingServer?.archives?.[`${platform}-${arch}`]
    ? null
    : "EMBEDDING_PLATFORM_UNSUPPORTED";
}

/**
 * The installed server below `root`: `{ command }` when its receipt names the pinned
 * archive and the executable is a regular file, else null. Nothing is downloaded.
 */
export function installedEmbeddingServer(root, manifest = runtimeManifest, host) {
  const paths = embeddingPaths(root, manifest, host);
  const archive = manifest.embeddingServer.archives[paths.target];
  if (!archive) return null;
  try {
    const receipt = readJSON(path.join(paths.serverDirectory, "receipt.json"), null);
    if (receipt?.sha256 !== archive.sha256 || !regularFile(paths.command)) return null;
    return { command: paths.command };
  } catch {
    return null;
  }
}

/**
 * The downloaded model below `root`: `{ path }` when its receipt names the pinned
 * digest and the file has the pinned size, else null. The digest itself is checked
 * when the file is downloaded and before each index rebuild (verifyEmbeddingModel).
 */
export function installedEmbeddingModel(root, manifest = runtimeManifest) {
  const paths = embeddingPaths(root, manifest);
  const pin = manifest.embeddingModel;
  try {
    const receipt = readJSON(`${paths.model}.json`, null);
    const stat = regularFile(paths.model);
    if (receipt?.sha256 !== pin.sha256 || stat?.size !== pin.size) return null;
    return { path: paths.model };
  } catch {
    return null;
  }
}

async function sha256Of(file, hash = createHash("sha256")) {
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash;
}

/** Whether the installed model's bytes still have the pinned SHA-256. */
export async function verifyEmbeddingModel(root, manifest = runtimeManifest) {
  const installed = installedEmbeddingModel(root, manifest);
  if (!installed) return false;
  try {
    return (
      (await sha256Of(installed.path)).digest("hex") === manifest.embeddingModel.sha256
    );
  } catch {
    return false;
  }
}

/**
 * Downloads `url` to `file` through `<file>.partial`, which a later call continues
 * with a range request: the bytes already there are hashed again, and only a file
 * with the pinned `size` and `sha256` is renamed into place. HTTPS only, redirects
 * followed by hand (at most five). `onProgress({ received, total })` hears each
 * chunk. Rejects with a stable `code`; bytes that are not the pinned file (another
 * digest, more bytes, or fewer with nothing left to fetch) remove the partial file,
 * any other failure, a transfer that ended early included, keeps it for the next
 * attempt.
 */
export async function downloadPinned({
  url,
  file,
  size,
  sha256,
  fetchImpl = fetch,
  onProgress = () => {},
  signal,
  timeoutMs = idleMs,
}) {
  const partial = `${file}.partial`;
  let offset = regularFile(partial)?.size || 0;
  if (offset > size) {
    await fsp.rm(partial, { force: true });
    offset = 0;
  }
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => controller.abort(failure("EMBEDDING_DOWNLOAD_STALLED")),
      timeoutMs,
    );
  };
  let handle;
  try {
    arm();
    let target = url,
      response;
    for (let redirect = 0; ; redirect++) {
      if (new URL(target).protocol !== "https:")
        throw failure("EMBEDDING_DOWNLOAD_FAILED");
      response = await fetchImpl(target, {
        signal: controller.signal,
        redirect: "manual",
        ...(offset ? { headers: { range: `bytes=${offset}-` } } : {}),
      });
      arm();
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (redirect >= 5 || !location) throw failure("EMBEDDING_DOWNLOAD_FAILED");
      target = new URL(location, target).href;
    }
    // A range the server cannot serve (the partial file already holds everything, or
    // more than the file has): the bytes on disk are checked as they are.
    if (response.status === 416) await response.body?.cancel();
    else if (response.status === 200) offset = 0;
    else if (
      response.status !== 206 ||
      !new RegExp(`^bytes ${offset}-`).test(response.headers.get("content-range") || "")
    ) {
      await response.body?.cancel();
      throw Object.assign(failure("EMBEDDING_DOWNLOAD_FAILED"), {
        upstreamStatus: response.status,
      });
    }
    const hash = createHash("sha256");
    if (offset) await sha256Of(partial, hash);
    let received = offset;
    onProgress({ received, total: size });
    if (response.status !== 416 && response.body) {
      handle = await fsp.open(partial, offset ? "a" : "w", 0o600);
      for await (const chunk of response.body) {
        arm();
        received += chunk.length;
        if (received > size) break;
        hash.update(chunk);
        await handle.write(chunk);
        onProgress({ received, total: size });
      }
      await handle.sync();
      await handle.close();
      handle = null;
    }
    // A transfer that ended early keeps its part: the next attempt continues it.
    if (received < size && response.status !== 416)
      throw failure("EMBEDDING_DOWNLOAD_FAILED");
    if (received !== size || hash.digest("hex") !== sha256) {
      // Never resumed: these bytes are not the pinned file.
      await fsp.rm(partial, { force: true });
      throw failure("EMBEDDING_CHECKSUM_MISMATCH");
    }
    await fsp.rename(partial, file);
  } catch (error) {
    if (controller.signal.aborted) {
      // Our own stall failure, or the caller's stop (whatever its reason is).
      const reason = controller.signal.reason;
      throw reason?.code === "EMBEDDING_DOWNLOAD_STALLED"
        ? reason
        : failure("EMBEDDING_DOWNLOAD_CANCELLED");
    }
    throw error?.code?.startsWith?.("EMBEDDING_")
      ? error
      : failure("EMBEDDING_DOWNLOAD_FAILED");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    await handle?.close().catch(() => {});
  }
}

// One more attempt after a transfer that broke off; it continues the partial file.
async function downloadResumed(options, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await downloadPinned(options);
    } catch (error) {
      const again = ["EMBEDDING_DOWNLOAD_FAILED", "EMBEDDING_DOWNLOAD_STALLED"];
      if (attempt >= attempts || !again.includes(error.code) || options.signal?.aborted)
        throw error;
    }
  }
}

async function requireSpace(directory, bytes) {
  let free;
  try {
    const stat = await fsp.statfs(directory);
    free = Number(stat.bavail) * Number(stat.bsize);
  } catch {
    // A file system that does not report its space is not refused.
    return;
  }
  if (free < bytes) throw failure("EMBEDDING_DISK_SPACE");
}

const jobs = new Map();
const once = (key, run) => {
  if (!jobs.has(key))
    jobs.set(
      key,
      run().finally(() => jobs.delete(key)),
    );
  return jobs.get(key);
};

/**
 * Installs the pinned llama.cpp server below `root` unless it is there: downloads
 * the release archive for this platform, checks size and SHA-256, unpacks it, runs
 * `llama-server --version` and requires the pinned build. Resolves `{ command }`;
 * rejects with a stable `code` (EMBEDDING_PLATFORM_UNSUPPORTED, EMBEDDING_DOWNLOAD_*,
 * EMBEDDING_CHECKSUM_MISMATCH, EMBEDDING_DISK_SPACE or EMBEDDING_SERVER_UNUSABLE:
 * the host lacks a library the build needs, such as libgomp or OpenSSL 3 on Linux).
 * `download(url)`, when given, resolves the whole archive as a Buffer instead (the
 * runtime installer's downloader); its bytes are checked the same way.
 */
export function ensureEmbeddingServer({
  root,
  manifest = runtimeManifest,
  platform = process.platform,
  arch = process.arch,
  fetchImpl = fetch,
  download,
  execute = executeFile,
  onProgress,
  signal,
}) {
  const host = { platform, arch };
  const installed = installedEmbeddingServer(root, manifest, host);
  if (installed) return Promise.resolve(installed);
  const paths = embeddingPaths(root, manifest, host);
  const pin = manifest.embeddingServer;
  const archive = pin.archives[paths.target];
  if (!archive) return Promise.reject(failure("EMBEDDING_PLATFORM_UNSUPPORTED"));
  return once(paths.serverDirectory, async () => {
    const parent = privateFolder(path.dirname(paths.serverDirectory));
    const stage = privateFolder(path.join(parent, `.stage-${randomUUID()}`));
    try {
      await requireSpace(parent, archive.size * 5);
      const file = path.join(stage, archive.name);
      if (download) {
        const bytes = await download(pin.baseUrl + archive.name);
        if (
          bytes.length !== archive.size ||
          createHash("sha256").update(bytes).digest("hex") !== archive.sha256
        )
          throw failure("EMBEDDING_CHECKSUM_MISMATCH");
        await fsp.writeFile(file, bytes, { mode: 0o600 });
      } else
        await downloadResumed({
          url: pin.baseUrl + archive.name,
          file,
          size: archive.size,
          sha256: archive.sha256,
          fetchImpl,
          onProgress,
          signal,
        });
      const unpacked = privateFolder(path.join(stage, "server"));
      const command = path.join(unpacked, "llama-server");
      try {
        await execute("tar", ["-xzf", file, "-C", unpacked, "--strip-components=1"], {
          timeout: 120000,
          maxBuffer: 65536,
        });
        if (!regularFile(command)) throw Error("no server");
        const { stdout = "", stderr = "" } = await execute(command, ["--version"], {
          timeout: versionTimeoutMs,
          maxBuffer: 65536,
        });
        const build = /\(build (\d+), commit ([a-f\d]+)\)/.exec(`${stdout}\n${stderr}`);
        if (
          `b${build?.[1]}` !== pin.release ||
          !build[2] ||
          !pin.commit.startsWith(build[2])
        )
          throw Error("another build");
      } catch {
        throw failure("EMBEDDING_SERVER_UNUSABLE");
      }
      writePrivate(path.join(unpacked, "receipt.json"), {
        release: pin.release,
        sha256: archive.sha256,
      });
      await fsp.rm(paths.serverDirectory, { recursive: true, force: true });
      await fsp.rename(unpacked, paths.serverDirectory);
      return { command: paths.command };
    } finally {
      await fsp.rm(stage, { recursive: true, force: true });
    }
  });
}

/**
 * Downloads the pinned embedding model below `root` unless it is there, continuing a
 * partial download of an earlier attempt. Resolves `{ path }`; rejects with a stable
 * `code` as ensureEmbeddingServer does.
 */
export function ensureEmbeddingModel({
  root,
  manifest = runtimeManifest,
  fetchImpl = fetch,
  onProgress,
  signal,
}) {
  const installed = installedEmbeddingModel(root, manifest);
  if (installed) return Promise.resolve(installed);
  const paths = embeddingPaths(root, manifest);
  const pin = manifest.embeddingModel;
  return once(paths.model, async () => {
    privateFolder(paths.base);
    privateFolder(paths.models);
    const have = regularFile(`${paths.model}.partial`)?.size || 0;
    await requireSpace(paths.models, pin.size - Math.min(have, pin.size) + 64 * 2 ** 20);
    // A file without its receipt is no verified download: it is fetched again.
    await fsp.rm(paths.model, { force: true });
    await downloadResumed({
      url: pin.url,
      file: paths.model,
      size: pin.size,
      sha256: pin.sha256,
      fetchImpl,
      onProgress,
      signal,
    });
    writePrivate(`${paths.model}.json`, { sha256: pin.sha256, size: pin.size });
    return { path: paths.model };
  });
}

/** Removes the installed server, so the next ensureEmbeddingServer installs it anew. */
export async function removeEmbeddingServer(root, manifest = runtimeManifest, host) {
  const { serverDirectory } = embeddingPaths(root, manifest, host);
  await fsp.rm(serverDirectory, { recursive: true, force: true });
}

/**
 * Removes the downloaded model, and a partial download unless `partial` is false;
 * the server stays.
 */
export async function removeEmbeddingModel(
  root,
  manifest = runtimeManifest,
  { partial = true } = {},
) {
  const { model } = embeddingPaths(root, manifest);
  for (const file of [model, `${model}.json`, ...(partial ? [`${model}.partial`] : [])])
    await fsp.rm(file, { force: true });
}
