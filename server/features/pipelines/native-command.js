import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { codexSandboxArguments, runSandbox } from "../../lib/sandbox.js";
import { PERMISSION_MODES } from "./profile-validation.js";

export function nativeCommand({
  tool,
  launch,
  mode,
  sessionId,
  resumeNativeId,
  headless = false,
  claudeDefault = "default",
}) {
  if (!PERMISSION_MODES[tool]?.includes(mode))
    throw problem(serverMessages.pipelineProfiles.invalidNativePermissionMode(tool));
  const args = [...launch.args];
  // The interactive permission arguments, kept on the session so a reload or an
  // automatic resume relaunches with exactly the settings of this launch.
  let permissions = [];
  // Every pipeline turn is autonomous: the agent has no operator to ask what it
  // is allowed to write, so it is told the sandbox it actually runs in.
  const env = {
    ...launch.env,
    // AgentPier pipeline profiles have no sandbox profile concept yet, so this
    // always reports the tool's own answer without a nono sandbox.
    AGENTRUNNER_SANDBOX: headless ? "none" : runSandbox(tool, null),
  };
  if (tool === "codex") {
    if (headless)
      args.push(
        "--dangerously-bypass-approvals-and-sandbox",
        "--dangerously-bypass-hook-trust",
      );
    else
      permissions = [
        "-c",
        `approval_policy=${JSON.stringify(mode)}`,
        ...codexSandboxArguments(),
      ];
    args.push(...permissions);
    if (headless)
      return {
        ...launch,
        env,
        args: [
          "exec",
          "--json",
          ...args,
          ...(resumeNativeId ? ["resume", resumeNativeId, "-"] : ["-"]),
        ],
      };
  } else if (tool === "claude") {
    // The shared lifecycle preassigns a new native session ID. Resuming must
    // retain the original conversation instead of combining both CLI options.
    for (let index = args.length - 1; index >= 0; index--) {
      if (args[index] === "--session-id") args.splice(index, 2);
      else if (args[index].startsWith("--session-id=")) args.splice(index, 1);
    }
    if (headless) args.push("--permission-mode", "bypassPermissions");
    else {
      permissions = ["--permission-mode", mode === "default" ? claudeDefault : mode];
      args.push(...permissions);
    }
    if (resumeNativeId) args.push("--resume", resumeNativeId);
    else args.push("--session-id", sessionId);
    if (headless)
      return {
        ...launch,
        env,
        args: ["--print", "--output-format", "stream-json", "--verbose", ...args],
      };
  } else {
    if (headless) args.push("--auto");
    else if (mode === "auto") {
      permissions = ["--auto"];
      args.push(...permissions);
    }
    if (resumeNativeId) args.push("--session", resumeNativeId);
    if (headless) return { ...launch, env, args: ["run", "--format", "json", ...args] };
  }
  return { ...launch, args, env, permissionArgs: permissions };
}
