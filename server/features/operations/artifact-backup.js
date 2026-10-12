import path from "node:path";
import { validateArtifactState } from "../artifacts/artifact-metadata.js";
import fs from "node:fs";
import { readJson, atomic } from "./files.js";
import { areaComponent } from "./backup-components.js";
import { artifactError } from "../artifacts/artifact-errors.js";
/**
 * Artifact members for a backup: kept records' generation files (streamed through
 * `plan`) and the index, with every other record reduced to a tombstone.
 */
export function artifactMembers(dataDir, includeHistory, plan) {
  const source = readJson(path.join(dataDir, "artifacts/index.json"), null);
  if (!source) return [];
  const state = validateArtifactState(source),
    files = [];
  for (const [id, record] of Object.entries(state.records)) {
    if (record.deleted || (!includeHistory && !record.pinned)) {
      state.records[id] = { id, sessionId: record.sessionId, deleted: true };
      continue;
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
      files.push(member);
    }
  }
  files.push({
    path: "artifacts/index.json",
    bytes: Buffer.from(JSON.stringify(state)),
  });
  return files;
}
export function restoreArtifacts(directory, mappings = []) {
  const file = path.join(directory, "artifacts/index.json"),
    source = readJson(file, null);
  if (!source) return;
  const state = validateArtifactState(source);
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
