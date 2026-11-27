// Import for its effect, before anything writes a Composer order: gives this test
// process, and every process it starts, a writer lock folder of its own
// (order-progress.mjs, AGENTPIER_COMPOSER_WRITES_DIR). The default one,
// /tmp/agentpier-composer-writes-<uid>, is shared with a running AgentPier, whose
// order writes would wait for a test's lock; the helper refuses it under Node's test
// runner. A folder the caller already named (a run that shares one) is kept.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (!process.env.AGENTPIER_COMPOSER_WRITES_DIR) {
  const directory = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "composer-writes-"),
  );
  process.env.AGENTPIER_COMPOSER_WRITES_DIR = directory;
  process.once("exit", () => fs.rmSync(directory, { recursive: true, force: true }));
}

/** The writer lock folder of this test process. */
export const composerWritesDirectory = () => process.env.AGENTPIER_COMPOSER_WRITES_DIR;
