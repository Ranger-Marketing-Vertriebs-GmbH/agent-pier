import { serverMessages } from "../../lib/i18n/de.js";
import path from "node:path";
import { fromBuffer } from "yauzl";
import { parseDocument } from "yaml";
import { problem } from "../../lib/storage.js";
export const MAX_UPLOAD = 10 * 1024 * 1024;
const MAX_EXPANDED = 20 * 1024 * 1024;
export const skillName = (value) =>
  typeof value === "string" &&
  value.length <= 64 &&
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) &&
  value !== "synced";
export function skillMetadata(buffer) {
  if (buffer.length > 256 * 1024)
    throw problem(serverMessages.extensions.skillDocumentTooLarge);
  const text = buffer.toString("utf8");
  const match = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw problem(serverMessages.extensions.skillFrontmatterRequired);
  let metadata;
  try {
    const doc = parseDocument(match[1], { uniqueKeys: true });
    if (doc.errors.length) throw new Error();
    metadata = doc.toJS({ maxAliasCount: 0 });
  } catch {
    throw problem(serverMessages.extensions.invalidSkillFrontmatter);
  }
  if (
    !skillName(metadata?.name) ||
    typeof metadata?.description !== "string" ||
    !metadata.description.trim() ||
    metadata.description.length > 1024 ||
    /[\x00-\x1f\x7f]/.test(metadata.name)
  )
    throw problem(serverMessages.extensions.invalidSkillIdentity);
  return { name: metadata.name, description: metadata.description.trim() };
}
function archivePath(value) {
  if (
    !value ||
    value.length > 1000 ||
    /[\\\x00-\x1f\x7f]/.test(value) ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value.split("/").some((part) => part === "." || part === "..")
  )
    throw problem(serverMessages.extensions.unsafeZipPath);
  return value;
}
export async function unpackSkill(buffer, subpath = "") {
  if (buffer.length > MAX_UPLOAD)
    throw problem(serverMessages.extensions.skillZipTooLarge);
  const entries = await new Promise((resolve, reject) => {
    fromBuffer(
      buffer,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, archive) => {
        if (error) return reject(problem(serverMessages.extensions.skillZipUnreadable));
        const files = new Map();
        let size = 0;
        let count = 0;
        let failed = false;
        const fail = (error) => {
          if (failed) return;
          failed = true;
          archive.close();
          reject(
            error.status ? error : problem(serverMessages.extensions.skillZipCorrupt),
          );
        };
        archive.on("error", fail);
        archive.on("end", () => {
          if (!failed) resolve(files);
        });
        archive.on("entry", (entry) => {
          try {
            const name = archivePath(entry.fileName);
            if (++count > 1000)
              throw problem(serverMessages.extensions.skillFileCountExceeded);
            const kind = (entry.externalFileAttributes >>> 16) & 0o170000;
            if (kind && kind !== 0o100000 && kind !== 0o040000)
              throw problem(serverMessages.extensions.specialSkillFilesForbidden);
            if (entry.generalPurposeBitFlag & 1)
              throw problem(serverMessages.extensions.encryptedSkillZipUnsupported);
            size += entry.uncompressedSize;
            if (size > MAX_EXPANDED)
              throw problem(serverMessages.extensions.extractedSkillTooLarge);
            if (name.endsWith("/")) {
              archive.readEntry();
              return;
            }
            if (
              files.has(name) ||
              [...files.keys()].some((key) => key.toLowerCase() === name.toLowerCase())
            )
              throw problem(serverMessages.extensions.duplicateSkillZipPaths);
            archive.openReadStream(entry, (error, stream) => {
              if (error) return fail(error);
              const chunks = [];
              let actual = 0;
              stream.on("data", (chunk) => {
                actual += chunk.length;
                if (actual > entry.uncompressedSize || actual > MAX_EXPANDED) {
                  stream.destroy();
                  fail(problem(serverMessages.extensions.skillZipSizeMismatch));
                } else chunks.push(chunk);
              });
              stream.on("error", fail);
              stream.on("end", () => {
                if (!failed) {
                  files.set(name, {
                    data: Buffer.concat(chunks),
                    mode: (entry.externalFileAttributes >>> 16) & 0o111 ? 0o700 : 0o600,
                  });
                  archive.readEntry();
                }
              });
            });
          } catch (error) {
            fail(error);
          }
        });
        archive.readEntry();
      },
    );
  });
  let candidates = [...entries.keys()].filter(
    (name) => path.posix.basename(name) === "SKILL.md",
  );
  if (subpath)
    candidates = candidates.filter(
      (name) => name.split("/").slice(1).join("/") === `${subpath}/SKILL.md`,
    );
  if (candidates.length !== 1)
    throw problem(serverMessages.extensions.singleSkillRequired);
  const prefix = candidates[0].slice(0, -"SKILL.md".length);
  const files = [...entries]
    .filter(([name]) => name.startsWith(prefix))
    .map(([name, value]) => [name.slice(prefix.length), value.data, value.mode]);
  for (const [name] of files)
    if (
      name
        .split("/")
        .some((part) =>
          [".git", ".claude-plugin", ".codex-plugin", ".mcp.json"].includes(part),
        )
    )
      throw problem(serverMessages.extensions.skillConfigurationForbidden);
  return { ...skillMetadata(entries.get(candidates[0]).data), files };
}
function trustedURL(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw problem(serverMessages.extensions.publicSkillSourceRequired);
  }
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    /[\\\s\x00-\x1f\x7f]/.test(value) ||
    url.protocol !== "https:" ||
    !["github.com", "codeload.github.com"].includes(url.host) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw problem(serverMessages.extensions.skillDownloadHostRestricted);
  return url;
}
export async function downloadSkill(value, fetchImpl, signal) {
  let url = trustedURL(value);
  let subpath = "";
  const parts = url.pathname
    .split("/")
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        throw problem(serverMessages.extensions.invalidGithubLink);
      }
    });
  if (
    parts.some(
      (part) => !part || part === "." || part === ".." || /[\\\x00-\x1f\x7f]/.test(part),
    )
  )
    throw problem(serverMessages.extensions.invalidGithubLink);
  if (url.host === "github.com") {
    if (parts.length >= 4 && parts[2] === "tree") {
      subpath = parts.slice(4).join("/");
      if (subpath) archivePath(subpath);
      url = new URL(
        `https://codeload.github.com/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}/zip/refs/heads/${encodeURIComponent(parts[3])}`,
      );
    } else if (parts.length === 2)
      url = new URL(
        `https://codeload.github.com/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}/zip/HEAD`,
      );
    else if (!(
      parts.length >= 4 &&
      parts[2] === "archive" &&
      parts.at(-1).endsWith(".zip")
    ))
      throw problem(serverMessages.extensions.githubSkillLinkRequired);
  } else if (parts.length < 4 || parts[2] !== "zip")
    throw problem(serverMessages.extensions.githubZipLinkRequired);
  for (let redirects = 0; redirects <= 3; redirects++) {
    let response;
    try {
      response = await fetchImpl(url, {
        redirect: "manual",
        signal,
        headers: { Accept: "application/zip", "User-Agent": "AgentPier" },
      });
    } catch {
      throw problem(serverMessages.extensions.skillDownloadTimedOut, 502);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw problem(serverMessages.extensions.invalidGithubRedirect);
      url = trustedURL(new URL(location, url).href);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw problem(serverMessages.extensions.skillDownloadFailed, 502);
    }
    if (Number(response.headers.get("content-length")) > MAX_UPLOAD) {
      await response.body?.cancel();
      throw problem(serverMessages.extensions.skillZipTooLarge);
    }
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > MAX_UPLOAD) throw problem(serverMessages.extensions.skillZipTooLarge);
        chunks.push(chunk);
      }
    } catch (error) {
      throw error.status
        ? error
        : problem(serverMessages.common.githubDownloadInterrupted, 502);
    }
    return unpackSkill(Buffer.concat(chunks), subpath);
  }
  throw problem(serverMessages.extensions.skillDownloadRedirectLimit);
}
