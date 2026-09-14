import { fileProblem } from "./file-errors.js";
import { planRetry, assertRetryOwner, retryUnavailable } from "./file-retry-plan.js";

/** Explicit proposals and admission reuse the existing request and job journal. */
export class FileJobRetries {
  constructor({ jobs, store, trash }) {
    Object.assign(this, { jobs, store, trash });
  }
  async preview(scope, id, cursor) {
    const plan = await planRetry(this, scope, id);
    let offset = 0;
    if (cursor) {
      try {
        const value = JSON.parse(Buffer.from(cursor, "base64url"));
        if (
          value.reference !== plan.reference ||
          !Number.isSafeInteger(value.offset) ||
          value.offset < 0 ||
          value.offset >= plan.entries.length ||
          value.offset % 200
        )
          throw new Error();
        offset = value.offset;
      } catch {
        throw fileProblem("FILE_INVALID_CURSOR", 400);
      }
    }
    const next = offset + 200;
    return {
      reference: plan.reference,
      totalEntries: plan.entries.length,
      entries: plan.entries.slice(offset, next),
      nextCursor:
        next < plan.entries.length
          ? Buffer.from(
              JSON.stringify({ reference: plan.reference, offset: next }),
            ).toString("base64url")
          : null,
    };
  }
  async start(scope, id, body) {
    if (
      !body ||
      Object.keys(body).sort().join() !== "reference,requestId" ||
      typeof body.requestId !== "string" ||
      !/^r1:[a-f0-9]{64}$/.test(body.reference)
    )
      throw fileProblem("FILE_INVALID_OPERATION", 400);
    this.jobs.get(scope, id);
    const prior = this.store.db
      .prepare("SELECT job_id FROM requests WHERE scope_id=? AND request_id=?")
      .get(scope.id, body.requestId);
    if (prior) {
      const operation = this.store.getOperation(prior.job_id);
      if (operation.parentJobId !== id || operation.entryId !== `retry:${body.reference}`)
        throw fileProblem("FILE_REQUEST_CONFLICT", 409);
      return this.jobs.start(scope, operation);
    }
    const plan = await planRetry(this, scope, id);
    if (plan.reference !== body.reference) throw retryUnavailable();
    const operation = {
      ...this.store.getOperation(id),
      requestId: body.requestId,
      parentJobId: id,
      entryId: `retry:${body.reference}`,
    };
    return this.jobs.start(scope, operation, {
      admit: (childId) => {
        assertRetryOwner(this, scope, id, childId);
        // The reference is enough to reconstruct the bounded selection from old rows.
        this.store.setJobDetails(childId, {
          retry: { parentId: id, reference: plan.reference },
        });
      },
    });
  }
  async prepare(scope, id) {
    const retry = this.store.jobDetails(id)?.retry;
    if (!retry) return null;
    const plan = await planRetry(this, scope, retry.parentId, id);
    if (plan.reference !== retry.reference) throw retryUnavailable();
    return {
      operation: { ...plan.operation, requestId: this.store.getOperation(id).requestId },
      retry: { targets: plan.targets, pins: plan.pins },
    };
  }
}
