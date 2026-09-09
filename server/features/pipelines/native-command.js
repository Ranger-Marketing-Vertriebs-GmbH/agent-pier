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
    throw problem(`Invalid ${tool} permission mode.`);
  const args = [...launch.args];
  // Every pipeline turn is autonomous: the agent has no operator to ask what it
  // is allowed to write, so it is told the sandbox it actually runs in.
  const env = {
    ...launch.env,
    AGENTRUNNER_SANDBOX: headless ? "none" : runSandbox(tool),
  };
  if (tool === "codex") {
    if (headless)
      args.push(
        "--dangerously-bypass-approvals-and-sandbox",
        "--dangerously-bypass-hook-trust",
      );
    else
      args.push(
        "-c",
        `approval_policy=${JSON.stringify(mode)}`,
        ...codexSandboxArguments(),
      );
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
    args.push(
      "--permission-mode",
      headless ? "bypassPermissions" : mode === "default" ? claudeDefault : mode,
    );
    if (resumeNativeId) args.push("--resume", resumeNativeId);
    else args.push("--session-id", sessionId);
    if (headless)
      return {
        ...launch,
        env,
        args: ["--print", "--output-format", "stream-json", "--verbose", ...args],
      };
  } else {
    if (headless || mode === "auto") args.push("--auto");
    if (resumeNativeId) args.push("--session", resumeNativeId);
    if (headless) return { ...launch, env, args: ["run", "--format", "json", ...args] };
  }
  return { ...launch, args, env };
}
