// The live `file.meta:<token>` topic, owner only: the document metadata of a file open
// in the editor, as GET .../metadata?view=document answers it, pushed when the file
// changes instead of being polled every 15 s.
//
// A topic id is at most 200 characters and a path is not, so the parameter is a
// token: the metadata route issues it (header X-File-Watch) after its own scope and
// access checks passed, for that principal, scope and path. The token is random and
// lives only in this process, so it cannot be guessed or derived from a path, and a
// token nobody issued, or one the registry evicted, is an unknown topic: the editor
// keeps its 15 s poll. Only the local file scopes (global, project) are registered;
// any other scope (an SSH host) gets no token and keeps the poll.
//
// A token is issued to a principal key, which for the owner is just "owner": there is
// one owner identity, so a token outlives a logout (which closes the sockets) and is
// dropped only by eviction (at most 1024 kept, the oldest unwatched first) or a
// restart. It names one scope id (which includes the session id) and one path.
//
// Every read repeats the route's checks: the session's scope must still be the one
// the token was issued for, and the path resolves within it (links are followed only
// inside the scope). The data directory is refused by device and inode, so no
// spelling or link hides it: its folders are never watched, a path whose folders lie
// in it is not read, and the read's own answer is checked again on the path it
// resolved, so a link swapped in between cannot push a data-directory file. This is
// to keep watch handles off a folder that changes all the time, not a secret: the
// owner reads the data directory over REST. A hard link to a data-directory file
// placed in the scope is therefore watched in its own folder like any file. A refusal
// travels as payload (`error: {code, status}`), a deleted file as `missing: true`.
//
// The topic watches the file's folder, filtered by name, so an in-place write, an
// atomic replace (a temporary file renamed over it), a delete and a re-create are all
// seen; a selected link's own folder is watched too. One handle per folder (by path
// and inode) is shared by every file in it and closed with the last one; files and
// folders are capped. A handle that dies or whose folder was deleted or replaced
// (server/lib/directory-watchers.js) is closed and its files watch again. A file past the
// cap, or one whose folder cannot be watched, reads `watched: false`, which makes the
// editor poll it, and is tried again every 30 s.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { resolveFile } from "./file-paths.js";
import { fileProblem } from "./file-errors.js";
import { DirectoryWatchers, foldName } from "../../lib/directory-watchers.js";

export { DirectoryWatchers };

/** The response header of the document metadata route that names the topic. */
export const FILE_WATCH_HEADER = "x-file-watch";
export const FILE_META_PARAM = /[A-Za-z0-9_-]{22}/;
const LOCAL_SCOPES = new Set(["global", "project"]);

const principalKey = (principal) =>
  principal?.role === "owner"
    ? "owner"
    : principal?.role === "user" && typeof principal.userId === "string"
      ? `user:${principal.userId}`
      : null;
const fold = foldName;

/**
 * The registry of issued tokens and the followers of watched files. `context(id)` is
 * the file services' scope lookup, `metadata(scope, path)` the document metadata the
 * route answers.
 */
export class FileWatches {
  constructor({
    dataDir,
    context,
    metadata,
    watch = fs.watch,
    maxFiles = 128,
    maxDirectories = 256,
    maxTokens = 1024,
    retryMs = 30000,
  }) {
    Object.assign(this, { dataDir, context, metadata, maxFiles, maxTokens, retryMs });
    this.directories = new DirectoryWatchers({ watch, maxDirectories });
    this.tokens = new Map();
    this.keys = new Map();
    this.followed = 0;
    this.followers = new Set();
  }

