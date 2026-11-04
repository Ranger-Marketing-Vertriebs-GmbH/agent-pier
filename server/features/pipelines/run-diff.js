import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";

/**
 * The whole-run diff of a stored run. An imported history run has no worktree on this
 * host (PIPELINE_RUN_IMPORTED, so the view hides its Changes section); a run without
 * a workspace is PIPELINE_RUN_WORKSPACE_GONE.
 */
export async function runDiff(engine, run) {
  if (run.imported?.historyOnly)
    throw Object.assign(problem(serverMessages.pipelines.importedHistoryReadOnly, 409), {
      code: "PIPELINE_RUN_IMPORTED",
    });
  return engine.workspace.runDiff({ workspace: run.workspace });
}
