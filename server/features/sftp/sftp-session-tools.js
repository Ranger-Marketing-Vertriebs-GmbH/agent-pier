import { serverMessages } from "../../lib/i18n/de.js";
import path from "node:path";
import { authorizeSsh } from "../ssh/ssh-capability.js";
import { sshProblem } from "../ssh/ssh-errors.js";
import { validateSshProjectBinding } from "../ssh/ssh-project-scope.js";
import { openSftp } from "./sftp-client.js";
import { SFTP_STATUSES, isSftpProblem, sftpProblem } from "./sftp-errors.js";
import { AUTHORIZE_EVERY_MS, problemCode } from "./sftp-gate.js";
import { SftpJobs } from "./sftp-jobs.js";
import { localRoot } from "./sftp-local.js";
import {
  confineEntry,
  planDelete,
  runDelete,
  sftpList,
  sftpMkdir,
  sftpRename,
  sftpStat,
} from "./sftp-operations.js";
import { confineRemote, remotePath } from "./sftp-remote-paths.js";
import { budgetedResult, commonFolder, transferSummary } from "./sftp-summary.js";
import { prepareTransfer, runTransfer } from "./sftp-transfer.js";
import { sftpArguments, sftpTools } from "./sftp-tool-schemas.js";

export { sftpTools };
export { transferSummary, withinBudget } from "./sftp-summary.js";

const posix = path.posix;
const CANCEL_WAIT_MS = 10000;
const CLOSE_WAIT_MS = 10000;
const AUDIT_PATH_CHARS = 1024;

// Coding agents read English; the code is the stable part.
const messages = {
  SFTP_AUTH_FAILED: "The SFTP server refused the sign-in.",
  SFTP_HOST_KEY_MISMATCH: "The SFTP server's host key does not match its pinned key.",
  SFTP_UNREACHABLE: "The SFTP server is unreachable.",
  SFTP_TIMEOUT: "The SFTP operation timed out.",
  SFTP_NOT_FOUND: "The remote or local path does not exist.",
  SFTP_PERMISSION: "The SFTP server denied permission.",
  SFTP_PATH_REFUSED:
    "The path is outside the allowed remote folder or the session's launch folder, protected, or contains refused characters.",
  SFTP_LIMIT:
    "The transfer exceeds the limits (2 GiB, 10,000 files, 50,000 scanned entries, 60 s scan).",
  SFTP_TYPE_CONFLICT:
    "A file is where a folder is expected (or the reverse), the folder is not empty, or the target exists.",
  SFTP_PLAN_CHANGED: "The files changed while the operation ran; run it again.",
  SFTP_JOB_NOT_FOUND: "No such SFTP job in this session.",
  SFTP_BUSY:
    "Another SFTP write runs on this folder, or too many SFTP jobs run; retry later.",
  SFTP_CANCELLED: "The SFTP operation was cancelled.",
  SFTP_FAILED: "The SFTP operation failed.",
};

function toolError(code, details) {
  const known = Object.hasOwn(messages, code) ? code : "SFTP_FAILED";
  const error = sshProblem(known, messages[known], SFTP_STATUSES[known]);
  if (details) error.details = details;
  return error;
}
function revoked(details) {
  const error = sshProblem("SSH_ACCESS_REVOKED", serverMessages.ssh.sftpRevoked, 403);
  if (details) error.details = details;
  return error;
}
// A raw SFTP problem carries its code as message; give it the agent's text.
const publicError = (error) =>
  isSftpProblem(error) && error.message === error.code ? toolError(error.code) : error;
const capped = (value) =>
  typeof value === "string" ? value.slice(0, AUDIT_PATH_CHARS) : undefined;
const transferOperations = { sftp_download: "download", sftp_upload: "upload" };

