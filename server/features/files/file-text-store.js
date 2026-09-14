import { fileProblem } from "./file-errors.js";

const invalid = () => fileProblem("FILE_INVALID_OPERATION", 400);
export function validateTextOperation(operation) {
  const o = operation?.options;
  return (
    operation?.kind === "text_save" &&
    operation.sources?.length === 0 &&
    typeof operation.target === "string" &&
    operation.name === null &&
    !operation.parentJobId &&
    !operation.entryId &&
    o &&
    Object.keys(o).sort().join() === "bytes,hash,revision" &&
    Number.isSafeInteger(o.bytes) &&
    o.bytes >= 0 &&
    typeof o.hash === "string" &&
    /^[a-f0-9]{64}$/.test(o.hash) &&
    (o.revision === null ||
      (typeof o.revision === "string" && /^d1:[a-f0-9]{64}$/.test(o.revision)))
  );
}

/** Private text metadata within the existing job/publication journal. No draft bytes. */
export class FileTextStore {
  constructor(store) {
    this.store = store;
  }
  transaction(action) {
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.store.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }
  get(id) {
    return this.store.jobDetails(id)?.textSave;
  }
  put(id, value) {
    this.store.setJobDetails(id, { textSave: value });
  }
  bind(scope, id, target) {
    const job = this.store.getJob(scope, id),
      op = this.store.getOperation(id),
      saved = this.get(id);
    if (
      job.kind !== "text_save" ||
      !validateTextOperation(op) ||
      op.target !== target ||
      !saved ||
      saved.publicationId
    )
      throw invalid();
    return { jobId: id, scopeId: scope.id, path: target, ...op.options };
  }
  register(state, write) {
    const binding = state.document.textSave,
      saved = this.get(state.jobId);
    if (
      !saved ||
      binding.jobId !== state.jobId ||
      (saved.publicationId && saved.publicationId !== state.id)
    )
      throw invalid();
    return this.transaction(() => {
      this.put(state.jobId, { ...saved, publicationId: state.id });
      return write();
    });
  }
  complete(record, observation) {
    const binding = record.document.textSave,
      saved = this.get(record.jobId);
    const op = this.store.getOperation(record.jobId);
    if (
      !binding ||
      !saved ||
      !validateTextOperation(op) ||
      binding.jobId !== record.jobId ||
      binding.scopeId !== record.document.scopeId ||
      binding.path !== op.target ||
      record.document.selectedPath !== op.target ||
      saved.publicationId !== record.id ||
      binding.hash !== op.options.hash ||
      binding.bytes !== op.options.bytes ||
      binding.revision !== op.options.revision ||
      record.document.textProof?.hash !== binding.hash ||
      record.document.textProof?.bytes !== binding.bytes
    )
      throw invalid();
    if (record.document.textCompleted) return;
    const result = saved.result || {
      path: binding.path,
      revision: observation?.revision,
      metadataRevision: observation?.metadataRevision,
    };
    if (
      !/^d1:[a-f0-9]{64}$/.test(result.revision) ||
      !/^e1:[a-f0-9]{64}$/.test(result.metadataRevision)
    )
      throw invalid();
    const document = { ...record.document, textCompleted: true };
    this.transaction(() => {
      this.put(record.jobId, { ...saved, result });
      this.store.putEntry(record.jobId, {
        id: "text",
        path: binding.path,
        type: "file",
        size: binding.bytes,
        status: "published",
        outputPublished: true,
        revision: result.revision,
      });
      this.store.putPublication({ ...record, document });
    });
    Object.assign(record.document, document);
  }
  finish(scope, id) {
    const saved = this.get(id);
    if (saved?.complete) return saved.result;
    if (!saved?.result || !saved.publicationId) return null;
    const record = this.store.getPublication(saved.publicationId);
    if (
      !record ||
      record.jobId !== id ||
      record.phase !== "resolved" ||
      !record.document.textCompleted
    )
      return null;
    if (record.document.expectedIdentity !== null) {
      const displaced = this.store.getTrash(record.id);
      if (displaced?.phase !== "recoverable" || !displaced.adoptionComplete) return null;
    }
    this.transaction(() => {
      this.put(id, { ...saved, complete: true });
      this.store.putEntry(id, {
        ...this.store.getEntry(id, "text"),
        status: "completed",
      });
      const job = this.store.getJob(scope, id);
      this.store.transition(id, job.status, "completed", {
        completedEntries: 1,
        completedBytes: record.document.textSave.bytes,
        issue: null,
      });
    });
    return saved.result;
  }
}
