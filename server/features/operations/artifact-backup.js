import path from "node:path";
import { validateArtifactState } from "../artifacts/artifact-metadata.js";
import fs from "node:fs";
import { readJson, atomic } from "./files.js";
import { areaComponent } from "./backup-components.js";
import { artifactError } from "../artifacts/artifact-errors.js";
import { unpinnedArtifactsMember } from "./private-content.js";
/**
 * Artifact members for a backup: pinned records' generation files (streamed through
 * `plan`) and the index, with every other record reduced to a tombstone. With
 * `sealUnpinned`, unpinned records, their receipts and their files are added as
 * history members (`history: true`), which the backup seals.
 */
export function artifactMembers(dataDir, sealUnpinned, plan) {
  const source = readJson(path.join(dataDir, "artifacts/index.json"), null);
  if (!source) return [];
  const state = validateArtifactState(source),
    files = [],
    unpinned = { records: {}, receipts: {} };
  for (const [id, record] of Object.entries(state.records)) {
    if (record.deleted || !record.pinned) {
      state.records[id] = { id, sessionId: record.sessionId, deleted: true };
      if (record.deleted) continue;
      // Receipts carry the title: they go only where the record goes.
      for (const [key, receipt] of Object.entries(state.receipts))
        if (receipt.result.id === id) {
          if (sealUnpinned) unpinned.receipts[key] = receipt;
          delete state.receipts[key];
        }
      if (!sealUnpinned) continue;
      unpinned.records[id] = record;
    }
    for (const file of record.files) {
      const name = `artifacts/generations/${record.generation}/${file.stored}`;
      const member = plan.file(
        name,
        path.join(dataDir, name),
        areaComponent("artifacts"),
      );
      if (!member || (member.bytes?.length ?? member.size) !== file.size)
        throw artifactError("ARTIFACT_IO_ERROR", 409);
      files.push(record.pinned ? member : { ...member, history: true });
    }
  }
  files.push({
    path: "artifacts/index.json",
    bytes: Buffer.from(JSON.stringify(state)),
  });
  if (Object.keys(unpinned.records).length)
    files.push({
      path: unpinnedArtifactsMember,
      bytes: Buffer.from(JSON.stringify(unpinned)),
      history: true,
    });
  return files;
}
/** Merges sealed unpinned records back into the index state; each was a tombstone. */
function mergeUnpinned(directory, state) {
  const file = path.join(directory, unpinnedArtifactsMember),
    sealed = readJson(file, null);
  if (sealed === null) return;
  if (
    typeof sealed !== "object" ||
    Object.keys(sealed).sort().join() !== "receipts,records"
  )
    throw artifactError("ARTIFACT_IO_ERROR", 409);
  for (const [id, record] of Object.entries(sealed.records || {})) {
    if (!state.records[id]?.deleted) throw artifactError("ARTIFACT_IO_ERROR", 409);
    state.records[id] = record;
  }
  for (const [key, receipt] of Object.entries(sealed.receipts || {})) {
    if (state.receipts[key]) throw artifactError("ARTIFACT_IO_ERROR", 409);
    state.receipts[key] = receipt;
  }
  fs.rmSync(file);
}
export function restoreArtifacts(directory, mappings = []) {
  const file = path.join(directory, "artifacts/index.json"),
    source = readJson(file, null);
  if (!source) {
    // Sealed records without the index they belong to: not what a backup writes.
    if (fs.existsSync(path.join(directory, unpinnedArtifactsMember)))
      throw artifactError("ARTIFACT_IO_ERROR", 409);
    return;
  }
  const state = validateArtifactState(source);
  mergeUnpinned(directory, state);
  validateArtifactState(state);
  for (const record of Object.values(state.records)) {
    if (record.deleted) continue;
    for (const entry of record.files) {
      const stat = fs.lstatSync(
        path.join(directory, "artifacts/generations", record.generation, entry.stored),
        { throwIfNoEntry: false },
      );
      if (!stat?.isFile() || stat.size !== entry.size)
        throw artifactError("ARTIFACT_IO_ERROR", 409);
    }
    record.projectId =
      mappings.find((m) => m.from === record.projectId)?.to || record.projectId;
  }
  for (const receipt of Object.values(state.receipts))
    receipt.result.projectId =
      mappings.find((m) => m.from === receipt.result.projectId)?.to ||
      receipt.result.projectId;
  atomic(file, state);
}
