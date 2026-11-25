import { serverMessages } from "../../lib/i18n/de.js";
import path from "node:path";
import { fromBuffer } from "yauzl";
import { parseDocument } from "yaml";
import { problem } from "../../lib/storage.js";
import { resolveGithubHead, resolveGithubRef } from "./github-skill-ref.js";
export const MAX_UPLOAD = 10 * 1024 * 1024;
// One skill, unpacked.
export const MAX_EXPANDED = 20 * 1024 * 1024;
const MAX_SKILL_FILES = 1000;
// A downloaded source that may hold several skills (unpackSkills): the archive, its
// entries, and the skills read from it.
export const MAX_ARCHIVE = 50 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 20000;
const MAX_COLLECTION_SKILLS = 200;
const MAX_COLLECTION_BYTES = 64 * 1024 * 1024;
export const skillName = (value) =>
  typeof value === "string" &&
  value.length <= 64 &&
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) &&
  value !== "synced";
/** The parsed YAML frontmatter of a SKILL.md. */
function frontmatter(buffer) {
  if (buffer.length > 256 * 1024)
    throw problem(serverMessages.extensions.skillDocumentTooLarge);
  const text = buffer.toString("utf8");
  const match = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw problem(serverMessages.extensions.skillFrontmatterRequired);
  try {
    const doc = parseDocument(match[1], { uniqueKeys: true });
    if (doc.errors.length) throw new Error();
    return doc.toJS({ maxAliasCount: 0 });
  } catch {
    throw problem(serverMessages.extensions.invalidSkillFrontmatter);
  }
}
export function skillMetadata(buffer) {
  const metadata = frontmatter(buffer);
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
const filled = (value) =>
  Array.isArray(value)
    ? value.length > 0
    : value && typeof value === "object"
      ? Object.keys(value).length > 0
      : typeof value === "string" && value.trim() !== "";
/**
 * Whether a SKILL.md needs per-skill settings (`skills.entries.<key>.env/apiKey`):
 * its frontmatter names `metadata.openclaw.requires.env`, `.requires.config` or
 * `.primaryEnv`.
 */
export function skillRequirements(buffer) {
  const openclaw = frontmatter(buffer)?.metadata?.openclaw;
  return {
    needsSettings: Boolean(
      openclaw &&
      typeof openclaw === "object" &&
      (filled(openclaw.requires?.env) ||
        filled(openclaw.requires?.config) ||
        filled(openclaw.primaryEnv)),
    ),
  };
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
/**
 * Opens a zip and checks every entry (path, kind, encryption, duplicates) without
 * reading a file. `limits.entries` caps the entry count and `limits.expanded` the sum
 * of the declared sizes.
 */
function openArchive(buffer, limits) {
  return new Promise((resolve, reject) => {
    fromBuffer(
      buffer,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, archive) => {
        if (error) return reject(problem(serverMessages.extensions.skillZipUnreadable));
        const entries = new Map();
        const lower = new Set();
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
          if (!failed) resolve({ archive, entries });
        });
        archive.on("entry", (entry) => {
          try {
            const name = archivePath(entry.fileName);
            if (++count > limits.entries)
              throw problem(serverMessages.extensions.skillFileCountExceeded);
            const kind = (entry.externalFileAttributes >>> 16) & 0o170000;
            if (kind && kind !== 0o100000 && kind !== 0o040000)
              throw problem(serverMessages.extensions.specialSkillFilesForbidden);
            if (entry.generalPurposeBitFlag & 1)
              throw problem(serverMessages.extensions.encryptedSkillZipUnsupported);
            size += entry.uncompressedSize;
            if (size > limits.expanded)
              throw problem(serverMessages.extensions.extractedSkillTooLarge);
            if (!name.endsWith("/")) {
              if (lower.has(name.toLowerCase()))
                throw problem(serverMessages.extensions.duplicateSkillZipPaths);
              lower.add(name.toLowerCase());
              entries.set(name, entry);
            }
            archive.readEntry();
          } catch (error) {
            fail(error);
          }
        });
        archive.readEntry();
      },
    );
  });
}
/** The bytes of one entry; more than its declared size is refused. */
function readEntry(archive, entry) {
  return new Promise((resolve, reject) => {
    archive.openReadStream(entry, (error, stream) => {
      if (error) return reject(problem(serverMessages.extensions.skillZipCorrupt));
      const chunks = [];
      let actual = 0;
      stream.on("data", (chunk) => {
        actual += chunk.length;
        if (actual > entry.uncompressedSize || actual > MAX_EXPANDED) {
          stream.destroy();
          reject(problem(serverMessages.extensions.skillZipSizeMismatch));
        } else chunks.push(chunk);
      });
      stream.on("error", (error) =>
        reject(error.status ? error : problem(serverMessages.extensions.skillZipCorrupt)),
      );
      stream.on("end", () => resolve(Buffer.concat(chunks)));
    });
  });
}
/** The skill whose SKILL.md is the entry `candidate`: every file of its folder. */
async function readSkillAt(archive, entries, candidate) {
  const prefix = candidate.slice(0, -"SKILL.md".length);
  const names = [...entries.keys()].filter((name) => name.startsWith(prefix));
  if (names.length > MAX_SKILL_FILES)
    throw problem(serverMessages.extensions.skillFileCountExceeded);
  let size = 0;
  for (const name of names) size += entries.get(name).uncompressedSize;
  if (size > MAX_EXPANDED)
    throw problem(serverMessages.extensions.extractedSkillTooLarge);
  const files = [];
  for (const name of names) {
    const entry = entries.get(name);
    files.push([
      name.slice(prefix.length),
      await readEntry(archive, entry),
      (entry.externalFileAttributes >>> 16) & 0o111 ? 0o700 : 0o600,
    ]);
  }
  assertPortableSkill(files);
  const document = files.find(([name]) => name === "SKILL.md")[1];
  return { ...skillMetadata(document), files };
}
const skillDocuments = (entries) =>
  [...entries.keys()].filter((name) => path.posix.basename(name) === "SKILL.md");
