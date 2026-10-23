import { sftpProblem } from "../sftp/sftp-errors.js";
import { problemCode } from "../sftp/sftp-gate.js";
import { runDelete, sftpMkdir, sftpRename } from "../sftp/sftp-operations.js";
import { budgetedResult } from "../sftp/sftp-summary.js";
import { runTransfer } from "../sftp/sftp-transfer.js";
import { sftpPermits } from "./agent-sftp-policy.js";
import { toolReason } from "./tool-errors.js";

// The newest trusted SFTP rows kept per agent (like trusted SSH runs); the audit
// keeps the rest.
export const trustedSftpRows = 500;
const CANCEL_WAIT_MS = 10000;
const AUDIT_PATH_CHARS = 1024;
const resultKeys = [
  "state",
  "files",
  "bytes",
  "created",
  "updated",
  "deleted",
  "dirs",
  "skipped",
  "failedPath",
  "code",
  "durationMs",
];
const capped = (value) =>
  typeof value === "string" ? value.slice(0, AUDIT_PATH_CHARS) : undefined;
const defined = (fields) =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));

// What a row keeps of a plan: counts, never the path lists.
function rowSummary({ type, summary }) {
  if (type !== "transfer") return summary;
  const { kind, files, bytes, overwrites, deletes } = summary;
  return { kind, files, bytes, overwrites, deletes };
}

/**
 * The jobs of agent SFTP transfers and writes and their action rows. Each job holds
 * one row (state `executing`, settled for the workflows tick like a trusted SSH
 * row): progress is patched at most once a second, the result settles it and is
 * audited as `sftp.completed` or `sftp.failed`. The row's id is the job id the agent
 * polls; a row whose job died with a restart reads `unknown` (the store marks
 * executing rows so at startup). A running job re-checks the agent, the grant, its
 * mode and the host's connection revision before every file and every 2 s; the turn
 * that started it may end meanwhile.
 */