  /**
   * Issues the topic id for `principal` watching `input` in `scope`, after the
   * route's own read passed; null for a scope that is not local, a path that is not
   * a regular file or one in the data directory.
   */
  async register(principal, scope, input) {
    const owner = principalKey(principal);
    if (!owner || !LOCAL_SCOPES.has(scope?.kind)) return null;
    let targets;
    try {
      targets = await this.targets(scope, input);
      if (!targets.file || (await this.protectedTargets(targets))) return null;
    } catch {
      return null;
    }
    const key = JSON.stringify([owner, scope.id, targets.path]);
    let entry = this.keys.get(key);
    if (entry) this.keys.delete(key);
    else {
      entry = {
        token: randomBytes(16).toString("base64url"),
        key,
        owner,
        scopeId: scope.id,
        sessionId: scope.sessionId ?? null,
        path: targets.path,
        holds: 0,
        follower: null,
      };
      this.tokens.set(entry.token, entry);
    }
    // Most recently issued last, so eviction takes the oldest one nobody watches.
    this.keys.set(key, entry);
    for (const [oldKey, old] of this.keys) {
      if (this.keys.size <= this.maxTokens) break;
      if (old.holds) continue;
      this.keys.delete(oldKey);
      this.tokens.delete(old.token);
    }
    return `file.meta:${entry.token}`;
  }

  /** Whether `principal` may follow `token`: only the principal it was issued to. */
  authorize(principal, token) {
    const entry = this.tokens.get(token);
    return Boolean(entry) && entry.owner === principalKey(principal);
  }

  /** The topic value: the route's metadata, `missing`, or the refusal as payload. */
  async read(token) {
    const entry = this.tokens.get(token);
    if (!entry)
      throw Object.assign(fileProblem("FILE_NOT_FOUND", 404), { expected: true });
    const result = await this.observe(entry);
    return { ...result, watched: entry.follower?.state !== "unwatched" };
  }

  async observe(entry) {
    try {
      const scope = await this.context(entry.sessionId);
      if (scope.id !== entry.scopeId) throw fileProblem("FILE_INVALID_SCOPE", 409);
      if (await this.protectedTargets(await this.targets(scope, entry.path)))
        throw fileProblem("FILE_PROTECTED_PATH", 403);
      const metadata = await this.metadata(scope, entry.path);
      // The path the read resolved and opened, checked again: a link swapped in
      // after the check above must not push a data-directory file.
      const opened = path.resolve(
        scope.kind === "project" ? scope.root : "/",
        String(metadata?.resolvedPath ?? ""),
      );
      if (await this.protectedTargets({ pairs: [[path.dirname(opened)]] }))
        throw fileProblem("FILE_PROTECTED_PATH", 403);
      return metadata;
    } catch (error) {
      if (error?.code === "FILE_NOT_FOUND") return { path: entry.path, missing: true };
      if (/^FILE_[A-Z0-9_]+$/.test(error?.code || "") && error.status < 500)
        return { path: entry.path, error: { code: error.code, status: error.status } };
      throw error;
    }
  }

  /**
   * Watches the file of `token` while a topic instance lives; `invalidate()` reads
   * it again. Returns the stop function.
   */
  follow(token, invalidate) {
    const entry = this.tokens.get(token);
    if (!entry) return () => {};
    entry.holds += 1;
    const follower = {
      state: "arming",
      releases: new Map(),
      closed: false,
      arming: false,
      again: false,
      counted: false,
    };
    entry.follower = follower;
    this.followers.add(follower);
    const changed = () => {
      invalidate();
      arm();
    };
    const arm = async () => {
      if (follower.closed) return;
      clearTimeout(follower.retry);
      follower.retry = null;
      if (follower.arming) {
        follower.again = true;
        return;
      }
      follower.arming = true;
      const pairs = await this.watchedFolders(entry);
      follower.arming = false;
      if (follower.closed) return;
      if (follower.again) {
        follower.again = false;
        return arm();
      }
      const wanted = new Map(
        (pairs || []).map(([dir, name, identity]) => [
          JSON.stringify([dir, fold(name), identity]),
          [dir, name, identity],
        ]),
      );
      // A handle that failed is gone: watch its folder anew.
      for (const [key, release] of follower.releases)
        if (!wanted.has(key) || !release.alive()) {
          release();
          follower.releases.delete(key);
        }
      let complete = Boolean(pairs?.length);
      for (const [key, [dir, name, identity]] of wanted) {
        if (follower.releases.has(key)) continue;
        const release = this.directories.add(dir, name, changed, identity);
        if (release) follower.releases.set(key, release);
        else complete = false;
      }
      follower.state = complete ? "armed" : "unwatched";
      // Never armed without a live handle: the editor polls meanwhile, and the
      // watch is tried again.
      if (!complete) {
        follower.retry = setTimeout(arm, this.retryMs);
        follower.retry.unref?.();
      }
      // A change between the first read and the watch is read now; an equal digest
      // sends nothing.
      invalidate();
    };
    if (this.followed >= this.maxFiles) follower.state = "unwatched";
    else {
      this.followed += 1;
      follower.counted = true;
      arm();
    }
    return () => this.unfollow(entry, follower);
  }

