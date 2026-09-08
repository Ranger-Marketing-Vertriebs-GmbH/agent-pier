import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { fromBuffer } from "yauzl";
import { problem } from "../../lib/storage.js";
const MAX_DOWNLOAD = 64 * 1024 * 1024,
  MAX_EXPANDED = 128 * 1024 * 1024,
  MAX_FILES = 5000;
const api = "https://api.github.com/repos/cli/cli/releases/latest";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const bad = (message) => problem(message, 409);
function abort(signal) {
  if (signal?.aborted) throw bad(serverMessages.tools.installationAbortedOrTimedOut);
}
function releaseURL(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw bad(serverMessages.tools.invalidGithubRedirect);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    ![
      "github.com",
      "release-assets.githubusercontent.com",
      "objects.githubusercontent.com",
    ].includes(url.hostname)
  )
    throw bad(serverMessages.tools.forbiddenGithubRedirect);
  if (
    url.hostname === "github.com" &&
    !url.pathname.startsWith("/cli/cli/releases/download/")
  )
    throw bad(serverMessages.tools.invalidGithubRedirect);
  return url;
}
async function download(url, limit, fetchImpl, signal, { metadata = false } = {}) {
  for (let redirects = 0; redirects <= 3; redirects++) {
    abort(signal);
    let response;
    try {
      response = await fetchImpl(url, {
        redirect: "manual",
        credentials: "omit",
        signal,
        headers: {
          Accept: metadata ? "application/vnd.github+json" : "application/octet-stream",
          "User-Agent": "AgentPier",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
    } catch {
      abort(signal);
      throw bad(serverMessages.tools.publicDownloadFailed);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      if (metadata || redirects === 3)
        throw bad(serverMessages.tools.unexpectedGithubRedirect);
      const location = response.headers.get("location");
      if (!location) throw bad(serverMessages.tools.invalidGithubRedirect);
      url = releaseURL(new URL(location, url).href);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw bad(serverMessages.tools.downloadHttpFailed(response.status));
    }
    if (Number(response.headers.get("content-length")) > limit) {
      await response.body?.cancel();
      throw bad(serverMessages.tools.downloadTooLarge);
    }
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of response.body) {
        abort(signal);
        size += chunk.length;
        if (size > limit) throw bad(serverMessages.tools.downloadTooLarge);
        chunks.push(chunk);
      }
    } catch (error) {
      abort(signal);
      throw error.status ? error : bad(serverMessages.common.githubDownloadInterrupted);
    }
    return Buffer.concat(chunks);
  }
  throw bad(serverMessages.tools.githubRedirectLimit);
}
function archiveName(name, root) {
  if (
    typeof name !== "string" ||
    name.length > 1024 ||
    /[\\\x00-\x1f\x7f]/.test(name) ||
    name.startsWith("/") ||
    name.split("/").some((part) => part === "." || part === "..") ||
    !(name === root || name.startsWith(root + "/"))
  )
    throw bad(serverMessages.tools.unsafeArchivePath);
  return name.slice(root.length).replace(/^\//, "").replace(/\/$/, "");
}
function archiveTracker(root) {
  let size = 0,
    count = 0;
  const seen = new Set();
  return (name, bytes, kind) => {
    const relative = archiveName(name, root);
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      ++count > MAX_FILES ||
      (size += bytes) > MAX_EXPANDED
    )
      throw bad(serverMessages.tools.archiveSizeExceeded);
    if (kind !== "file" && kind !== "directory")
      throw bad(serverMessages.tools.specialArchiveFilesForbidden);
    const key = relative.toLowerCase();
    if (seen.has(key)) throw bad(serverMessages.tools.duplicateArchivePaths);
    seen.add(key);
    return relative;
  };
}
async function unzip(buffer, root, signal) {
  return new Promise((resolve, reject) => {
    fromBuffer(
      buffer,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, zip) => {
        if (error) return reject(bad(serverMessages.tools.invalidZipArchive));
        const files = new Map(),
          track = archiveTracker(root);
        let failed = false;
        const fail = (error) => {
          if (failed) return;
          failed = true;
          zip.close();
          reject(error.status ? error : bad(serverMessages.tools.invalidZipArchive));
        };
        zip.on("error", fail);
        zip.on("end", () => {
          if (!failed) resolve(files);
        });
        zip.on("entry", (entry) => {
          try {
            abort(signal);
            const kind = (entry.externalFileAttributes >>> 16) & 0o170000;
            const directory = entry.fileName.endsWith("/");
            if (entry.generalPurposeBitFlag & 1)
              throw bad(serverMessages.tools.encryptedArchivesForbidden);
            if (kind && kind !== (directory ? 0o040000 : 0o100000))
              throw bad(serverMessages.tools.specialArchiveFilesForbidden);
            const relative = track(
              entry.fileName,
              entry.uncompressedSize,
              directory ? "directory" : "file",
            );
            if (directory || !["bin/gh", "LICENSE"].includes(relative)) {
              zip.readEntry();
              return;
            }
            zip.openReadStream(entry, (error, stream) => {
              if (error) return fail(error);
              let size = 0;
              const chunks = [];
              stream.on("data", (chunk) => {
                try {
                  abort(signal);
                  size += chunk.length;
                  if (size > entry.uncompressedSize || size > MAX_EXPANDED)
                    throw bad(serverMessages.tools.archiveSizeExceeded);
                  chunks.push(chunk);
                } catch (error) {
                  stream.destroy();
                  fail(error);
                }
              });
              stream.on("error", fail);
              stream.on("end", () => {
                if (!failed) {
                  files.set(relative, Buffer.concat(chunks));
                  zip.readEntry();
                }
              });
            });
          } catch (error) {
            fail(error);
          }
        });
        zip.readEntry();
      },
    );
  });
}
function octal(buffer) {
  const value = buffer.toString("ascii").replace(/\0.*$/s, "").trim();
  if (!/^[0-7]*$/.test(value)) throw bad(serverMessages.tools.invalidTarSize);
  const number = parseInt(value || "0", 8);
  if (!Number.isSafeInteger(number)) throw bad(serverMessages.tools.tarTooLarge);
  return number;
}
function paxFields(buffer) {
  if (buffer.length > 64 * 1024) throw bad(serverMessages.tools.tarMetadataTooLarge);
  const values = {};
  for (let offset = 0; offset < buffer.length;) {
    const space = buffer.indexOf(32, offset);
    if (space < 0 || space - offset > 8) throw bad(serverMessages.tools.invalidPaxData);
    const length = Number(buffer.toString("ascii", offset, space));
    if (
      !Number.isSafeInteger(length) ||
      length <= space - offset + 2 ||
      offset + length > buffer.length ||
      buffer[offset + length - 1] !== 10
    )
      throw bad(serverMessages.tools.invalidPaxData);
    const record = buffer.toString("utf8", space + 1, offset + length - 1);
    const equals = record.indexOf("=");
    const key = record.slice(0, equals);
    if (
      equals < 1 ||
      Object.hasOwn(values, key) ||
      ![
        "path",
        "mtime",
        "atime",
        "ctime",
        "uid",
        "gid",
        "uname",
        "gname",
        "comment",
      ].includes(key)
    )
      throw bad(serverMessages.tools.unsupportedPaxData);
    values[key] = record.slice(equals + 1);
    offset += length;
  }
  return values;
}
async function untar(buffer, root, signal) {
  let data;
  try {
    data = await promisify(gunzip)(buffer, { maxOutputLength: MAX_EXPANDED });
  } catch {
    throw bad(serverMessages.tools.invalidOrOversizedTar);
  }
  abort(signal);
  const files = new Map(),
    track = archiveTracker(root);
  let extended = null,
    ended = false,
    headers = 0;
  for (let offset = 0; offset + 512 <= data.length;) {
    abort(signal);
    if (++headers > MAX_FILES * 2) throw bad(serverMessages.tools.archiveEntryLimit);
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (data.subarray(offset).some((byte) => byte !== 0))
        throw bad(serverMessages.tools.unexpectedTarData);
      ended = true;
      break;
    }
    const sum = header.reduce(
      (total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    if (sum !== octal(header.subarray(148, 156)))
      throw bad(serverMessages.tools.invalidTarChecksum);
    const string = (start, end) =>
      header.subarray(start, end).toString("utf8").replace(/\0.*$/s, "");
    const prefix = string(345, 500);
    let name = (prefix ? prefix + "/" : "") + string(0, 100);
    const size = octal(header.subarray(124, 136));
    const kind = String.fromCharCode(header[156]);
    const start = offset + 512,
      end = start + size;
    if (size > MAX_EXPANDED || end > data.length)
      throw bad(serverMessages.tools.incompleteOrOversizedTar);
    offset = start + Math.ceil(size / 512) * 512;
    if (kind === "x") {
      if (extended) throw bad(serverMessages.tools.duplicatePaxData);
      extended = paxFields(data.subarray(start, end));
      continue;
    }
    if (extended?.path) name = extended.path;
    extended = null;
    const relative = track(
      name,
      size,
      kind === "5" ? "directory" : kind === "0" || kind === "\0" ? "file" : "special",
    );
    if (["bin/gh", "LICENSE"].includes(relative)) {
      if (kind === "5") throw bad(serverMessages.tools.archiveCliNotRegular);
      files.set(relative, Buffer.from(data.subarray(start, end)));
    }
  }
  if (!ended || extended) throw bad(serverMessages.tools.incompleteTar);
  return files;
}
export async function unpackGithubRelease(buffer, format, root, signal) {
  if (buffer.length > MAX_DOWNLOAD) throw bad(serverMessages.tools.archiveTooLarge);
  const files =
    format === "zip"
      ? await unzip(buffer, root, signal)
      : await untar(buffer, root, signal);
  if (!files.get("bin/gh")?.length || !files.get("LICENSE")?.length)
    throw bad(serverMessages.tools.archiveCliOrLicenseMissing);
  return files;
}
export async function prepareGithubCli({
  prefix,
  platform,
  arch,
  fetchImpl = fetch,
  signal,
  timeout = 180000,
}) {
  if (!["darwin", "linux"].includes(platform) || !["x64", "arm64"].includes(arch))
    throw bad(serverMessages.tools.githubCliPlatformUnsupported);
  signal = AbortSignal.any(
    [signal, AbortSignal.timeout(Math.min(timeout, 180000))].filter(Boolean),
  );
  abort(signal);
  let release;
  try {
    release = JSON.parse(
      (await download(api, 1024 * 1024, fetchImpl, signal, { metadata: true })).toString(
        "utf8",
      ),
    );
  } catch (error) {
    throw error.status ? error : bad(serverMessages.tools.invalidGithubRelease);
  }
  if (
    release.draft ||
    release.prerelease ||
    !/^v\d+\.\d+\.\d+$/.test(release.tag_name) ||
    !Array.isArray(release.assets) ||
    release.assets.length > 500
  )
    throw bad(serverMessages.tools.invalidGithubRelease);
  const version = release.tag_name.slice(1),
    root = `gh_${version}_${platform === "darwin" ? "macOS" : "linux"}_${arch === "x64" ? "amd64" : "arm64"}`,
    format = platform === "darwin" ? "zip" : "tar";
  const name = `${root}.${format === "zip" ? "zip" : "tar.gz"}`,
    sumName = `gh_${version}_checksums.txt`;
  const url = (name) =>
    `https://github.com/cli/cli/releases/download/${release.tag_name}/${name}`;
  for (const wanted of [name, sumName]) {
    const matches = release.assets.filter((asset) => asset.name === wanted);
    if (
      matches.length !== 1 ||
      matches[0].browser_download_url !== url(wanted) ||
      !Number.isSafeInteger(matches[0].size) ||
      matches[0].size <= 0 ||
      matches[0].size > (wanted === name ? MAX_DOWNLOAD : 256 * 1024)
    )
      throw bad(serverMessages.tools.releasePackageMissing);
  }
  const checksums = await download(url(sumName), 256 * 1024, fetchImpl, signal);
  const matches = checksums
    .toString("utf8")
    .split(/\r?\n/)
    .map((line) => line.match(/^([a-fA-F0-9]{64})\s+\*?([^\s]+)$/))
    .filter((match) => match?.[2] === name);
  if (matches.length !== 1) throw bad(serverMessages.tools.releaseChecksumMissing);
  const buffer = await download(url(name), MAX_DOWNLOAD, fetchImpl, signal);
  if (sha(buffer) !== matches[0][1].toLowerCase())
    throw bad(serverMessages.tools.releaseChecksumMismatch);
  const files = await unpackGithubRelease(buffer, format, root, signal);
  abort(signal);
  await fs.mkdir(path.join(prefix, "bin"), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(prefix, "bin/gh"), files.get("bin/gh"), {
    mode: 0o700,
    flag: "wx",
  });
  await fs.writeFile(path.join(prefix, "LICENSE"), files.get("LICENSE"), {
    mode: 0o600,
    flag: "wx",
  });
  return { version };
}
