import { problem } from "../../lib/storage.js";
import { activeNode } from "./graph-navigation.js";
import { launchStage } from "./execution-stage.js";

export async function provisionRun(engine, run) {
  try {
    const workspace = await engine.workspace.prepare({
      runId: run.id,
      cwd: run.cwd,
      baseBranch: run.baseBranch,
    });
    if (run.expectedProjectId && workspace.projectId !== run.expectedProjectId)
      throw problem(
        "The prepared workspace does not match the authorized project. No native stage was launched.",
        409,
      );
    run.workspace = workspace;
    run.workingDir = workspace.cwd;
    run.projectId = workspace.projectId || workspace.projectRoot;
    run.branch = workspace.branch;
    run.phase = "executing";
    engine.store.save(run);
    await launchStage(engine, run, activeNode(run));
  } catch (error) {
    engine.recordError(error);
    run.status = "failed";
    run.finishedAt = engine.now();
    run.failDetail = [400, 409].includes(error.status)
      ? error.message.slice(0, 500)
      : "Pipeline workspace could not be prepared safely. Existing files are preserved.";
    engine.store.save(run);
  }
}
