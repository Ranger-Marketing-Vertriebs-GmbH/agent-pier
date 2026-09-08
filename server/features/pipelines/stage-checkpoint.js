import { currentAttempt } from "./graph-navigation.js";
import { park } from "./execution-stage.js";
export async function checkpointStage(engine, run, node) {
  const attempt = currentAttempt(run);
  if (attempt && !attempt.endSha && engine.workspace.checkpoint) {
    try {
      const checkpoint = await engine.workspace.checkpoint({
        workspace: run.workspace,
        run,
        node,
        attempt,
      });
      attempt.endSha = checkpoint.sha;
      engine.store.save(run);
    } catch (error) {
      engine.recordError(error);
      park(
        engine,
        run,
        node,
        "session-error",
        [400, 409].includes(error.status)
          ? error.message
          : "The stage changes could not be checkpointed. The workspace is preserved.",
      );
      return false;
    }
  }
  return true;
}
