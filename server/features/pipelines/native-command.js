import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { runSandbox } from "../../lib/sandbox.js";
import { cliDriver } from "../clis/drivers.js";
import { PERMISSION_MODES } from "./profile-validation.js";

export function nativeCommand({
  tool,
  launch,
  mode,
  sessionId,
  resumeNativeId,
  headless = false,
  claudeDefault = "default",
  turnEnv = {},
}) {
  if (!PERMISSION_MODES[tool]?.includes(mode))
    throw problem(serverMessages.pipelineProfiles.invalidNativePermissionMode(tool));
  const args = [...launch.args];
  // Every pipeline turn is autonomous: the agent has no operator to ask what it
  // is allowed to write, so it is told the sandbox it actually runs in.
  const env = {
    ...launch.env,
    // A pipeline turn's run, stage, leased ports and browser session (run-ports.js).
    ...turnEnv,
    // AgentPier pipeline profiles have no sandbox profile concept yet, so this
    // always reports the tool's own answer without a nono sandbox.
    AGENTRUNNER_SANDBOX: headless ? "none" : runSandbox(tool, null),
  };
  const result = cliDriver(tool).pipeline.command({
    args,
    mode,
    sessionId,
    resumeNativeId,
    headless,
    claudeDefault,
  });
  if (headless) return { ...launch, env, args: result.args };
  // The interactive permission arguments, kept on the session so a reload or an
  // automatic resume relaunches with exactly the settings of this launch.
  return { ...launch, args: result.args, env, permissionArgs: result.permissions };
}
