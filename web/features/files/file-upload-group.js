import { fileClientIssue } from "./file-api.js";

export const uploadRequestId = () => `${Date.now()}:${crypto.randomUUID()}`;
export const metadataBytes = (body) =>
  new TextEncoder().encode(JSON.stringify(body)).length;
export function planUploadGroup(selection, folder, limits) {
  const entries = [
    ...selection.directories.map((relativePath) => ({
      relativePath,
      type: "directory",
      bytes: 0,
    })),
    ...selection.files.map(({ relativePath, file }) => ({
      relativePath,
      type: "file",
      bytes: file.size,
    })),
  ].map((entry) => Object.freeze({ id: crypto.randomUUID(), ...entry }));
  if (
    entries.length > limits.jobEntries ||
    entries.some((entry) => entry.bytes > limits.uploadBytes) ||
    entries.reduce((sum, entry) => sum + entry.bytes, 0) > limits.jobBytes
  )
    throw fileClientIssue("FILE_LIMIT_EXCEEDED", 413);
  const batches = [];
  let batch = { batchId: crypto.randomUUID(), entries: [] };
  for (const entry of entries) {
    const next = { ...batch, entries: [...batch.entries, entry] };
    if (metadataBytes(next) >= 60 * 1024) {
      if (batch.entries.length) batches.push(Object.freeze(batch));
      batch = { batchId: crypto.randomUUID(), entries: [entry] };
      if (metadataBytes(batch) >= 60 * 1024)
        throw fileClientIssue("FILE_LIMIT_EXCEEDED", 413);
    } else batch = next;
  }
  if (batch.entries.length) batches.push(Object.freeze(batch));
  const body = Object.freeze({ requestId: uploadRequestId(), path: folder });
  if (metadataBytes(body) >= 60 * 1024) throw fileClientIssue("FILE_LIMIT_EXCEEDED", 413);
  return { body, batches, acknowledged: 0, groupId: null, committed: false };
}

export async function submitUploadGroup(
  jobs,
  selection,
  { scopeId, plan, maxEntries, owns, cancelled, onGroup },
) {
  const check = async () => {
    if (!owns()) throw new DOMException("Aborted", "AbortError");
    if (!cancelled()) return;
    if (plan.groupId) await jobs.cancel(scopeId, plan.groupId);
    throw new DOMException("Aborted", "AbortError");
  };
  if (!plan.groupId) {
    const created = await jobs.uploadRequest(
      scopeId,
      "/upload-groups",
      plan.body,
      "group",
    );
    if (!created.groupId || created.groupId !== created.job.id)
      throw fileClientIssue("FILE_INVALID_RESPONSE", 502);
    plan.groupId = created.groupId;
    onGroup(plan.groupId);
  }
  await check();
  for (; plan.acknowledged < plan.batches.length; plan.acknowledged++) {
    const body = plan.batches[plan.acknowledged];
    const receipt = await jobs.uploadRequest(
      scopeId,
      `/upload-groups/${encodeURIComponent(plan.groupId)}/entries`,
      body,
    );
    if (receipt.batchId !== body.batchId)
      throw fileClientIssue("FILE_INVALID_RESPONSE", 502);
    await check();
  }
  if (!plan.committed) {
    await jobs.uploadRequest(
      scopeId,
      `/upload-groups/${encodeURIComponent(plan.groupId)}/commit`,
      undefined,
      "bare",
    );
    plan.committed = true;
  }
  await check();
  const entries = await jobs.loadUploadGroup(scopeId, plan.groupId, maxEntries);
  await check();
  const files = new Map(
    entries
      .filter((entry) => entry.type === "file")
      .map((entry) => [entry.relativePath, entry]),
  );
  const directories = new Map(
    entries
      .filter((entry) => entry.type === "directory")
      .map((entry) => [entry.relativePath, entry]),
  );
  if (
    entries.length !== selection.files.length + selection.directories.length ||
    directories.size !== selection.directories.length ||
    selection.directories.some((path) => directories.get(path)?.bytes !== 0) ||
    files.size !== selection.files.length ||
    selection.files.some(
      ({ file, relativePath }) => files.get(relativePath)?.bytes !== file.size,
    )
  )
    throw fileClientIssue("FILE_INVALID_RESPONSE", 502);
  return { groupId: plan.groupId, entries };
}
