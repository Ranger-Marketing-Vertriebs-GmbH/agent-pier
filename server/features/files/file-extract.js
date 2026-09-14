import { FileMutations } from "./file-mutations.js";
import { registerFileJobHandler } from "./file-job-handlers.js";
import { fileSystemProblem } from "./file-errors.js";
import { openExtractSource } from "./file-extract-source.js";
import { planExtraction, assertExtractParent } from "./file-extract-plan.js";
import { proveExtractParents, revalidateExtractPolicy } from "./file-extract-probes.js";
import { prepareExtractGroup, decodeExtractEntry } from "./file-extract-payload.js";
import { discardExtractStage } from "./file-extract-stage.js";
import { entryRevision } from "./file-paths.js";
import { retryUnavailable } from "./file-retry-plan.js";

export class FileExtracts extends FileMutations {
  constructor(options) {
    super(options);
    this.limits = options.limits;
  }
  async extractZip(context) {
    context.scope = await this.freshScope(context.scope);
    let source, plan, failure;
    try {
      source = await openExtractSource(
        this.publisher.native,
        context.scope,
        context.operation.sources[0],
        context.signal,
        this.limits,
      );
      const sourceRevision = entryRevision(
        source.selected.stat,
        source.selected.linkIdentity,
      );
      const pin = context.retry?.pins.find(
        (pin) => pin.source === context.operation.sources[0],
      );
      if (
        pin &&
        (pin.revision !== sourceRevision || pin.absolute !== source.selected.absolute)
      )
        throw retryUnavailable();
      // Input observation is private retry authority. Public row revisions describe outputs.
      await this.publisher.barrier.run(() =>
        this.publisher.store.setJobDetails(context.jobId, {
          extractSource: {
            revision: sourceRevision,
            absolute: source.selected.absolute,
            linkIdentity: source.selected.linkIdentity,
          },
        }),
      );
      plan = await planExtraction(this, context, source);
      // Resolve every effective name/parent before proving any sibling namespace.
      await proveExtractParents(this, context, plan);
      const budget = { bytes: 0 };
      for (const group of plan.groups)
        await prepareExtractGroup(this, context, source, group, budget);
      for (const row of plan.rows.filter((row) => row.status === "skipped" || row.merged))
        await decodeExtractEntry(this, context, source, row, null, null, budget);
      await source.assertUnchanged();
      for (const parent of plan.parents.values())
        await revalidateExtractPolicy(this, context, parent);
      for (const group of plan.groups)
        await this.publisher.assertExpected(
          context.scope,
          group.root.path,
          group.root.expectedRevision,
          { expectedTarget: group.root.selected.absolute },
        );
      context.signal.throwIfAborted();
      for (const group of plan.groups)
        await this.publisher.barrier.run(() => {
          context.signal.throwIfAborted();
          const record = this.publisher.store.getPublication(group.stageId);
          const parent = plan.parents.get(group.root.parentKey);
          record.document.extractProof = {
            publicationId: parent.probeId,
            policy: parent.proof,
          };
          record.document.extractValidated = true;
          this.publisher.store.putPublication(record);
        });
      // No input, metadata, decompression or sibling proof remains before first output.
      await source.assertUnchanged();
      await source.close();
      source = null;
      for (const group of plan.groups) {
        context.signal.throwIfAborted();
        const parent = plan.parents.get(group.root.parentKey);
        await revalidateExtractPolicy(this, context, parent);
        const stage = await this.publisher.resumeExtract(context.scope, group.stageId);
        const result = await this.publisher.publish(context.scope, stage, {
          expectedRevision: group.root.expectedRevision,
          refreshScope: () => this.freshScope(context.scope),
          beforeMutation: async () => {
            context.signal.throwIfAborted();
            await revalidateExtractPolicy(this, context, parent);
          },
        });
        if (result.recoveryId)
          await this.trash.adoptDisplaced(context.scope, result.recoveryId);
      }
      for (const row of [...plan.rows].reverse().filter((row) => row.merged)) {
        await assertExtractParent(this, context.scope, { selected: row.selected });
        await this.publisher.barrier.run(() =>
          this.publisher.store.putEntry(context.jobId, {
            ...this.publisher.store.getEntry(context.jobId, row.id),
            status: "completed",
            outputPublished: true,
          }),
        );
      }
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      await source?.close().catch((error) => {
        failure ||= error;
      });
      if (failure && plan)
        for (const group of plan.groups)
          if (group.stageId) {
            const record = this.publisher.store.getPublication(group.stageId);
            if (record.phase !== "resolved" && !record.document.extractCompleted)
              await discardExtractStage(this.publisher, record).catch(() => {});
          }
      if (failure || context.signal.aborted)
        for (const row of plan?.rows || [])
          await this.publisher.barrier.run(() => {
            const store = this.publisher.store,
              current = store.getEntry(context.jobId, row.id);
            if (current && !current.outputPublished && current.status !== "skipped")
              store.putEntry(context.jobId, {
                ...current,
                status: context.signal.aborted ? "cancelled" : "failed",
                issue: context.signal.aborted ? null : fileSystemProblem(failure),
              });
          });
      await this.publisher.barrier.run(() => {
        const store = this.publisher.store,
          job = store.getJob(context.scope, context.jobId);
        const progress = store.refreshTransferProgress(context.jobId);
        if (failure || context.signal.aborted) {
          store.transition(
            context.jobId,
            job.status,
            progress.published
              ? "partially_completed"
              : context.signal.aborted
                ? "cancelled"
                : "failed",
            {
              conflict: null,
              issue: context.signal.aborted ? null : fileSystemProblem(failure),
            },
          );
        }
      });
    }
  }
  async recover() {
    const jobs = new Map();
    for (const record of this.publisher.store.listPublications()) {
      if (!record.document.extract) continue;
      jobs.set(record.jobId, record.document.scope);
      if (record.phase === "swapped")
        await this.trash.adoptDisplaced(record.document.scope, record.id).catch(() => {});
      else if (
        !record.document.extractCompleted &&
        ["staging", "interrupted"].includes(record.phase)
      )
        await discardExtractStage(this.publisher, record).catch(() => {});
    }
    for (const [id, scope] of jobs)
      await this.publisher.barrier.run(() => {
        const store = this.publisher.store,
          job = store.getJob(scope, id);
        const progress = store.refreshTransferProgress(id);
        if (
          progress.published &&
          !["completed", "partially_completed"].includes(job.status)
        )
          store.transition(id, job.status, "partially_completed");
      });
  }
}
export const extractZip = (context) => context.extracts.extractZip(context);
export function registerExtractHandlers(handlers, extracts) {
  registerFileJobHandler(handlers, "extract", (context) => extracts.extractZip(context), {
    public: true,
    transfer: true,
    readOnly: false,
    validate: (op) =>
      op.sources.length === 1 &&
      typeof op.target === "string" &&
      op.name === null &&
      Object.keys(op.options).length === 0,
  });
}
