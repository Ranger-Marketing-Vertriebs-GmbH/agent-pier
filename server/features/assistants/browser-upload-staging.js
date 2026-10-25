import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { assistantProblem } from "./assistant-validation.js";
import { projectTarget } from "./project-paths.js";
import { openInside } from "./project-open.js";

// What one staged file may be, how many one agent holds at once, how long one stays
// and how much free space a copy leaves behind.
export const uploadLimits = {
  maxBytes: 8 * 1024 ** 3,
  perAgent: 3,
  ttlMs: 6 * 60 * 60 * 1000,
  reserveBytes: 1024 ** 3,
};
const { O_RDONLY, O_NONBLOCK, COPYFILE_EXCL, COPYFILE_FICLONE } = fs.constants;
const unsuitable = () => assistantProblem("projectFileUnsuitable", 400);
const missing = () => assistantProblem("notFound", 404);
const darwin = process.platform === "darwin";
// Case-insensitive volumes (macOS) name one folder in any case.
const fold = (value) => (darwin ? value.toLowerCase() : value);
const inside = (parent, child) =>
  fold(child) === fold(parent) || fold(child).startsWith(fold(parent) + path.sep);
const real = (value) => {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return null;
  }
};

// A temp folder OpenClaw trusts: a real directory of this user (fs-safe
// resolveSecureTempRoot also tightens its mode before using it).
function trusted(directory) {
  try {
    const stat = fs.lstatSync(directory);
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      (!process.getuid || stat.uid === process.getuid())
    );
  } catch {
    return false;
  }
}

/**
 * The uploads directory OpenClaw's browser takes files from (OpenClaw 2026.10.7
 * extensions/browser paths.ts DEFAULT_UPLOAD_DIR): `<tmp>/uploads` below
 * /tmp/openclaw when that is a trusted folder of this user or can be created,
 * otherwise below `<TMPDIR>/openclaw-<uid>`, with the Gateway's TMPDIR (`tmp`).
 * Spelled as OpenClaw spells it: its check is lexical below that root.
 */
