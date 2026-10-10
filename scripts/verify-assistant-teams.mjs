import path from "node:path";
import fs from "node:fs";
import { qualificationDirectory } from "./verify-assistant-runtime.mjs";
import { qualifyAssistantTeams } from "../tests/helpers/assistant-team-contract.js";
if (process.argv.length !== 4 || process.argv[2] !== "--data-dir")
  throw Error(
    "Usage: node scripts/verify-assistant-teams.mjs --data-dir <empty-absolute-directory>",
  );
const dataDir = qualificationDirectory(process.argv[3]);
// This contract owns its runtime state. Reusing a prior qualification could
// accidentally include unfinished runs, so require a new directory each time.
if (fs.existsSync(path.join(dataDir, "assistants")))
  throw Error("Team qualification requires a new empty marked directory.");
try {
  console.log(
    JSON.stringify(
      await qualifyAssistantTeams({ dataDir, log: (message) => console.log(message) }),
    ),
  );
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
