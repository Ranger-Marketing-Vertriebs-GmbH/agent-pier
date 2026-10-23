import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pipeline as pipe } from "node:stream";
import { sftpProblem } from "./sftp-errors.js";
import { partName } from "./sftp-excludes.js";
import { AUTHORIZE_EVERY_MS, SftpGate } from "./sftp-gate.js";
import { sftpLimits } from "./sftp-limits.js";
import { localParent, openLocalSource, removeLocal, writeLocal } from "./sftp-local.js";
import { confineEntry } from "./sftp-operations.js";
import { prepareTransfer } from "./sftp-transfer-scan.js";
import { confineRemote, insideRoot } from "./sftp-remote-paths.js";

export { prepareTransfer, walkRemote } from "./sftp-transfer-scan.js";

const posix = path.posix;
const CLOSE_WAIT_MS = 5000;
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

// Passes at most `size` bytes and fails unless exactly `size` arrive: a file that
// changed since the plan (or a hostile server) never writes more than was approved.
function exactly(size, onBytes) {
  let seen = 0;
  return new Transform({
    transform(chunk, _encoding, done) {
      seen += chunk.length;
      if (seen > size) return done(sftpProblem("SFTP_PLAN_CHANGED"));
      onBytes(chunk.length);
      done(null, chunk);
    },
    flush(done) {
      done(seen === size ? null : sftpProblem("SFTP_PLAN_CHANGED"));
    },
  });
}

function closed(stream) {
  if (stream.closed) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, CLOSE_WAIT_MS);
    stream.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

class Execution {
  constructor(session, prepared, options) {
    this.session = session;
    this.prepared = prepared;
    this.layout = prepared.layout;
    this.request = prepared.request;
    this.options = options;
    this.gate = options.gate;
    this.signal = this.gate.signal;
    this.folders = new Set();
    this.temporary = new Set();
    this.progress = {
      files: prepared.plan.files,
      filesDone: 0,
      bytes: prepared.plan.bytes,
      bytesDone: 0,
      current: null,
    };
  }

  report(update = {}) {
    Object.assign(this.progress, update);
    this.options.onProgress?.({ ...this.progress });
  }

  counted(size) {
    return exactly(size, (bytes) =>
      this.report({ bytesDone: this.progress.bytesDone + bytes }),
    );
  }

  // Creates the missing folders on the way to `dir` one name at a time, each confined;
  // anything but a folder in the way is a type conflict.
  async remoteFolders(dir) {
    const chain = [];
    for (let at = dir; at !== "/" && !this.folders.has(at); at = posix.dirname(at))
      chain.unshift(at);
    const root = this.layout.root ?? "/";
    for (const folder of chain) {
      // Above the allowed folder nothing is created; the base and the allowed folder
      // were resolved on purpose; below them no link is followed.
      const above = !insideRoot(root, folder);
      const confined =
        above || folder === root || folder === this.layout.base
          ? above
            ? folder
            : await confineRemote(this.session, folder, root)
          : await confineEntry(this.session, folder, this.layout.root);
      const stat = await this.session.lstat(confined);
      if (above && stat?.type !== "dir") throw sftpProblem("SFTP_PATH_REFUSED");
      if (!stat) await this.session.mkdir(confined);
      else if (stat.type !== "dir") throw sftpProblem("SFTP_TYPE_CONFLICT");
      this.folders.add(folder);
    }
  }

  async upload(entry) {
    const { session } = this;
    const abs = this.layout.remoteOf(entry.path);
    await this.remoteFolders(posix.dirname(abs));
    const target = await confineEntry(session, abs, this.layout.root);
    const existing = await session.lstat(target);
    if (existing && existing.type !== "file") throw sftpProblem("SFTP_TYPE_CONFLICT");
    const handle = await openLocalSource(
      this.request.local,
      this.layout.localOf(entry.path),
    );
    const temp = posix.join(posix.dirname(target), partName(posix.basename(target)));
    try {
      if ((await handle.stat()).size !== entry.size)
        throw sftpProblem("SFTP_PLAN_CHANGED");
      this.signal.throwIfAborted();
      this.temporary.add(temp);
      const output = session.writeStream(temp);
      try {
        await pipeline(
          handle.createReadStream({ autoClose: false }),
          this.counted(entry.size),
          output,
          { signal: this.signal },
        );
      } finally {
        await closed(output);
      }
      this.signal.throwIfAborted();
      await session.rename(temp, target, { overwrite: true });
      this.temporary.delete(temp);
      await session.setTimes(target, entry.mtimeMs);
    } finally {
      await handle.close().catch(() => {});
    }
    return { overwritten: Boolean(existing) };
  }