  unfollow(entry, follower) {
    if (follower.closed) return;
    follower.closed = true;
    clearTimeout(follower.retry);
    for (const release of follower.releases.values()) release();
    follower.releases.clear();
    if (follower.counted) this.followed -= 1;
    this.followers.delete(follower);
    entry.holds -= 1;
    if (entry.follower === follower) entry.follower = null;
  }

  /**
   * The [folder, name, dev:ino] triples to watch for `entry`, or null when none may
   * be.
   */
  async watchedFolders(entry) {
    try {
      const scope = await this.context(entry.sessionId);
      if (scope.id !== entry.scopeId) return null;
      const targets = await this.targets(scope, entry.path);
      if (await this.protectedTargets(targets)) return null;
      const triples = [];
      for (const [folder, name] of targets.pairs) {
        const stat = await fsp.stat(folder, { bigint: true });
        triples.push([folder, name, `${stat.dev}:${stat.ino}`]);
      }
      return triples;
    } catch {
      return null;
    }
  }

  /**
   * Resolves `input` in `scope` as the route does (links followed only within it):
   * the selected path, whether it is a regular file, and the folders that hold it and
   * its selected link. A missing leaf, or a link that points out of the scope, is
   * watched only in its own folder, to see it come back; its target never is.
   */
  async targets(scope, input) {
    let resolved;
    try {
      resolved = await resolveFile(scope, input, { followLeaf: true });
    } catch (error) {
      if (!["FILE_NOT_FOUND", "FILE_OUTSIDE_SCOPE"].includes(error?.code)) throw error;
      resolved = await resolveFile(scope, input, {
        followLeaf: false,
        allowMissingLeaf: true,
      });
    }
    const pairs = [[path.dirname(resolved.absolute), path.basename(resolved.absolute)]];
    const [[folder, name]] = pairs;
    if (
      resolved.name &&
      (resolved.parent !== folder || fold(resolved.name) !== fold(name))
    )
      pairs.push([resolved.parent, resolved.name]);
    return { path: resolved.path, file: Boolean(resolved.stat?.isFile()), pairs };
  }

  /** Whether a folder of `targets` is in the data directory, by device and inode. */
  async protectedTargets({ pairs }) {
    const data = await this.dataIdentity();
    if (!data) return true;
    for (const [directory] of pairs) {
      let current = directory;
      for (;;) {
        try {
          const stat = await fsp.stat(current, { bigint: true });
          if (stat.dev === data.dev && stat.ino === data.ino) return true;
        } catch {
          // A missing ancestor is no data directory; keep walking up.
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
    return false;
  }

  async dataIdentity() {
    if (!this.data) {
      try {
        const stat = await fsp.stat(this.dataDir, { bigint: true });
        this.data = { dev: stat.dev, ino: stat.ino };
      } catch {
        return null;
      }
    }
    return this.data;
  }

  close() {
    for (const follower of [...this.followers]) {
      follower.closed = true;
      clearTimeout(follower.retry);
      for (const release of follower.releases.values()) release();
      follower.releases.clear();
    }
    this.followers.clear();
    this.followed = 0;
    this.directories.close();
  }
}

/** The `file.meta` topic definition for LiveHub#define. */
export function fileMetaTopic(services) {
  const watches = () => services.files.watches;
  return {
    name: "file.meta",
    mode: "state",
    param: FILE_META_PARAM,
    authorize: (principal, token) => watches().authorize(principal, token),
    scopeKey: (principal) => principalKey(principal),
    read: (_principal, token) => watches().read(token),
    watch: ({ param, invalidate }) => watches().follow(param, invalidate),
  };
}
