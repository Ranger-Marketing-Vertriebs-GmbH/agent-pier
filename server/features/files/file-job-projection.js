import { projectConflict } from "./file-job-handlers.js";
import { archiveValidationMatches } from "./file-archive-store.js";

// This is a bounded metadata observation. Only artifact GET opens/proves current bytes.
function archiveDetails(row, doc, store) {
  const operation = row.operation && JSON.parse(row.operation);
  const output = operation?.options.output;
  if (!["download", "file"].includes(output)) return {};
  const archive = doc.archive;
  const record = archive?.publicationId && store.getPublication(archive.publicationId);
  const evidence = record?.document;
  const binding = evidence?.archive;
  return {
    archiveOutput: output,
    ...(archive?.manifestVersion ? { manifestVersion: archive.manifestVersion } : {}),
    ...(output === "file" && typeof archive?.target === "string"
      ? { destination: archive.target }
      : {}),
    artifactReady: Boolean(
      output === "download" &&
      row.status === "completed" &&
      archive?.completed &&
      archive.scope.id === row.scope_id &&
      record?.jobId === row.id &&
      record.phase === "artifact" &&
      evidence.archiveCompleted &&
      evidence.scopeId === row.scope_id &&
      /^[a-f0-9]{64}$/.test(evidence.archiveProof?.hash) &&
      Number.isSafeInteger(evidence.archiveProof?.bytes) &&
      evidence.archiveProof.bytes >= 0 &&
      evidence.archiveProof.bytes <= archive.outputLimit &&
      !evidence.archiveDiscarded &&
      !evidence.archiveChanged &&
      binding?.id === row.id &&
      binding.scopeId === row.scope_id &&
      binding.mode === output &&
      binding.target === archive.target &&
      binding.manifestVersion === archive.manifestVersion &&
      binding.consent === (archive.consent || null) &&
      archiveValidationMatches(evidence),
    ),
  };
}

export function publicFileJob(row, store) {
  const doc = JSON.parse(row.document);
  return {
    id: row.id,
    kind: row.kind,
    scopeId: row.scope_id,
    status: row.status,
    completedEntries: doc.completedEntries,
    totalEntries: doc.totalEntries,
    completedBytes: doc.completedBytes,
    totalBytes: doc.totalBytes,
    conflict: projectConflict(doc.conflict),
    issue: doc.issue,
    ...(row.kind === "extract" ? { destination: JSON.parse(row.operation).target } : {}),
    ...(row.kind === "archive" ? archiveDetails(row, doc, store) : {}),
  };
}