  async download(entry) {
    const { session, layout } = this;
    const source = await confineEntry(session, layout.remoteOf(entry.path), layout.root);
    const stat = await session.lstat(source);
    if (stat?.type !== "file" || stat.size !== entry.size)
      throw sftpProblem("SFTP_PLAN_CHANGED");
    const local =
      layout.kind === "file" ? localParent(this.request.local) : this.request.local;
    const counted = this.counted(entry.size);
    pipe(session.readStream(source), counted, () => {});
    try {
      return await writeLocal(local, layout.localOf(entry.path), counted, {
        mtimeMs: entry.mtimeMs,
        signal: this.signal,
      });
    } finally {
      counted.destroy();
    }
  }

  // Deletes only what was planned: a file must still have its planned size and mtime.
  async remove(relative, directory, entry = null) {
    const expect = entry && { size: entry.size, mtimeMs: entry.mtimeMs };
    if (this.request.direction === "down")
      return removeLocal(this.request.local, relative, { directory, expect });
    const abs = await confineEntry(
      this.session,
      this.layout.remoteOf(relative),
      this.layout.root,
    );
    const stat = await this.session.lstat(abs);
    if (
      stat?.type !== (directory ? "dir" : "file") ||
      (expect && (stat.size !== expect.size || stat.mtimeMs !== expect.mtimeMs))
    )
      throw sftpProblem("SFTP_PLAN_CHANGED");
    if (directory) await this.session.rmdir(abs);
    else await this.session.unlink(abs);
  }

  // Removes leftover temporary files; a dropped session is reopened for it.
  async cleanup() {
    if (!this.temporary.size) return;
    let session = this.session;
    let reopened = null;
    if (session.closed && this.options.reopen) {
      reopened = await this.options.reopen().catch(() => null);
      session = reopened;
    }
    if (session && !session.closed)
      for (const temp of this.temporary)
        await session.unlink(temp).then(
          () => this.temporary.delete(temp),
          (error) => error?.code === "SFTP_NOT_FOUND" && this.temporary.delete(temp),
        );
    reopened?.close();
  }

  async run(plan, result) {
    const updates = new Set(plan.update.map((entry) => entry.path));
    const copies = [...plan.create, ...plan.update].sort(byPath);
    const up = this.request.direction === "up";
    for (const entry of copies) {
      await this.gate.check();
      this.report({ current: entry.path });
      const { overwritten } = up ? await this.upload(entry) : await this.download(entry);
      result.files++;
      result.bytes += entry.size;
      if (updates.has(entry.path)) result.updated++;
      else result.created++;
      if (overwritten && result.overwritten.length < this.options.limits.resultListLimit)
        result.overwritten.push(entry.path);
      this.report({ filesDone: result.files });
    }
    const removals = [
      ...plan.delete.map((entry) => [entry.path, false, entry]),
      ...plan.deleteDirs.map((dir) => [dir, true, null]),
    ];
    for (const [relative, directory, entry] of removals) {
      await this.gate.check();
      this.report({ current: relative });
      await this.remove(relative, directory, entry);
      if (!directory) result.deleted++;
    }
    this.report({ current: null });
  }
}

/**
 * Runs a prepared transfer. The plan is computed again first and must have the same
 * digest (else `SFTP_PLAN_CHANGED`, nothing written). Copies run file by file
 * (uploads through a `.<name>.agentpier-part-<hex>` file renamed over the target,
 * downloads through `writeLocal`), each capped to its planned size; deletes follow,
 * files before folders and deepest first. The first error stops the transfer and its
 * own temporary file is removed (`reopen` opens a session for that after a drop).
 * `stillAuthorized` is awaited before each file and every 2 s; `false` or an error
 * revokes.
 */
export async function runTransfer(
  session,
  prepared,
  {
    signal,
    onProgress,
    stillAuthorized,
    reopen,
    limits = sftpLimits,
    authorizeEveryMs = AUTHORIZE_EVERY_MS,
  } = {},
) {
  const started = Date.now();
  const gate = new SftpGate({ signal, stillAuthorized, everyMs: authorizeEveryMs });
  const execution = new Execution(session, prepared, {
    onProgress,
    reopen,
    limits,
    gate,
  });
  const result = {
    state: "completed",
    files: 0,
    bytes: 0,
    created: 0,
    updated: 0,
    deleted: 0,
    overwritten: [],
    skipped: { ...prepared.skipped },
  };
  try {
    gate.signal.throwIfAborted();
    const fresh = await prepareTransfer(session, prepared.request, {
      limits,
      signal: gate.signal,
    });
    if (fresh.plan.digest !== prepared.plan.digest)
      throw sftpProblem("SFTP_PLAN_CHANGED");
    execution.layout = fresh.layout;
    result.skipped = { ...fresh.skipped };
    await execution.run(fresh.plan, result);
  } catch (error) {
    Object.assign(result, gate.outcome(error));
    if (execution.progress.current) result.failedPath = execution.progress.current;
  } finally {
    gate.close();
    await execution.cleanup().catch(() => {});
  }
  result.durationMs = Date.now() - started;
  return result;
}
