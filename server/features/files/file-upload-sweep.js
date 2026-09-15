import { terminalStates } from "./file-schema.js";
import { discardUploadPayload } from "./file-upload-publication.js";

export async function recoverUploads(owner) {
  const { journal, store, barrier } = owner;
  for (let cursor = ""; ;) {
    const page = journal.page("uploads", cursor);
    if (!page.length) break;
    for (const upload of page) {
      await barrier.run(() => {
        const job = store.getJob(upload.scope, upload.id);
        if (upload.published && journal.finish(upload.scope, upload.id)) return;
        if (!upload.completed && !upload.skipped)
          journal.updateRow(upload.id, {
            status: upload.published ? "published" : job.status,
          });
      });
    }
    cursor = page.at(-1).id;
  }
  for (let cursor = ""; ;) {
    const page = journal.page("upload_groups", cursor);
    if (!page.length) break;
    for (const group of page)
      await barrier.run(() => {
        for (const row of journal.rows(group.id))
          if (
            !["completed", "skipped", "published", "failed", "cancelled"].includes(
              row.status,
            )
          )
            store.putEntry(group.id, { ...row, status: "interrupted" });
        journal.refresh(group.id);
        if (
          group.committed &&
          journal
            .rows(group.id)
            .every((row) => ["completed", "skipped"].includes(row.status))
        )
          owner.groups.aggregate(group.scope, group.id);
      });
    cursor = page.at(-1).id;
  }
}
export async function sweepUploads(owner, now) {
  const { journal, store, jobs, barrier, publisher } = owner;
  for (let cursor = ""; ;) {
    const page = journal.page("uploads", cursor);
    if (!page.length) break;
    for (const upload of page) {
      if (owner.closed) return;
      if (
        upload.completed ||
        upload.skipped ||
        upload.published ||
        now - upload.lastActivity < owner.limits.uploadRetentionMs
      )
        continue;
      const claimed = await barrier.run(() => {
        const fresh = journal.attempt(upload.id);
        if (
          !fresh ||
          owner.receivers.has(upload.id) ||
          owner.initializing.has(upload.id) ||
          jobs.owns(upload.id) ||
          fresh.published ||
          fresh.completed ||
          fresh.skipped ||
          now - fresh.lastActivity < owner.limits.uploadRetentionMs
        )
          return false;
        fresh.sweeping = true;
        journal.save("uploads", upload.id, fresh);
        return true;
      });
      if (!claimed) continue;
      try {
        await jobs.interruptReservation(upload.scope, upload.id);
        const record = upload.publicationId && store.getPublication(upload.publicationId);
        if (record && record.phase !== "resolved")
          await discardUploadPayload(publisher, record);
        await barrier.run(() => journal.updateRow(upload.id, { status: "interrupted" }));
      } catch (error) {
        if (!error.code?.startsWith("FILE_")) throw error;
        // Observed mismatch or unresolved publication remains registered and pinned.
      } finally {
        await barrier.run(() => {
          const fresh = journal.attempt(upload.id);
          fresh.sweeping = false;
          journal.save("uploads", upload.id, fresh);
        });
      }
    }
    cursor = page.at(-1).id;
  }
  for (let cursor = ""; ;) {
    const page = journal.page("upload_groups", cursor);
    if (!page.length) break;
    for (const group of page)
      await barrier.run(() => {
        if (
          now - group.lastActivity < owner.limits.uploadRetentionMs ||
          jobs.owns(group.id)
        )
          return;
        const rows = journal.rows(group.id);
        if (
          rows.some(
            (row) =>
              row.currentJobId &&
              (jobs.owns(row.currentJobId) ||
                owner.receivers.has(row.currentJobId) ||
                journal.unresolved(row.currentJobId)),
          )
        )
          return;
        const job = jobs.get(group.scope, group.id);
        if (!terminalStates.includes(job.status)) {
          jobs.reservations.delete(group.id);
          store.transition(group.id, job.status, "interrupted");
        }
        for (const row of rows)
          if (["pending", "ready", "queued"].includes(row.status))
            store.putEntry(group.id, { ...row, status: "interrupted" });
      });
    cursor = page.at(-1).id;
  }
}
