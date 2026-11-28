import fs from "node:fs";
import fsp from "node:fs/promises";
import { createHash } from "node:crypto";

/*
 * Resumable downloads of pinned files: used for the embedding assets of the agent
 * runtime (prefix EMBEDDING) and for the Android SDK components (prefix DEVICES).
 * Every failure carries a stable `code` that starts with the caller's prefix.
 */
const failure = (code, message = code) => Object.assign(Error(message), { code });
// Bytes without progress before a transfer is given up and resumed.
const idleMs = 30000;

function regularFile(file) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() ? stat : null;
  } catch {
    return null;
  }
}

async function sha256Of(file, hash = createHash("sha256")) {
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash;
}

/**
 * Downloads `url` to `file` through `<file>.partial`, which a later call continues
 * with a range request: the bytes already there are hashed again, and only a file
 * with the pinned `size` and `sha256` is renamed into place. HTTPS only, redirects
 * followed by hand (at most five); with `hosts`, every hop, a redirect's target
 * included, must be on one of those hosts. `onProgress({ received, total })` hears
 * each chunk. Rejects with a stable `code` (`<prefix>_DOWNLOAD_FAILED`,
 * `_DOWNLOAD_STALLED`, `_DOWNLOAD_CANCELLED` or `_CHECKSUM_MISMATCH`); bytes that are
 * not the pinned file (another
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
  prefix = "EMBEDDING",
  hosts = null,
}) {
  const code = (name) => `${prefix}_${name}`;
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
      () => controller.abort(failure(code("DOWNLOAD_STALLED"))),
      timeoutMs,
    );
  };
  let handle;
  try {
    arm();
    let target = url,
      response;
    for (let redirect = 0; ; redirect++) {
      const hop = new URL(target);
      if (hop.protocol !== "https:" || (hosts && !hosts.includes(hop.hostname)))
        throw failure(code("DOWNLOAD_FAILED"));
      response = await fetchImpl(target, {
        signal: controller.signal,
        redirect: "manual",
        ...(offset ? { headers: { range: `bytes=${offset}-` } } : {}),
      });
      arm();
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (redirect >= 5 || !location) throw failure(code("DOWNLOAD_FAILED"));
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
      throw Object.assign(failure(code("DOWNLOAD_FAILED")), {
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
      throw failure(code("DOWNLOAD_FAILED"));
    if (received !== size || hash.digest("hex") !== sha256) {
      // Never resumed: these bytes are not the pinned file.
      await fsp.rm(partial, { force: true });
      throw failure(code("CHECKSUM_MISMATCH"));
    }
    await fsp.rename(partial, file);
  } catch (error) {
    if (controller.signal.aborted) {
      // Our own stall failure, or the caller's stop (whatever its reason is).
      const reason = controller.signal.reason;
      throw reason?.code === code("DOWNLOAD_STALLED")
        ? reason
        : failure(code("DOWNLOAD_CANCELLED"));
    }
    throw error?.code?.startsWith?.(`${prefix}_`)
      ? error
      : failure(code("DOWNLOAD_FAILED"));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    await handle?.close().catch(() => {});
  }
}

/**
 * downloadPinned with further attempts (three in all by default) after a transfer
 * that broke off or stalled; each continues the partial file.
 */
export async function downloadResumed(options, attempts = 3) {
  const prefix = options.prefix ?? "EMBEDDING";
  for (let attempt = 1; ; attempt++) {
    try {
      return await downloadPinned(options);
    } catch (error) {
      const again = [`${prefix}_DOWNLOAD_FAILED`, `${prefix}_DOWNLOAD_STALLED`];
      if (attempt >= attempts || !again.includes(error.code) || options.signal?.aborted)
        throw error;
    }
  }
}

/** Rejects with `code` unless the file system of `directory` has `bytes` free. */
export async function requireSpace(directory, bytes, code) {
  let free;
  try {
    const stat = await fsp.statfs(directory);
    free = Number(stat.bavail) * Number(stat.bsize);
  } catch {
    // A file system that does not report its space is not refused.
    return;
  }
  if (free < bytes) throw failure(code);
}