export function openclawUploadDir(tmp, preferred = "/tmp/openclaw") {
  let base = preferred;
  if (!trusted(preferred)) {
    try {
      fs.mkdirSync(preferred, { mode: 0o700 });
    } catch {}
    if (!trusted(preferred)) {
      const uid = process.getuid?.();
      base = path.join(tmp, uid === undefined ? "openclaw" : `openclaw-${uid}`);
    }
  }
  return path.join(base, "uploads");
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
// without a `MEDIA:` prefix; a media:// reference is OpenClaw's inbound media.
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
 * regular file within `maxBytes`. The copy is a reflink where the file system
 * clones through a descriptor (Linux btrfs or XFS) and a plain copy otherwise; a
 * clone by path could follow a folder swapped for a link after the check.
 *
 * Each agent stages below its own folder of this data directory's namespace
 * (`<uploads>/agentpier-<hash>/<agent>/<random>/<name>`), and the tool guard lets
 * a browser call upload from that namespace only what the calling agent staged
 * itself (`admit`). A staged file goes after `ttlMs`, when the agent stages more
 * than `perAgent`, when `keep` says its agent ended (a temporary member, an
 * archived agent, one without the browser) and when AgentPier starts again.
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
    this.cleared = false;
    // Staging order: the newest files stay, also within one clock tick.
    this.sequence = 0;
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
  // Leftovers of an earlier AgentPier process: nothing admits them any more.
  prepare() {
    const uploadDir = this.uploadDir;
    const namespace = this.namespace(uploadDir);
    if (!this.cleared) {
      fs.rmSync(namespace, { recursive: true, force: true });
      this.cleared = true;
    }
    fs.mkdirSync(namespace, { recursive: true, mode: 0o700 });
    if (!trusted(namespace) || !trusted(path.dirname(namespace)))
      throw assistantProblem("unavailable", 503);
    return { uploadDir, namespace };
  }
  /**
   * Copies the file `raw` below `root` (a granted folder or the workspace, with its
   * `protectedRoots` and `guarded` workspace entries) for agent `assistantId`.
   * Returns the staged entry; `meta` (projectId, site) travels with it for the audit.
   */
  async stage(
    assistantId,
    { root, raw, protectedRoots = [], guarded = null },
    meta = {},
  ) {
    this.sweep();
    const target = projectTarget(root, raw, { protectedRoots });
    if (!target.exists) throw missing();
    if (guarded && target.relative && guarded(target.relative.split("/")[0]))
      throw assistantProblem("projectPathRefused", 403);
    let handle;
    try {
      handle = await openInside(target.real, O_RDONLY | O_NONBLOCK);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") throw missing();
      throw unsuitable();
    }
    let dir = null;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink > 1) throw unsuitable();
      if (stat.size > this.limits.maxBytes)
        throw assistantProblem("browserUploadTooLarge", 413);
      const { uploadDir, namespace } = this.prepare();
      const own = path.join(namespace, agentFolder(assistantId));
      fs.mkdirSync(own, { recursive: true, mode: 0o700 });
      const space = fs.statfsSync(own);
      if (space.bavail * space.bsize < stat.size + this.limits.reserveBytes)
        throw assistantProblem("browserUploadSpace", 507);
      const id = randomBytes(16).toString("hex");
      dir = path.join(own, id);
      fs.mkdirSync(dir, { mode: 0o700 });
      const file = path.join(dir, stagedName(target.relative || raw));
      // The checked descriptor, reopened by its own name: never the path again.
      const source = darwin ? `/dev/fd/${handle.fd}` : `/proc/self/fd/${handle.fd}`;
      await fs.promises.copyFile(source, file, COPYFILE_EXCL | COPYFILE_FICLONE);
      fs.chmodSync(file, 0o600);
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
      this.entries.set(id, entry);
      dir = null;
      this.trim(assistantId);
      return entry;
    } catch (error) {
      if (error?.code === "ENOSPC") throw assistantProblem("browserUploadSpace", 507);
      throw error;
    } finally {
      await handle.close();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  // The agent keeps its newest `perAgent` files.
  trim(assistantId) {
    const own = [...this.entries.values()]
      .filter((e) => e.assistantId === assistantId)
      .sort((a, b) => b.sequence - a.sequence);
    for (const entry of own.slice(this.limits.perAgent)) this.remove(entry);
  }
  remove(entry) {
    this.entries.delete(entry.id);
    fs.rmSync(entry.dir, { recursive: true, force: true });
  }
  /** Expired files, and those of agents `keep` no longer keeps. */
  sweep(keep = () => true) {
    for (const entry of [...this.entries.values()])
      if (entry.expiresAt <= this.now() || !keep(entry.assistantId)) this.remove(entry);
  }
  /** Every file of one agent, for example a temporary member that ended. */
  release(assistantId) {
    for (const entry of [...this.entries.values()])
      if (entry.assistantId === assistantId) this.remove(entry);
  }
  /**
   * Whether a browser upload of agent `assistantId` may name `paths`: a file
   * AgentPier staged anywhere (of any data directory) only when this agent staged
   * it here and it is still there, and an absolute path only inside OpenClaw's own
   * folders (`inbound`, its inbound media), where OpenClaw's own rules apply.
   * Returns `{ used }`, the staged entries named, or `{ reason }`.
   */
  admit(assistantId, paths, { inbound = null } = {}) {
    this.sweep();
    if (!Array.isArray(paths) || !paths.length || paths.length > 20)
      return { reason: "uploadNotStaged" };
    const uploadDir = this.uploadDir;
    const roots = [uploadDir, real(uploadDir)].filter(Boolean);
    const spaces = roots.map((root) => path.join(root, "agentpier-"));
    const byIdentity = new Map([...this.entries.values()].map((e) => [e.identity, e]));
    const used = [];
    for (const raw of paths) {
      if (typeof raw !== "string" || raw.length > 4096 || raw.includes("\0"))
        return { reason: "uploadNotStaged" };
      const source = uploadSource(raw);
      if (source === null) continue;
      const absolute = path.resolve(uploadDir, source);
      const resolved = real(absolute);
      const names = [absolute, resolved].filter(Boolean);
      let identity = null;
      try {
        const stat = fs.statSync(absolute);
        identity = `${stat.dev}:${stat.ino}`;
      } catch {}
      const staged = identity && byIdentity.get(identity);
      const ours = names.some((n) => spaces.some((s) => fold(n).startsWith(fold(s))));
      if (staged || ours) {
        if (!staged || staged.assistantId !== assistantId)
          return { reason: "uploadNotStaged" };
        used.push(staged);
        continue;
      }
      const allowed = [...roots, ...(inbound ? [inbound, real(inbound)] : [])].filter(
        Boolean,
      );
      if (!names.some((n) => allowed.some((root) => inside(root, n))))
        return { reason: "uploadOutside" };
    }
    return { used };
  }
}

// The agent's folder name: its id when that is a plain name, otherwise a hash.
const agentFolder = (id) =>
  /^[A-Za-z0-9_-]{1,100}$/.test(String(id))
    ? String(id)
    : createHash("sha256").update(String(id)).digest("hex").slice(0, 32);
