import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readJSON, writePrivate } from "../../lib/storage.js";

export const ASSISTANT_STORAGE_UNSAFE = "ASSISTANT_STORAGE_UNSAFE";
const featureFile = (dataDir) => path.join(dataDir, "assistant-feature.json");

/** Inspects the assistant folder without creating it; returns a stable code, never a path. */
export function assistantStorageProblem(dataDir) {
  let stat;
  try {
    stat = fs.lstatSync(path.join(dataDir, "assistants"));
  } catch (error) {
    return error.code === "ENOENT" ? null : ASSISTANT_STORAGE_UNSAFE;
  }
  return !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid && stat.uid !== process.getuid())
    ? ASSISTANT_STORAGE_UNSAFE
    : null;
}

// Installs from before the opt-in switch keep their agents: an enabled runtime or
// any stored assistant counts as consent that was already given.
function previouslyUsed(dataDir) {
  const root = path.join(dataDir, "assistants");
  if (!fs.existsSync(root)) return false;
  try {
    if (readJSON(path.join(root, "settings.json"), {})?.enabled === true) return true;
  } catch {
    // A damaged runtime setting is no evidence either way; check the records.
  }
  const file = path.join(root, "assistants.sqlite");
  if (!fs.existsSync(file)) return false;
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    return !!db.prepare("SELECT 1 FROM assistants LIMIT 1").get();
  } catch {
    // An unreadable database may still hold agents; keeping them is the safe default.
    return true;
  } finally {
    db?.close();
  }
}

function storedChoice(dataDir) {
  try {
    const value = readJSON(featureFile(dataDir), null);
    return typeof value?.enabled === "boolean" ? value.enabled : null;
  } catch {
    return null;
  }
}

export function readAssistantFeature(dataDir) {
  const error = assistantStorageProblem(dataDir);
  const stored = storedChoice(dataDir);
  if (stored !== null) return { enabled: stored, error };
  const enabled = !error && previouslyUsed(dataDir);
  if (enabled) writeAssistantFeature(dataDir, { enabled });
  return { enabled, error };
}

export function writeAssistantFeature(dataDir, { enabled }) {
  writePrivate(featureFile(dataDir), { enabled: enabled === true });
}