export class SftpRuns {
  constructor(sftp) {
    this.sftp = sftp;
    // action id -> { owner, jobId } and job id -> action id, while the job is kept.
    this.byAction = new Map();
    this.byJob = new Map();
    this.unsubscribe = sftp.jobs.onProgress((view) => this.progressed(view));
  }
  get w() {
    return this.sftp.w;
  }
  /**
   * Starts the job and reserves its row (or, with `actionId`, an approved card's
   * row becomes it). Without `session`/`access` it opens its own at the host's pinned
   * revision. Returns `{ id, owner, jobId }`; `SFTP_BUSY` leaves no row.
   */
  start({
    caller,
    cls,
    mode,
    host,
    request,
    prepared,
    authorizedBy,
    key,
    actionId,
    session = null,
    access = null,
    leadAssistantId,
  }) {
    const owner = caller.assistant.id;
    const subject = { accessId: request.accessId, operation: request.operation };
    access ??= this.sftp.access(caller, cls, subject, host);
    const stillAuthorized = () =>
      this.stillAuthorized({
        owner,
        host,
        access,
        authorizedBy,
        cls,
        kind: request.kind,
      });
    const work = this.work(prepared, access, stillAuthorized);
    const meta = {
      owner,
      caller,
      cls,
      mode,
      host,
      request,
      authorizedBy,
      leadAssistantId,
    };
    let id = actionId;
    this.sweep();
    const view = this.sftp.jobs.start(owner, {
      kind: request.operation,
      summary: prepared.summary,
      lock: { hostId: host.id, ...prepared.lock },
      run: (progress, signal) =>
        this.execute({ id, meta, session, access, work }, progress, signal),
    });
    const now = Date.now();
    try {
      id = actionId
        ? this.w.store.patch(actionId, {
            state: "executing",
            chatNotes: { ...this.w.store.get(actionId).chatNotes, started: { at: now } },
          }).id
        : this.reserve(key, meta, prepared, now).id;
    } catch (error) {
      this.sftp.jobs.cancel(owner, view.jobId);
      throw error;
    }
    this.byAction.set(id, { owner, jobId: view.jobId });
    this.byJob.set(view.jobId, id);
    this.w.a.changed({ conversationId: caller.conversationId });
    return { id, owner, jobId: view.jobId };
  }
  reserve(key, { caller, cls, host, request, authorizedBy }, prepared, now) {
    return this.w.store.reserve({
      assistantId: caller.assistant.id,
      conversationId: caller.conversationId,
      attemptId: caller.attemptId,
      origin: caller.origin || { kind: "routine" },
      key,
      state: "executing",
      expiresAt: now,
      payload: defined({
        action: "sftp",
        trusted: authorizedBy === "mode",
        operation: request.operation,
        accessId: host.id,
        hostName: host.name,
        remotePath: request.remotePath,
        toPath: request.toPath,
        local: request.local,
        direction: request.direction,
        summary: rowSummary(prepared),
        originClass: cls,
      }),
      chatNotes: { started: { at: now } },
      ...(cls === "delegated" ? { memberName: caller.assistant.name } : {}),
      settled: true,
    });
  }
  work(prepared, access, stillAuthorized) {
    const everyMs = this.sftp.authorizeEveryMs;
    if (prepared.type === "transfer")
      return (session, progress, signal) =>
        runTransfer(session, prepared.transfer, {
          signal,
          onProgress: progress,
          stillAuthorized,
          reopen: access.open,
          authorizeEveryMs: everyMs,
        });
    if (prepared.type === "delete")
      return (session, progress, signal) => {
        progress({ files: prepared.plan.files.length, bytes: prepared.plan.bytes });
        return runDelete(session, prepared.plan, {
          signal,
          root: prepared.root,
          stillAuthorized,
          authorizeEveryMs: everyMs,
          onProgress: ({ files, current }) => progress({ filesDone: files, current }),
        });
      };
    const change =
      prepared.type === "mkdir"
        ? (session) => sftpMkdir(session, prepared.target, { parents: prepared.parents })
        : (session) => sftpRename(session, prepared.from, prepared.to);
    return async (session, _progress, signal) => {
      signal.throwIfAborted();
      if (!(await stillAuthorized())) return { state: "revoked" };
      return { state: "completed", ...(await change(session)) };
    };
  }
  async execute({ id, meta, session, access, work }, progress, signal) {
    const started = Date.now();
    let open = session;
    let outcome;
    try {
      open ??= await access.open();
      outcome = await work(open, progress, signal);
    } catch (error) {
      outcome = signal.aborted
        ? { state: "cancelled", code: problemCode(signal.reason) }
        : { state: "failed", code: problemCode(error) };
    } finally {
      open?.close();
    }
    if (outcome.state === "revoked") outcome.code = "SSH_REVOKED";
    outcome.durationMs ??= Date.now() - started;
    // A job whose row could not be reserved was cancelled before it began.
    if (id) this.settle(id, outcome, meta);
    return outcome;
  }
  /** The authorization a running job keeps: agent, grant, mode and host revision. */
  stillAuthorized({ owner, host, access, authorizedBy, cls, kind }) {
    try {
      this.w.access.sshHolder(owner);
      if (this.sftp.ssh.catalog.revision(host.id) !== access.revision) return false;
      const grant = this.w.access.sshGrant(owner, host.id);
      if (!grant) return false;
      return authorizedBy === "approval" || sftpPermits(grant.mode, cls, kind) === "run";
    } catch {
      return false;
    }
  }
  progressed(view) {
    const id = this.byJob.get(view.jobId);
    if (!id || view.state !== "running") return;
    try {
      const row = this.w.store.get(id);
      if (row.state !== "executing") return;
      this.w.store.patch(id, { progress: view.progress });
      this.w.a.changed({ conversationId: row.conversationId });
    } catch {
      // A pruned or closed store never stops the job.
    }
  }
  settle(
    id,
    outcome,
    { owner, caller, cls, mode, host, request, authorizedBy, ...rest },
  ) {
    const completed = outcome.state === "completed";
    try {
      const row = this.w.store.get(id);
      const state = outcome.state === "revoked" ? "failed" : outcome.state;
      const result = defined(Object.fromEntries(resultKeys.map((k) => [k, outcome[k]])));
      if (Array.isArray(outcome.overwritten))
        result.overwrites = outcome.overwritten.length;
      this.w.store.patch(id, {
        state,
        ...(completed ? {} : { diagnostic: outcome.code ?? "SFTP_FAILED" }),
        result,
        chatNotes: { ...row.chatNotes, result: { at: Date.now(), state } },
      });
      if (row.payload.trusted) this.w.store.pruneTrusted(owner, "sftp", trustedSftpRows);
      this.w.a.changed({ conversationId: caller.conversationId });
    } catch (error) {
      console.error("Agent SFTP row failed:", error?.message);
    }
    const details = defined({
      assistantId: owner,
      hostName: host.name,
      originClass: cls,
      authorizedBy,
      mode,
      leadAssistantId: rest.leadAssistantId,
      operation: request.operation,
      direction: request.direction,
      state: outcome.state,
      files: outcome.files,
      bytes: outcome.bytes,
      deleted: request.operation === "delete" ? outcome.files : outcome.deleted,
      dirs: outcome.dirs,
      durationMs: outcome.durationMs,
      remotePath: capped(request.remotePath),
      localPath: capped(request.local?.path),
      code: completed ? undefined : (outcome.code ?? "SFTP_FAILED"),
    });
    const audit = (action, verdict) =>
      this.sftp.ssh.audit(action, verdict, host.id, details);
    if (completed) audit("sftp.completed", "success");
    else audit("sftp.failed", "failure");
  }
  /** Waits for the job until the call's hold ends; a job still running is followed up. */
  async hold(inv, { id, owner, jobId }) {
    inv.undelivered = () => this.markFollowUp(id);
    const left = Math.max(
      0,
      (inv.startedAt ?? Date.now()) + this.sftp.holdMs - Date.now(),
    );
    const view = await this.sftp.jobs.wait(owner, jobId, left);
    if (view.state === "running") this.markFollowUp(id);
    return this.answer(id);
  }
  markFollowUp(id) {
    try {
      const row = this.w.store.get(id);
      if (!row.followUp) this.w.store.patch(id, { followUp: true });
    } catch {}
  }
  /** `job` reports one of the agent's SFTP rows; `cancel` stops its job first. */
  async tool(inv, { action, jobId }) {
    const caller = this.sftp.ssh.caller(inv);
    let row;
    try {
      row = this.w.store.get(jobId);
    } catch {
      throw sftpProblem("SFTP_JOB_NOT_FOUND");
    }
    if (row.assistantId !== caller.assistant.id || row.payload?.action !== "sftp")
      throw sftpProblem("SFTP_JOB_NOT_FOUND");
    // Content the owner did not write (forwarded, member results) never stops a job.
    if (action === "cancel" && this.sftp.ssh.classify(caller) === "refused")
      throw this.sftp.refuse(
        caller,
        "refused",
        { accessId: row.payload.accessId, operation: row.payload.operation },
        "sshOriginRefused",
      );
    const entry = this.byAction.get(row.id);
    if (action === "cancel" && entry)
      try {
        this.sftp.jobs.cancel(entry.owner, entry.jobId);
        await this.sftp.jobs.wait(entry.owner, entry.jobId, CANCEL_WAIT_MS);
      } catch {
        // An expired job has nothing left to stop.
      }
    return this.answer(row.id);
  }
  answer(id) {
    const row = this.w.store.get(id);
    const entry = this.byAction.get(id);
    let view = null;
    try {
      view = entry ? this.sftp.jobs.get(entry.owner, entry.jobId) : null;
    } catch {}
    const base = {
      jobId: id,
      accessId: row.payload.accessId,
      host: row.payload.hostName,
      operation: row.payload.operation,
    };
    if (row.state === "executing" && view?.state === "running")
      return {
        status: "running",
        ...base,
        progress: view.progress,
        notice:
          "The job runs in the background. Check it with action job and this jobId; action cancel stops it. Do not start it again.",
      };
    if (!["completed", "failed", "cancelled"].includes(row.state))
      return {
        status: row.state === "executing" ? "unknown" : row.state,
        ...base,
        notice:
          "AgentPier lost this job (for example after a restart). Check the remote state with list or stat before you retry.",
      };
    const { state, code, ...counts } = row.result || {};
    const status = state ?? row.state;
    const overwritten = view?.result?.overwritten;
    return {
      status,
      ...base,
      ...counts,
      ...(Array.isArray(overwritten) ? budgetedResult({ overwritten }) : {}),
      ...(code ? { code } : {}),
      ...(["failed", "revoked"].includes(status) ? { reason: toolReason(code) } : {}),
    };
  }
  // Forgets jobs SftpJobs no longer keeps.
  sweep() {
    for (const [id, { owner, jobId }] of this.byAction)
      try {
        this.sftp.jobs.get(owner, jobId);
      } catch {
        this.byAction.delete(id);
        this.byJob.delete(jobId);
      }
  }
  close() {
    this.unsubscribe();
    this.sftp.jobs.closeAll();
  }
}
