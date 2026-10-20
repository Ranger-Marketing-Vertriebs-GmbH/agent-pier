import fs from "node:fs";
import path from "node:path";

/** The retained `.jsonl.deleted.*` archives of a deleted native session. */
export function deletedTranscripts(stateDir, runtimeAgentId, sessionId = null) {
  const folder = path.join(stateDir, "agents", runtimeAgentId, "sessions");
  let names = [];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return [];
  }
  return names
    .filter((name) => /\.jsonl\.deleted\./.test(name))
    .filter((name) => !sessionId || name.startsWith(`${sessionId}.`))
    .map((name) => path.join(folder, name));
}