/** A path without the root folder GitHub puts around a repository archive. */
const belowRoot = (name) => name.split("/").slice(1).join("/");

/** The one skill of a zip, or of the folder `subpath` of a GitHub archive. */
export async function unpackSkill(buffer, subpath = "") {
  if (buffer.length > MAX_UPLOAD)
    throw problem(serverMessages.extensions.skillZipTooLarge);
  const { archive, entries } = await openArchive(buffer, {
    entries: MAX_SKILL_FILES,
    expanded: MAX_EXPANDED,
  });
  try {
    let candidates = skillDocuments(entries);
    if (subpath)
      candidates = candidates.filter((name) => belowRoot(name) === `${subpath}/SKILL.md`);
    if (candidates.length !== 1)
      throw problem(serverMessages.extensions.singleSkillRequired);
    return await readSkillAt(archive, entries, candidates[0]);
  } finally {
    archive.close();
  }
}
/**
 * Every skill of a zip, or of a GitHub archive (`rooted`) at or below `subpath`: a list
 * of `{ folder, pack }`, or `{ folder, error }` for a skill that cannot be installed.
 * `folder` is the skill's path in the source. A SKILL.md inside another skill's folder
 * belongs to that skill. Only the files of skill folders are read, so a large archive
 * (up to MAX_ARCHIVE) costs no more than its skills.
 */
export async function unpackSkills(buffer, { subpath = "", rooted = false } = {}) {
  if (buffer.length > MAX_ARCHIVE)
    throw problem(serverMessages.extensions.skillArchiveTooLarge);
  const { archive, entries } = await openArchive(buffer, {
    entries: MAX_ARCHIVE_ENTRIES,
    expanded: Infinity,
  });
  try {
    const within = (name) => (rooted ? belowRoot(name) : name);
    const folders = skillDocuments(entries)
      .filter((name) => !subpath || within(name).startsWith(`${subpath}/`))
      .map((name) => name.slice(0, -"SKILL.md".length))
      .sort();
    const outer = folders.filter(
      (folder) => !folders.some((other) => other !== folder && folder.startsWith(other)),
    );
    if (!outer.length) throw problem(serverMessages.extensions.skillSourceEmpty);
    if (outer.length > MAX_COLLECTION_SKILLS)
      throw problem(serverMessages.extensions.skillCollectionTooLarge);
    const skills = [];
    let total = 0;
    for (const prefix of outer) {
      const folder = within(prefix).replace(/\/$/, "");
      let pack;
      try {
        pack = await readSkillAt(archive, entries, `${prefix}SKILL.md`);
      } catch (error) {
        // One skill that cannot be installed does not hide the others.
        if (!error.status || outer.length === 1) throw error;
        skills.push({ folder, error });
        continue;
      }
      total += pack.files.reduce((sum, [, data]) => sum + data.length, 0);
      if (total > MAX_COLLECTION_BYTES)
        throw problem(serverMessages.extensions.skillCollectionTooLarge);
      skills.push({ folder, pack });
    }
    return skills;
  } finally {
    archive.close();
  }
}
/** A skill carries no plugin, MCP or Git configuration of its own. */
export function assertPortableSkill(files) {
  for (const [name] of files)
    if (
      name
        .split("/")
        .some((part) =>
          [".git", ".claude-plugin", ".codex-plugin", ".mcp.json"].includes(part),
        )
    )
      throw problem(serverMessages.extensions.skillConfigurationForbidden);
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
/**
 * Downloads a GitHub link and unpacks its one skill. With `several` the source may
 * hold more than one: the result is `{ skills, origin }` (see unpackSkills), the
 * archive may be up to MAX_ARCHIVE, and a repository link is pinned to the commit of
 * its default branch, so every skill can record the folder link it came from.
 */
export async function downloadSkill(value, fetchImpl, signal, { several = false } = {}) {
  const limit = several ? MAX_ARCHIVE : MAX_UPLOAD;
  const tooLarge = () =>
    problem(
      several
        ? serverMessages.extensions.skillArchiveTooLarge
        : serverMessages.extensions.skillZipTooLarge,
    );
  const codeload = (owner, name, ref) =>
    new URL(
      `https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/zip/${ref}`,
    );
  let url = trustedURL(value);
  let subpath = "";
  let origin = null;
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
      // Branches, tags and commit SHAs all download the one commit resolved now.
      const pinned = await resolveGithubRef(
        parts[0],
        parts[1],
        parts[3],
        fetchImpl,
        signal,
      );
      origin = { kind: "github", repository: `${parts[0]}/${parts[1]}`, ...pinned };
      url = codeload(parts[0], parts[1], pinned.commit);
    } else if (parts.length === 2 && several) {
      const pinned = await resolveGithubHead(parts[0], parts[1], fetchImpl, signal);
      origin = { kind: "github", repository: `${parts[0]}/${parts[1]}`, ...pinned };
      url = codeload(parts[0], parts[1], pinned.commit);
    } else if (parts.length === 2) url = codeload(parts[0], parts[1], "HEAD");
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
    if (Number(response.headers.get("content-length")) > limit) {
      await response.body?.cancel();
      throw tooLarge();
    }
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > limit) throw tooLarge();
        chunks.push(chunk);
      }
    } catch (error) {
      throw error.status
        ? error
        : problem(serverMessages.common.githubDownloadInterrupted, 502);
    }
    const buffer = Buffer.concat(chunks);
    if (several)
      return { skills: await unpackSkills(buffer, { subpath, rooted: true }), origin };
    const pack = await unpackSkill(buffer, subpath);
    return origin ? { ...pack, origin } : pack;
  }
  throw problem(serverMessages.extensions.skillDownloadRedirectLimit);
}

