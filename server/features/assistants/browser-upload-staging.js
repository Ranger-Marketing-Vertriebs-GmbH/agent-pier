import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createHash, randomBytes } from "node:crypto";
import { assistantProblem } from "./assistant-validation.js";
import { projectTarget } from "./project-paths.js";
import { openInside } from "./project-open.js";

// What one staged file may be, how many one agent holds at once, how much all agents
// hold together, how long one stays, how much free space (and, on a tmpfs, memory) a
// copy leaves behind and how long one copy may take: the plugin's call waits 300 s.
export const uploadLimits = {
  maxBytes: 8 * 1024 ** 3,
  perAgent: 3,
  totalBytes: 16 * 1024 ** 3,
  ttlMs: 6 * 60 * 60 * 1000,
  reserveBytes: 1024 ** 3,
  copyMs: 270000,
};
const { O_RDONLY, O_NONBLOCK } = fs.constants;
const TMPFS_MAGIC = 0x01021994;
const unsuitable = () => assistantProblem("projectFileUnsuitable", 400);
const missing = () => assistantProblem("notFound", 404);
const noSpace = () => assistantProblem("browserUploadSpace", 507);
const darwin = process.platform === "darwin";
// Case-insensitive volumes (macOS) name one folder in any case.
const fold = (value) => (darwin ? value.toLowerCase() : value);
const real = (value) => {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return null;
  }
};

/**
 * A temp folder OpenClaw trusts (fs-safe resolveSecureTempRoot isSecureDirForUser): a
 * real directory of this user that neither its group nor others may write.
 */
export function trusted(directory) {
  try {
    const stat = fs.lstatSync(directory);
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      (!process.getuid || stat.uid === process.getuid()) &&
      (stat.mode & 0o022) === 0
    );
  } catch {
    return false;
  }
}

const fallbackDir = (tmp) => {
  const uid = process.getuid?.();
  return path.join(tmp, uid === undefined ? "openclaw" : `openclaw-${uid}`);
};
/**
 * The uploads directory OpenClaw's browser takes files from (OpenClaw 2026.10.7
 * extensions/browser paths.ts DEFAULT_UPLOAD_DIR): `<tmp>/uploads` below
 * /tmp/openclaw when that is a trusted folder of this user or can be created,
 * otherwise below `<TMPDIR>/openclaw-<uid>`, with the Gateway's TMPDIR (`tmp`).
 * Spelled as OpenClaw spells it: its check is lexical below that root. `create`
 * false only names it, without creating /tmp/openclaw.
 */
export function openclawUploadDir(
  tmp,
  preferred = "/tmp/openclaw",
  { create = true } = {},
) {
  if (!trusted(preferred) && create)
    try {
      fs.mkdirSync(preferred, { mode: 0o700 });
    } catch {}
  return path.join(trusted(preferred) ? preferred : fallbackDir(tmp), "uploads");
}

// The name the website sees: the file's own name, without separators or controls,
// at most 200 bytes.
export function stagedName(relative) {
  let name = path.posix
    .basename(String(relative))
    .replace(/[\u0000-\u001f\u007f/\\]/g, "_")
    .trim();
  while (Buffer.byteLength(name) > 200) name = name.slice(0, -1);
  return !name || name === "." || name === ".." ? "upload" : name;
}

