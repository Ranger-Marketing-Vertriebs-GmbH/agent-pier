import path from "node:path";
import { validateArtifactState } from "../artifacts/artifact-metadata.js";
import { readJson, readFile, atomic, digest } from "./files.js";
import { artifactError } from "../artifacts/artifact-errors.js";
export function artifactMembers(dataDir, includeHistory) {
  const source = readJson(path.join(dataDir, "artifacts/index.json"), null);
  if (!source) return [];
  const state = validateArtifactState(source),
    files = [];
  const member = (name, bytes) => ({
    path: name,
    content: bytes.toString("base64"),
    sha256: digest(bytes),
    mode: 0o600,
  });
  let size = 0;
  for (const [id, record] of Object.entries(state.records)) {
    if (record.deleted || (!includeHistory && !record.pinned)) {
      state.records[id] = { id, sessionId: record.sessionId, deleted: true };
      continue;
    }
    for (const file of record.files) {
      size += file.size;
      if (size > 128 * 1024 * 1024 || files.length >= 15000)
        throw artifactError("ARTIFACT_LIMIT_EXCEEDED", 413);
      const name = `artifacts/generations/${record.generation}/${file.stored}`;
      const bytes = readFile(path.join(dataDir, name), 50 * 1024 * 1024);
      if (bytes.length !== file.size) throw artifactError("ARTIFACT_IO_ERROR", 409);
      files.push(member(name, bytes));
    }
  }
  files.push(member("artifacts/index.json", Buffer.from(JSON.stringify(state))));
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
      const bytes = readFile(
        path.join(directory, "artifacts/generations", record.generation, entry.stored),
        50 * 1024 * 1024,
      );
      if (bytes.length !== entry.size) throw artifactError("ARTIFACT_IO_ERROR", 409);
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