/** The folder link of one skill of a pinned GitHub source, for its later update checks. */
const folderLink = (origin, folder) =>
  `https://github.com/${origin.repository}/tree/${encodeURIComponent(origin.ref)}/${folder
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
/**
 * One skill as its pack, several as `{ collection: [{ folder, pack | error }] }`. A
 * skill of a pinned GitHub source records its own folder link; without a pinned commit
 * (zip upload, archive link) it records no source and has no update check.
 */
function packOrCollection(skills, origin, url) {
  if (skills.length === 1) {
    const { pack } = skills[0];
    return {
      ...pack,
      ...(origin ? { origin } : {}),
      ...(url ? { source: { url } } : {}),
    };
  }
  return {
    collection: skills.map(({ folder, pack, error }) =>
      error
        ? { folder, error }
        : {
            folder,
            pack: origin
              ? { ...pack, origin, source: { url: folderLink(origin, folder) } }
              : pack,
          },
    ),
    ...(origin ? { origin } : {}),
  };
}

/**
 * Reads a skill source without writing anything: a GitHub link (`input.url`, downloaded
 * within 30 seconds; `pack.source` keeps the link) or an upload (`contentBase64` of a
 * SKILL.md or zip named by `fileName`). With `several` a source that holds more than
 * one skill comes back as `{ collection }` (see packOrCollection) instead of an error.
 */
export async function readSkillPack(
  input,
  { fetchImpl = globalThis.fetch, signal, several = false } = {},
) {
  if (input.url !== undefined) {
    if (input.contentBase64 !== undefined)
      throw problem(serverMessages.extensions.skillSourceRequired);
    const timeout = AbortSignal.timeout(30000);
    const pack = await downloadSkill(
      input.url,
      fetchImpl,
      signal ? AbortSignal.any([signal, timeout]) : timeout,
      { several },
    );
    if (several) return packOrCollection(pack.skills, pack.origin, input.url);
    return { ...pack, source: { url: input.url } };
  }
  if (
    typeof input.contentBase64 !== "string" ||
    input.contentBase64.length > Math.ceil(MAX_UPLOAD / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      input.contentBase64,
    )
  )
    throw problem(serverMessages.extensions.invalidSkillUpload);
  const buffer = Buffer.from(input.contentBase64, "base64");
  if (input.fileName === "SKILL.md")
    return { ...skillMetadata(buffer), files: [["SKILL.md", buffer]] };
  if (typeof input.fileName === "string" && input.fileName.toLowerCase().endsWith(".zip"))
    return several ? packOrCollection(await unpackSkills(buffer)) : unpackSkill(buffer);
  throw problem(serverMessages.extensions.skillFileTypeRequired);
}

/**
 * readSkillPack with an AbortController kept in `active` while it runs, so the owner's
 * close() can abort a download in flight and wait for it.
 */
export async function readSkillPackTracked(active, input, fetchImpl, options = {}) {
  const controller = new AbortController();
  const pending = readSkillPack(input, {
    ...options,
    fetchImpl,
    signal: controller.signal,
  });
  active.set(pending, controller);
  try {
    return await pending;
  } finally {
    active.delete(pending);
  }
}