/**
 * The `sftp_*` tools of a coding session's SSH MCP server. A host granted to the
 * session or inherited from its project is used directly (the CLI's own permission
 * prompt applies); every call re-authorizes the capability and the grant, and jobs
 * re-check both while they run. Credentials never leave this process. Transfers and
 * writes run as jobs that the call waits for up to `waitMs`; the application audits
 * each of them through the management socket (`sftp_record`).
 */
export class SftpSessionTools {
  #runs = new Set();

  constructor({
    dataDir,
    capability,
    grants,
    store,
    manage,
    jobs = new SftpJobs(),
    open = openSftp,
    waitMs = 10000,
    authorizeEveryMs = AUTHORIZE_EVERY_MS,
  }) {
    Object.assign(this, { dataDir, capability, grants, store, manage, jobs, open });
    Object.assign(this, { waitMs, authorizeEveryMs });
    this.owner = capability.sessionId;
  }

  async close() {
    this.closing = true;
    this.jobs.closeAll();
    let timer;
    await Promise.race([
      Promise.allSettled([...this.#runs]),
      new Promise((resolve) => {
        timer = setTimeout(resolve, CLOSE_WAIT_MS);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
  }

  /** `signal` (an MCP cancellation) cancels the job the call waits for. */
  async call(name, input = {}, { signal } = {}) {
    try {
      if (this.closing)
        throw sshProblem("SSH_UNAVAILABLE", serverMessages.ssh.sftpClosing, 409);
      const args = sftpArguments(name, input);
      const session = authorizeSsh(this.dataDir, this.capability);
      if (name === "sftp_job") return await this.#jobTool(args);
      const access = await this.#access(session, args.accessId);
      const sftp = await access.open();
      let handed = false;
      const hand = () => (handed = true);
      try {
        const home = access.root ?? (await sftp.realpath("."));
        const context = { session, access, sftp, home, args, hand, signal };
        if (name === "sftp_list") return await this.#list(context);
        if (name === "sftp_stat") return await this.#stat(context);
        if (name === "sftp_mkdir") return await this.#mkdir(context);
        if (name === "sftp_rename") return await this.#rename(context);
        if (name === "sftp_delete") return await this.#delete(context);
        return await this.#transfer(context, transferOperations[name] ?? "sync");
      } finally {
        if (!handed) sftp.close();
      }
    } catch (error) {
      throw publicError(error);
    }
  }

  async #access(session, accessId) {
    const connection = await this.grants.resolve(session.id, accessId, { type: "sftp" });
    const { revision, remoteRoot, ...credentials } = connection;
    authorizeSsh(this.dataDir, this.capability);
    if (this.store.revision && this.store.revision(accessId) !== revision)
      throw revoked();
    return {
      accessId,
      revision,
      root: remoteRoot ?? null,
      open: () => this.open(credentials),
      // The capability, the session's effective grants and the pinned host revision.
      stillAuthorized: async () => {
        try {
          const current = authorizeSsh(this.dataDir, this.capability);
          if (!(await this.grants.effective(current)).includes(accessId)) return false;
          return !this.store.revision || this.store.revision(accessId) === revision;
        } catch {
          return false;
        }
      },
    };
  }

  #remote({ home }, raw) {
    return remotePath(raw ?? ".", home);
  }

  async #local(session, raw, write) {
    const project = await validateSshProjectBinding(session.sshTools?.project);
    try {
      return localRoot({
        root: project.launch.path,
        raw,
        write,
        protectedRoots: [this.dataDir],
      });
    } catch (error) {
      if (isSftpProblem(error) || !error?.status) throw error;
      throw sftpProblem("SFTP_PATH_REFUSED");
    }
  }

  async #list(context) {
    const { sftp, access, args } = context;
    const abs = this.#remote(context, args.remotePath);
    return sftpList(sftp, await confineRemote(sftp, abs, access.root ?? "/"));
  }

  async #stat(context) {
    const { sftp, access, args } = context;
    const abs = this.#remote(context, args.remotePath);
    // The allowed folder (or `/`) itself is resolved; any entry below it is not followed.
    const target =
      abs === "/" || abs === access.root
        ? await confineRemote(sftp, abs, access.root ?? "/")
        : await confineEntry(sftp, abs, access.root);
    return sftpStat(sftp, target);
  }

  async #mkdir(context) {
    const { sftp, access, args } = context;
    const target = await confineRemote(
      sftp,
      this.#remote(context, args.remotePath),
      access.root ?? "/",
    );
    return this.#job(context, {
      kind: "mkdir",
      summary: { path: target },
      lock: target,
      record: { operation: "mkdir", remotePath: target },
      work: async (_progress, signal) => {
        signal.throwIfAborted();
        if (!(await access.stillAuthorized())) return { state: "revoked" };
        const made = await sftpMkdir(sftp, target, { parents: Boolean(args.parents) });
        return { state: "completed", ...made };
      },
    });
  }

  async #rename(context) {
    const { sftp, access, args } = context;
    const from = await confineEntry(
      sftp,
      this.#remote(context, args.remotePath),
      access.root,
    );
    const to = await confineEntry(sftp, this.#remote(context, args.toPath), access.root);
    return this.#job(context, {
      kind: "rename",
      summary: { from, to },
      lock: commonFolder(from, to),
      record: { operation: "rename", remotePath: from },
      work: async (_progress, signal) => {
        signal.throwIfAborted();
        if (!(await access.stillAuthorized())) return { state: "revoked" };
        return { state: "completed", ...(await sftpRename(sftp, from, to)) };
      },
    });
  }

  async #delete(context) {
    const { sftp, access, args } = context;
    const root = access.root ?? "/";
    const recursive = Boolean(args.recursive);
    const plan = await planDelete(sftp, this.#remote(context, args.remotePath), {
      recursive,
      root,
    });
    return this.#job(context, {
      kind: "delete",
      summary: {
        path: plan.path,
        recursive,
        files: plan.files.length,
        dirs: plan.dirs.length,
        bytes: plan.bytes,
      },
      lock: plan.path,
      record: { operation: "delete", remotePath: plan.path },
      work: (progress, signal) => {
        progress({ files: plan.files.length, bytes: plan.bytes });
        return runDelete(sftp, plan, {
          signal,
          root,
          stillAuthorized: access.stillAuthorized,
          authorizeEveryMs: this.authorizeEveryMs,
          onProgress: ({ files, current }) => progress({ filesDone: files, current }),
        });
      },
    });
  }

  async #transfer(context, operation) {
    const { session, sftp, access, args } = context;
    const direction =
      operation === "upload" ? "up" : operation === "download" ? "down" : args.direction;
    const abs = this.#remote(context, args.remotePath);
    const fallback = operation === "download" && abs !== "/" ? posix.basename(abs) : ".";
    // A sync that deletes local files names its folder; never the whole launch folder.
    if (direction === "down" && args.deleteExtra && args.localPath === undefined)
      throw sshProblem("SSH_INVALID_ARGUMENT", serverMessages.ssh.sftpSyncLocalPath);
    const local = await this.#local(
      session,
      args.localPath ?? fallback,
      direction === "down",
    );
    const prepared = await prepareTransfer(
      sftp,
      {
        operation,
        direction,
        local,
        remotePath: abs,
        remoteRoot: access.root,
        excludes: args.exclude ?? [],
        defaultExcludes: args.defaultExcludes !== false,
        deleteExtra: Boolean(args.deleteExtra),
        checksum: Boolean(args.checksum),
        hostId: access.accessId,
        hostRevision: access.revision,
        projectId: session.sshTools?.project?.projectId ?? null,
      },
      { signal: context.signal },
    );
    const summary = transferSummary(prepared, local);
    if (args.dryRun) return { status: "planned", summary };
    return this.#job(context, {
      kind: operation,
      summary,
      // The confined, resolved remote base; only writes to the server lock it.
      lock: prepared.summary.remotePath,
      write: direction === "up",
      record: {
        operation,
        direction,
        remotePath: prepared.summary.remotePath,
        localPath: summary.localPath,
      },
      work: (progress, signal) =>
        runTransfer(sftp, prepared, {
          signal,
          onProgress: progress,
          stillAuthorized: access.stillAuthorized,
          // A dropped session is reopened to remove temporary files; never with the
          // job's signal, so cleanup still runs after a cancel.
          reopen: access.open,
          authorizeEveryMs: this.authorizeEveryMs,
        }),
    });
  }

  async #job(context, { kind, summary, lock, write = true, record, work }) {
    const { access, sftp, hand } = context;
    const view = this.jobs.start(this.owner, {
      kind,
      summary,
      lock: { hostId: access.accessId, path: lock, write },
      run: (progress, signal) => {
        const run = this.#run(access, sftp, record, work, progress, signal);
        this.#runs.add(run);
        return run.finally(() => this.#runs.delete(run));
      },
    });
    hand();
    return this.#answer(await this.#wait(view.jobId, context.signal));
  }

  // Waits up to `waitMs`; an aborted `signal` cancels the job and waits for its end.
  async #wait(jobId, signal) {
    if (!signal) return this.jobs.wait(this.owner, jobId, this.waitMs);
    let stop;
    const aborted = new Promise((resolve) => {
      stop = () => resolve(true);
      if (signal.aborted) resolve(true);
      else signal.addEventListener("abort", stop, { once: true });
    });
    try {
      const ended = await Promise.race([
        this.jobs.wait(this.owner, jobId, this.waitMs),
        aborted,
      ]);
      if (ended !== true) return ended;
      this.jobs.cancel(this.owner, jobId);
      return this.jobs.wait(this.owner, jobId, CANCEL_WAIT_MS);
    } finally {
      signal.removeEventListener("abort", stop);
    }
  }

  async #run(access, sftp, record, work, progress, signal) {
    const started = Date.now();
    let outcome;
    try {
      outcome = await work(progress, signal);
    } catch (error) {
      outcome = signal.aborted
        ? { state: "cancelled", code: problemCode(signal.reason) }
        : { state: "failed", code: problemCode(error) };
    } finally {
      sftp.close();
    }
    outcome.durationMs ??= Date.now() - started;
    await this.#record(access, record, outcome);
    return outcome;
  }

  // Best effort: the application writes the audit row; a failure never fails the job.
  async #record(access, record, outcome) {
    const code =
      outcome.code ?? (outcome.state === "revoked" ? "SSH_ACCESS_REVOKED" : undefined);
    const fields = {
      accessId: access.accessId,
      operation: record.operation,
      direction: record.direction,
      state: outcome.state,
      files: outcome.files,
      bytes: outcome.bytes,
      deleted: record.operation === "delete" ? outcome.files : outcome.deleted,
      dirs: outcome.dirs,
      durationMs: outcome.durationMs,
      remotePath: capped(record.remotePath),
      localPath: capped(record.localPath),
      code,
    };
    for (const key of Object.keys(fields))
      if (fields[key] === undefined) delete fields[key];
    await Promise.resolve()
      .then(() => this.manage("sftp_record", fields))
      .catch(() => {});
  }

  async #jobTool({ jobId, cancel }) {
    if (cancel) {
      this.jobs.cancel(this.owner, jobId);
      return this.#answer(await this.jobs.wait(this.owner, jobId, CANCEL_WAIT_MS));
    }
    return this.#answer(this.jobs.get(this.owner, jobId));
  }

  #answer(view) {
    const { jobId, summary } = view;
    if (view.state === "running")
      return { status: "running", jobId, progress: view.progress, summary };
    const { state, code, ...result } = budgetedResult(view.result);
    if (state === "failed") throw toolError(code, { jobId, ...result });
    if (state === "revoked") throw revoked({ jobId, ...result });
    return { status: state, jobId, ...result, ...(code ? { code } : {}), summary };
  }
}
