import { fileClientIssue } from "./file-api.js";
import { checkedJob } from "./file-upload-observer.js";

const invalid = () => fileClientIssue("FILE_INVALID_RESPONSE", 502);
const conflictChanged = () => fileClientIssue("FILE_CONFLICT_CHANGED", 409);

/** Explicit history/result reviews borrow the sole metadata queue and generation. */
export class FileJobObserver {
  constructor(session) {
    this.session = session;
    this.proposals = new Map();
    this.attempts = new Map();
    this.inspect = (scopeId, id) =>
      session.enqueue(async (signal, owns) => {
        const job = checkedJob(
          await session.client.get(`/jobs/${encodeURIComponent(id)}`, {}, signal),
          scopeId,
          id,
        );
        if (!owns()) return;
        session.accept(job, true);
        return session.readEntries(id, null, signal, owns, true);
      });
    this.omissions = (scopeId, job, maxEntries) =>
      session.enqueue(async (signal, owns) => {
        const conflict = job.conflict;
        if (
          job.kind !== "archive" ||
          conflict?.type !== "archive_links" ||
          !conflict.manifestVersion
        )
          throw invalid();
        const entries = await this.pages(
          `/jobs/${encodeURIComponent(job.id)}/entries`,
          {},
          signal,
          owns,
          maxEntries,
          (page) => {
            if (
              page.entries.some((row) => row.manifestVersion !== conflict.manifestVersion)
            )
              throw conflictChanged();
          },
        );
        const current = checkedJob(
          await session.client.get(`/jobs/${encodeURIComponent(job.id)}`, {}, signal),
          scopeId,
          job.id,
        );
        if (!owns()) return;
        session.accept(current, true);
        if (
          current.status !== "waiting_for_conflict" ||
          current.conflict?.id !== conflict.id ||
          current.conflict?.manifestVersion !== conflict.manifestVersion
        )
          throw conflictChanged();
        const omitted = entries.filter(
          // Only a complete generation may authorize omission consent.
          (row) => row.status === "skipped" && ["symlink", "special"].includes(row.type),
        );
        if (
          !Number.isSafeInteger(current.totalEntries) ||
          entries.length !== current.totalEntries
        )
          throw invalid();
        if (!omitted.length) throw invalid();
        return {
          conflictId: conflict.id,
          manifestVersion: conflict.manifestVersion,
          entries: omitted,
        };
      });
    this.retryPreview = (scopeId, id, maxEntries) =>
      session.enqueue(async (signal, owns) => {
        const uncertain = this.attempts.get(id);
        if (uncertain) {
          if (uncertain.scopeId !== scopeId) throw invalid();
          return { ...uncertain.proposal, attempt: uncertain.body };
        }
        checkedJob(
          await session.client.get(`/jobs/${encodeURIComponent(id)}`, {}, signal),
          scopeId,
          id,
        );
        let reference, totalEntries;
        const entries = await this.pages(
          `/jobs/${encodeURIComponent(id)}/retry`,
          {},
          signal,
          owns,
          maxEntries,
          (page) => {
            if (
              !/^r1:[a-f0-9]{64}$/.test(page.reference) ||
              !Number.isSafeInteger(page.totalEntries) ||
              page.totalEntries < 1 ||
              page.totalEntries > maxEntries ||
              (reference &&
                (reference !== page.reference || totalEntries !== page.totalEntries))
            )
              throw invalid();
            reference = page.reference;
            totalEntries = page.totalEntries;
          },
        );
        if (entries.length !== totalEntries) throw invalid();
        const proposal = { reference, totalEntries, entries };
        this.proposals.set(id, proposal);
        return proposal;
      });
    this.retry = async (scopeId, id, body) => {
      const prior = this.attempts.get(id);
      if (
        prior &&
        (prior.body.requestId !== body.requestId ||
          prior.body.reference !== body.reference)
      )
        throw invalid();
      this.attempts.set(
        id,
        prior || {
          scopeId,
          body: structuredClone(body),
          proposal: this.proposals.get(id),
        },
      );
      let job;
      try {
        job = await session.action(
          `/jobs/${encodeURIComponent(id)}/retry`,
          scopeId,
          body,
          true,
        );
      } catch (error) {
        if (error.status && error.status < 500) this.attempts.delete(id);
        throw error;
      }
      this.attempts.delete(id);
      this.proposals.delete(id);
      return job;
    };
  }
  async pages(suffix, query, signal, owns, maxEntries, validate) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw invalid();
    const entries = [],
      ids = new Set(),
      cursors = new Set();
    let cursor = null;
    do {
      const page = await this.session.client.get(suffix, { ...query, cursor }, signal);
      if (!owns()) throw new DOMException("Aborted", "AbortError");
      if (
        !Array.isArray(page.entries) ||
        page.entries.length > 200 ||
        (page.nextCursor !== null &&
          (typeof page.nextCursor !== "string" || !page.nextCursor))
      )
        throw invalid();
      validate(page);
      for (const row of page.entries) {
        if (typeof row.id !== "string" || !row.id || ids.has(row.id)) throw invalid();
        ids.add(row.id);
        entries.push(row);
      }
      if (
        entries.length > maxEntries ||
        (page.nextCursor && (!page.entries.length || cursors.has(page.nextCursor)))
      )
        throw invalid();
      cursor = page.nextCursor;
      cursors.add(cursor);
    } while (cursor);
    return entries;
  }
}
