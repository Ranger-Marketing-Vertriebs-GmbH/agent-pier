import { serverMessages } from "../../lib/i18n/de.js";
import fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { problem } from "../../lib/storage.js";

// Downloads one pinned archive of the managed REA tool (AGENTPIER-104): HTTPS only,
// redirects followed by hand and each hop checked against a host and path allowlist,
// size and SHA-256 checked before the file counts as downloaded.
const bad = (message) => problem(message, 409);
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const maxRedirects = 3;
// Homebrew's anonymous pull token for public ghcr.io packages; it is no secret, but it
// still goes only to the registry host itself, never to the blob CDN behind it.
const ghcrHost = "ghcr.io";
const ghcrAnonymous = "Bearer QQ==";

/** The hosts and path prefixes REA downloads may come from; null allows any path. */
export const reaSources = Object.freeze({
  "ghcr.io": Object.freeze(["/v2/homebrew/core/ghidra/blobs/"]),
  "pkg-containers.githubusercontent.com": null,
  "github.com": Object.freeze([
    "/NationalSecurityAgency/ghidra/releases/download/",
    "/adoptium/temurin21-binaries/releases/download/",
    "/frida/frida/releases/download/",
  ]),
  "release-assets.githubusercontent.com": null,
  "objects.githubusercontent.com": null,
});

/** The parsed URL when it is a plain HTTPS URL on an allowed host and path, else null. */
function allowedURL(value, allow) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  if (!Object.hasOwn(allow, url.hostname)) return null;
  const prefixes = allow[url.hostname];
  if (prefixes === null) return url;
  return Array.isArray(prefixes) &&
    prefixes.some((prefix) => url.pathname.startsWith(prefix))
    ? url
    : null;
}

function validEntry(entry) {
  return (
    typeof entry?.url === "string" &&
    typeof entry.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(entry.sha256) &&
    Number.isSafeInteger(entry.size) &&
    entry.size > 0
  );
}

/** Requests `url` without following redirects; the token only reaches ghcr.io. */
async function request(url, entry, fetchImpl, signal) {
  const headers = { "User-Agent": "AgentPier" };
  if (entry.auth === "ghcr-anonymous" && url.hostname === ghcrHost)
    headers.Authorization = ghcrAnonymous;
  try {
    return await fetchImpl(url.href, {
      redirect: "manual",
      credentials: "omit",
      signal,
      headers,
    });
  } catch {
    if (signal?.aborted) throw bad(serverMessages.tools.installationAbortedOrTimedOut);
    throw bad(serverMessages.rea.downloadFailed);
  }
}

/** Follows at most three checked redirects and returns the final 2xx response. */
async function resolve(entry, allow, fetchImpl, signal) {
  let url = allowedURL(entry.url, allow);
  if (!url) throw bad(serverMessages.rea.downloadFailed);
  for (let redirects = 0; ; redirects++) {
    const response = await request(url, entry, fetchImpl, signal);
    if (redirectStatuses.has(response.status)) {
      await response.body?.cancel?.().catch(() => {});
      const location = response.headers.get("location");
      if (!location) throw bad(serverMessages.rea.downloadFailed);
      if (redirects >= maxRedirects) throw bad(serverMessages.rea.redirectLimit);
      let next;
      try {
        next = new URL(location, url).href;
      } catch {
        throw bad(serverMessages.rea.forbiddenRedirect);
      }
      url = allowedURL(next, allow);
      if (!url) throw bad(serverMessages.rea.forbiddenRedirect);
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel?.().catch(() => {});
      throw bad(serverMessages.tools.downloadHttpFailed(response.status));
    }
    return response;
  }
}

/**
 * Streams the pinned archive `entry` to the new file `file` (mode 0600, never an
 * existing one). Every hop must be HTTPS on a host and path of `allow`; the body must
 * have exactly `entry.size` bytes and the SHA-256 `entry.sha256`. `progress` gets
 * whole percents. On any failure no partial file stays behind; a full disk (ENOSPC)
 * is passed through so the caller can name it.
 */
export async function verifiedDownload({
  entry,
  file,
  allow,
  fetchImpl,
  signal,
  progress,
}) {
  if (!validEntry(entry)) throw bad(serverMessages.rea.downloadFailed);
  if (signal?.aborted) throw bad(serverMessages.tools.installationAbortedOrTimedOut);
  const response = await resolve(entry, allow, fetchImpl, signal);
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) !== entry.size) {
    await response.body.cancel?.().catch(() => {});
    throw bad(serverMessages.rea.checksumMismatch);
  }
  let handle;
  try {
    handle = await fsp.open(file, "wx", 0o600);
  } catch (error) {
    await response.body.cancel?.().catch(() => {});
    if (error.code === "ENOSPC") throw error;
    throw bad(serverMessages.rea.downloadFailed);
  }
  const hash = createHash("sha256");
  let size = 0,
    reported = -1;
  const counted = async function* (source) {
    for await (const chunk of source) {
      size += chunk.length;
      if (size > entry.size) throw bad(serverMessages.rea.checksumMismatch);
      hash.update(chunk);
      const percent = Math.floor((size / entry.size) * 100);
      if (percent !== reported) {
        reported = percent;
        progress?.(percent);
      }
      yield chunk;
    }
  };
  try {
    await pipeline(Readable.fromWeb(response.body), counted, handle.createWriteStream(), {
      signal,
    });
    if (size !== entry.size || hash.digest("hex") !== entry.sha256)
      throw bad(serverMessages.rea.checksumMismatch);
  } catch (error) {
    await handle.close().catch(() => {});
    await fsp.rm(file, { force: true }).catch(() => {});
    if (signal?.aborted) throw bad(serverMessages.tools.installationAbortedOrTimedOut);
    if (error.status || error.code === "ENOSPC") throw error;
    throw bad(serverMessages.rea.downloadFailed);
  }
}