// A path the browser tool names, as OpenClaw reads it (normalizeUploadPathSource):
// without a `MEDIA:` prefix; null for a media:// reference.
const uploadSource = (raw) => {
  const trimmed = String(raw).trim();
  if (/^media:\/\//i.test(trimmed)) return null;
  return trimmed.replace(/^\s*MEDIA\s*:\s*/i, "").trim();
};

/**
 * Files AgentPier stages for an agent's own browser (docs/assistant-gateway.md
 * "Browser uploads"). OpenClaw's browser uploads only files below its uploads
 * directory, so a file of a granted project folder or of the agent's workspace is
 * copied there through the descriptor that was checked like every project read
 * (project-paths.js, project-open.js): no link on the way, no second hard link, a
 * regular file within `maxBytes`. A link or a copy by path could follow a folder
 * swapped for a link after the check.
 *
 * Each agent stages below its own folder of this data directory's namespace
 * (`<uploads>/agentpier-<hash>/<agent>/<random>/<name>`), one copy at a time per
 * agent, so its count is checked with none of its own copies in flight; the bytes
 * other agents are still copying are reserved against the total and the free space
 * until their copy ends or times out. The tool guard lets a browser upload name only files the
 * calling agent staged itself (`admit`). A staged file goes after `ttlMs`, when the
 * agent stages more than `perAgent`, when `keep` says its agent ended (a temporary
 * member, an archived agent, one without the browser) and when AgentPier starts or
 * stops (`clear`).
 */
export class BrowserUploads {
  constructor({
    tmp,
    dataRoot,
    uploadDir = null,
    now = Date.now,
    limits = uploadLimits,
  }) {
    Object.assign(this, { tmp, dataRoot, fixedDir: uploadDir, now, limits });
    this.entries = new Map();
    // Staging order: the newest files stay, also within one clock tick.
    this.sequence = 0;
    // One copy at a time per agent; bytes being copied count against every agent's
    // total and free space until their copy ends.
    this.queues = new Map();
    this.inflight = 0;
    // The checked descriptor's bytes; tests put a slow source here.
    this.reader = (handle) => handle.createReadStream({ start: 0, autoClose: false });
  }
  get uploadDir() {
    return this.fixedDir || openclawUploadDir(this.tmp);
  }
  /** This data directory's own folder below the uploads directory. */
  namespace(uploadDir = this.uploadDir) {
    const key = createHash("sha256")
      .update(real(this.dataRoot) || String(this.dataRoot))
      .digest("hex")
      .slice(0, 16);
    return path.join(uploadDir, `agentpier-${key}`);
  }
  /**
   * Removes every staged file of this data directory, also what an earlier process
   * left: in each folder OpenClaw may use, only below trusted folders of this user.
   */
  clear() {
    for (const entry of [...this.entries.values()]) this.remove(entry);
    const dirs = this.fixedDir
      ? [this.fixedDir]
      : [
          openclawUploadDir(this.tmp, undefined, { create: false }),
          path.join(fallbackDir(this.tmp), "uploads"),
        ];
    for (const uploadDir of new Set(dirs)) {
      const namespace = this.namespace(uploadDir);
      if (
        trusted(path.dirname(uploadDir)) &&
        trusted(uploadDir) &&
        fs.existsSync(namespace) &&
        trusted(namespace)
      )
        fs.rmSync(namespace, { recursive: true, force: true });
    }
  }
  // The agent's folder, created only below trusted folders of this user.
  ownFolder(assistantId) {
    const uploadDir = this.uploadDir;
    const namespace = this.namespace(uploadDir);
    if (!trusted(path.dirname(uploadDir))) throw assistantProblem("unavailable", 503);
    fs.mkdirSync(uploadDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(namespace, { mode: 0o700, recursive: true });
    if (!trusted(uploadDir) || !trusted(namespace))
      throw assistantProblem("unavailable", 503);
    const own = path.join(namespace, agentFolder(assistantId));
    fs.mkdirSync(own, { mode: 0o700, recursive: true });
    if (!trusted(own)) throw assistantProblem("unavailable", 503);
    return { uploadDir, own };
  }
  /**
   * Copies the file `raw` below `root` (a granted folder or the workspace, with its
   * `protectedRoots`; `admit(relative)` may refuse it by its path) for agent
   * `assistantId`. Returns the staged entry; `meta` (projectId, declaredSite) travels
   * with it for the audit. One copy of an agent runs at a time; a call still waiting
   * for its agent's earlier copy or copying after `copyMs` is cancelled, answers at
   * once and leaves nothing behind, also when a read hangs: the agent's next call and
   * every other agent's calls go on.
   */
  stage(assistantId, spec, meta = {}) {
    // A timer of its own (AbortSignal.timeout's does not keep the process waiting),
    // cleared once the call settles.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.limits.copyMs);
    const { signal } = controller;
    const timedOut = new Promise((_resolve, reject) =>
      signal.addEventListener(
        "abort",
        () => reject(assistantProblem("browserUploadSlow", 504)),
        { once: true },
      ),
    );
    timedOut.catch(() => {});
    const previous = this.queues.get(assistantId) ?? Promise.resolve();
    const run = previous.then(() => this.copy(assistantId, spec, meta, signal));
    const settled = Promise.race([run, timedOut]);
    const tail = settled.catch(() => {}).finally(() => clearTimeout(timer));
    this.queues.set(assistantId, tail);
    tail.then(() => {
      if (this.queues.get(assistantId) === tail) this.queues.delete(assistantId);
    });
    run.catch(() => {});
    return settled;
  }
  async copy(
    assistantId,
    { root, raw, protectedRoots = [], admit = null },
    meta,
    signal,
  ) {
    if (signal.aborted) throw assistantProblem("browserUploadSlow", 504);
    this.sweep();
    const target = projectTarget(root, raw, { protectedRoots });
    if (!target.exists) throw missing();
    admit?.(target.relative);
    let handle;
    try {
      handle = await openInside(target.real, O_RDONLY | O_NONBLOCK);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") throw missing();
      throw unsuitable();
    }
    let dir = null;
    let reserved = 0;
    const release = () => {
      this.inflight -= reserved;
      reserved = 0;
    };
    signal.addEventListener("abort", release, { once: true });
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink > 1) throw unsuitable();
      if (stat.size > this.limits.maxBytes)
        throw assistantProblem("browserUploadTooLarge", 413);
      // The agent's oldest files make room for this one once it is copied; all
      // agents share the total.
      const leaving = new Set(this.oldest(assistantId, this.limits.perAgent - 1));
      const held = [...this.entries.values()]
        .filter((e) => !leaving.has(e))
        .reduce((sum, e) => sum + e.bytes, 0);
      if (signal.aborted) throw assistantProblem("browserUploadSlow", 504);
      if (held + this.inflight + stat.size > this.limits.totalBytes) throw noSpace();
      const { uploadDir, own } = this.ownFolder(assistantId);
      const space = fs.statfsSync(own);
      // Other agents' copies still to land count as used.
      const needed = stat.size + this.limits.reserveBytes + this.inflight;
      if (space.bavail * space.bsize < needed) throw noSpace();
      // A tmpfs holds its files in memory.
      if (space.type === TMPFS_MAGIC && os.freemem() < needed) throw noSpace();
      reserved = stat.size;
      this.inflight += reserved;
      const id = randomBytes(16).toString("hex");
      dir = path.join(own, id);
      fs.mkdirSync(dir, { mode: 0o700 });
      const file = path.join(dir, stagedName(target.relative || raw));
      // The checked descriptor itself, never the path again.
      await pipeline(
        this.reader(handle),
        fs.createWriteStream(file, { flags: "wx", mode: 0o600 }),
        { signal },
      );
      const copied = fs.lstatSync(file);
      if (!copied.isFile() || copied.size !== stat.size) throw unsuitable();
      const entry = {
        id,
        assistantId,
        path: file,
        dir,
        uploadDir,
        name: path.basename(file),
        relative: target.relative,
        bytes: stat.size,
        identity: `${copied.dev}:${copied.ino}`,
        expiresAt: this.now() + this.limits.ttlMs,
        sequence: ++this.sequence,
        ...meta,
      };
      for (const old of leaving) this.remove(old);
      this.entries.set(id, entry);
      dir = null;
      return entry;
    } catch (error) {
      if (error?.code === "ENOSPC") throw noSpace();
      if (signal.aborted) throw assistantProblem("browserUploadSlow", 504);
      throw error;
    } finally {
      release();
      signal.removeEventListener("abort", release);
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
      await handle.close();
    }
  }
  // The agent's files beyond its newest `keep`.
  oldest(assistantId, keep) {
    return [...this.entries.values()]
      .filter((e) => e.assistantId === assistantId)
      .sort((a, b) => b.sequence - a.sequence)
      .slice(Math.max(0, keep));
  }
  remove(entry) {
    this.entries.delete(entry.id);
    fs.rmSync(entry.dir, { recursive: true, force: true });
  }
  /** Expired files, and every file of agents `keep` no longer keeps. */
  sweep(keep = () => true) {
    for (const entry of [...this.entries.values()]) {
      if (!this.entries.has(entry.id)) continue;
      if (!keep(entry.assistantId)) this.release(entry.assistantId);
      else if (entry.expiresAt <= this.now()) this.remove(entry);
    }
  }
  /** Every file of one agent, for example a temporary member that ended. */
  release(assistantId) {
    for (const entry of [...this.entries.values()])
      if (entry.assistantId === assistantId) this.remove(entry);
  }
  /** The staged entries of agent `assistantId` that `paths` name; others are skipped. */
  owned(assistantId, paths) {
    if (!Array.isArray(paths)) return [];
    const byIdentity = new Map([...this.entries.values()].map((e) => [e.identity, e]));
    return paths.flatMap((raw) => {
      const entry = typeof raw === "string" && this.lookup(raw, byIdentity);
      return entry && entry.assistantId === assistantId ? [entry] : [];
    });
  }
  // The staged entry a path names: by the file it reaches, or null.
  lookup(raw, byIdentity) {
    const source = uploadSource(raw);
    if (!source) return null;
    try {
      const stat = fs.statSync(path.resolve(this.uploadDir, source));
      return byIdentity.get(`${stat.dev}:${stat.ino}`) ?? null;
    } catch {
      return null;
    }
  }
  /**
   * Whether a browser upload of agent `assistantId` may name `paths`: only files
   * this agent staged here that are still there. Another agent's staged file or
   * anything in an AgentPier namespace is `uploadNotStaged`; every other path,
   * also OpenClaw's shared uploads and inbound media folders and media://
   * references, `uploadOutside`. Returns `{ used }`, the staged entries, or `{ reason }`.
   */
  admit(assistantId, paths) {
    this.sweep();
    if (!Array.isArray(paths) || !paths.length || paths.length > 20)
      return { reason: "uploadNotStaged" };
    const uploadDir = this.uploadDir;
    const spaces = [uploadDir, real(uploadDir)]
      .filter(Boolean)
      .map((root) => fold(path.join(root, "agentpier-")));
    const byIdentity = new Map([...this.entries.values()].map((e) => [e.identity, e]));
    const used = [];
    for (const raw of paths) {
      if (typeof raw !== "string" || raw.length > 4096 || raw.includes("\0"))
        return { reason: "uploadNotStaged" };
      const staged = this.lookup(raw, byIdentity);
      if (staged?.assistantId === assistantId) {
        used.push(staged);
        continue;
      }
      const source = uploadSource(raw);
      const absolute = source === null ? null : path.resolve(uploadDir, source);
      const names = absolute ? [absolute, real(absolute)].filter(Boolean) : [];
      const ours = names.some((n) => spaces.some((s) => fold(n).startsWith(s)));
      return { reason: staged || ours ? "uploadNotStaged" : "uploadOutside" };
    }
    return { used };
  }
}

// The agent's folder name: its id when that is a plain name, otherwise a hash.
const agentFolder = (id) =>
  /^[A-Za-z0-9_-]{1,100}$/.test(String(id))
    ? String(id)
    : createHash("sha256").update(String(id)).digest("hex").slice(0, 32);
