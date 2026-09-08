import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { problem } from "../../lib/storage.js";
import { RunStore, runId } from "./run-store.js";
import { compileSnapshot, activeNode, terminal } from "./graph-navigation.js";
import { advance } from "./execution-stage.js";
import {
  availableActions,
  gateAction,
  cancelRun,
  requireLiveRun,
} from "./pipeline-actions.js";
import { reconcileRun } from "./pipeline-recovery.js";
import { provisionRun } from "./execution-workspace.js";
import { readVerdict } from "./stage-verdict.js";
import {
  artifactsForNode,
  artifactText,
  stageDiff,
  verificationLog,
} from "./artifact-reader.js";
import {
  VerificationRunner,
  beginVerification,
  settleVerification,
} from "./verify-runner.js";

export class PipelineEngine {
  constructor({
    dataDir,
    definitions,
    driver,
    workspace,
    verify,
    clock = Date,
    pollIntervalMs = 2000,
    onError = () => {},
    mutationBarrier,
    onChange,
  }) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.store = new RunStore(dataDir, onChange);
    this.definitions = definitions;
    this.driver = driver;
    this.workspace = workspace;
    this.verify = verify || new VerificationRunner({ directory: this.store.directory });
    this.clock = clock;
    this.onError = onError;
    this.mutationBarrier = mutationBarrier;
    this.locks = new Map();
    this.closed = false;
    this.ticking = false;
    if (pollIntervalMs > 0) {
      this.timer = setInterval(() => {
        this.reconcile().catch((e) => this.recordError(e));
      }, pollIntervalMs);
      this.timer.unref();
    }
  }
  nowMs() {
    return typeof this.clock.now === "function" ? this.clock.now() : Date.now();
  }
  now() {
    return new Date(this.nowMs()).toISOString();
  }
  recordError(error) {
    this.onError(error);
  }
  async lock(id, fn) {
    if (this.mutationBarrier && !this.mutationBarrier.hasLease())
      return this.mutationBarrier.run(() => this.lock(id, fn));
    if (this.closed || this.closing) throw problem("Pipeline engine is closed.", 503);
    const prior = this.locks.get(id) || Promise.resolve();
    const next = prior.catch(() => {}).then(fn);
    this.locks.set(id, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(id) === next) this.locks.delete(id);
    }
  }
  get(id) {
    const run = this.store.get(id);
    run.actions = availableActions(run);
    return run;
  }
  list({ page = 1, status, projectId } = {}) {
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000)
      throw problem("Invalid pipeline page.");
    if (
      status !== undefined &&
      !["running", "awaiting-human", "completed", "failed", "cancelled"].includes(status)
    )
      throw problem("Invalid pipeline status.");
    const all = this.store
      .all()
      .filter(
        (r) =>
          (!status || r.status === status) && (!projectId || r.projectId === projectId),
      );
    return {
      runs: all
        .slice((page - 1) * 20, page * 20)
        .map((r) => ({ ...r, actions: availableActions(r) })),
      total: all.length,
      page,
      pageSize: 20,
    };
  }
  hasActiveRuns(pipelineId) {
    return this.store
      .all()
      .some((run) => run.pipelineId === pipelineId && !terminal(run));
  }
  profileStats(profileId) {
    const cutoff = this.nowMs() - 7 * 86400000;
    const attempts = new Set();
    for (const run of this.store.all())
      for (const entry of run.executionLog) {
        const node = run.nodes.find((node) => node.id === entry.nodeId);
        if (
          node?.profileSnapshot.id === profileId &&
          Date.parse(entry.startedAt) >= cutoff
        )
          attempts.add(entry.attemptId);
      }
    return { stageRunsLast7Days: attempts.size };
  }
  async start(
    { pipelineId, cwd, task, baseBranch } = {},
    { id: reservedId, expectedProjectId } = {},
  ) {
    if (this.mutationBarrier && !this.mutationBarrier.hasLease())
      return this.mutationBarrier.run(() =>
        this.start(
          { pipelineId, cwd, task, baseBranch },
          { id: reservedId, expectedProjectId },
        ),
      );
    if (this.closed || this.closing) throw problem("Pipeline engine is closed.", 503);
    if (
      typeof cwd !== "string" ||
      !path.isAbsolute(cwd) ||
      typeof task !== "string" ||
      !task.trim() ||
      Buffer.byteLength(task) > 65536
    )
      throw problem("A working directory and task are required.");
    const snapshot = this.definitions.snapshot(pipelineId),
      compiled = compileSnapshot(snapshot),
      id = reservedId === undefined ? randomUUID() : runId(reservedId);
    const initial = {
      id,
      pipelineId: snapshot.pipeline.id,
      pipelineName: snapshot.pipeline.name,
      pipelineRevision: snapshot.pipeline.revision,
      task,
      cwd,
      baseBranch: baseBranch ?? null,
      projectId: null,
      ...(expectedProjectId !== undefined
        ? { expectedProjectId: runId(expectedProjectId) }
        : {}),
      workingDir: "",
      branch: null,
      workspace: null,
      ...compiled,
      currentNodeId: compiled.entry,
      currentAttemptId: null,
      status: "running",
      phase: "provisioning",
      activeTurn: null,
      verifyJob: null,
      loopState: {},
      executionLog: [],
      usage: null,
      usageResumeAt: null,
      pullRequestUrl: null,
      createdAt: this.now(),
      finishedAt: null,
    };
    this.store.create(initial);
    await this.lock(id, () => provisionRun(this, this.store.get(id)));
    return this.get(id);
  }
  async gate(id, input) {
    await this.lock(id, () => gateAction(this, this.store.get(id), input));
    return this.get(id);
  }
  async cancel(id) {
    await this.lock(id, () => cancelRun(this, this.store.get(id)));
    return this.get(id);
  }
  async retry(id) {
    await this.lock(id, async () => {
      const run = this.store.get(id);
      requireLiveRun(run);
      if (!availableActions(run).includes("retry"))
        throw problem("This stage cannot be retried.", 409);
      if (activeNode(run)?.failReason === "pr-failed")
        await advance(this, run, activeNode(run));
      else await gateAction(this, run, { action: "retry" });
    });
    return this.get(id);
  }
  async createPr(id) {
    await this.lock(id, async () => {
      const run = this.store.get(id);
      requireLiveRun(run);
      if (!terminal(run))
        throw problem("Finish or cancel the run before publishing its branch.", 409);
      if (run.pullRequestUrl) return;
      const pr = await this.workspace.createPr({ workspace: run.workspace, run });
      run.pullRequestUrl = pr.url;
      this.store.save(run);
    });
    return this.get(id);
  }
  async delete(id) {
    await this.lock(id, async () => {
      const run = this.store.get(id);
      if (!terminal(run)) throw problem("Cancel the run before deleting it.", 409);
      if (run.workspace) await this.workspace.remove({ workspace: run.workspace });
      this.store.remove(id);
    });
  }
  async reconcile() {
    if (this.closed || this.closing || this.ticking) return;
    this.ticking = true;
    try {
      for (const r of this.store.all()) {
        if (this.closing) break;
        if (terminal(r) || r.imported?.historyOnly) continue;
        await this.lock(r.id, () => reconcileRun(this, this.store.get(r.id))).catch((e) =>
          this.recordError(e),
        );
      }
    } finally {
      this.ticking = false;
    }
  }
  async recover() {
    await this.reconcile();
  }
  beginVerification(run, node) {
    return beginVerification(this, run, node);
  }
  settleVerification(run) {
    return settleVerification(this, run);
  }
  verdictStatus(id) {
    const run = this.store.get(id);
    requireLiveRun(run);
    const found = readVerdict(
      run,
      run.executionLog.find((a) => a.id === run.currentAttemptId),
    );
    return {
      ...found,
      verdict: undefined,
      ...(found.verdict ? { result: found.verdict.result } : {}),
    };
  }
  artifacts(id, nodeId) {
    return artifactsForNode(this.store.get(id), nodeId);
  }
  artifact(id, nodeId, file) {
    const run = this.store.get(id);
    requireLiveRun(run);
    return artifactText(run, nodeId, file);
  }
  diff(id, nodeId) {
    const run = this.store.get(id);
    requireLiveRun(run);
    return stageDiff(this, run, nodeId);
  }
  verifyLogs(id, nodeId, index) {
    return verificationLog(this, this.store.get(id), nodeId, index);
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      clearInterval(this.timer);
      await Promise.allSettled([...this.locks.values()]);
      await this.verify.close?.();
      this.closed = true;
      this.store.close();
    })();
    return this.closePromise;
  }
}
