import { problem } from "../../lib/storage.js";

function supportedVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version || "");
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 193)));
}

export function configureClaudeProvider(launch, metadata, cliVersion) {
  const env = launch.env;
  const window =
    metadata.routingContextTokens && metadata.contextTokens
      ? Math.min(metadata.routingContextTokens, metadata.contextTokens)
      : metadata.routingContextTokens || metadata.contextTokens;
  const recognizedClaude = /claude-/i.test(metadata.modelId);
  let cliModelId = metadata.modelId;
  let assumedContextTokens = null;
  if (recognizedClaude) {
    if (window >= 1000000) {
      cliModelId += "[1m]";
      assumedContextTokens = 1000000;
    }
  } else {
    if (!/^\d+\.\d+\.\d+/.test(cliVersion || ""))
      throw problem(
        "The Claude Code version could not be verified. Retry the launch; if this persists, check that the CLI responds to --version.",
        409,
      );
    if (!supportedVersion(cliVersion))
      throw problem(
        "Custom model context configuration requires Claude Code 2.1.193 or later. Update the CLI before launching this model.",
        409,
      );
    if (!window)
      throw problem(
        "This model has no verified context limit. Refresh the catalog before launching it in Claude Code.",
        409,
      );
    env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(window);
    assumedContextTokens = window;
  }
  env.ANTHROPIC_MODEL = cliModelId;
  for (const role of ["OPUS", "SONNET", "HAIKU", "FABLE"])
    env[`ANTHROPIC_DEFAULT_${role}_MODEL`] = cliModelId;
  env.CLAUDE_CODE_SUBAGENT_MODEL = cliModelId;
  env.ANTHROPIC_CUSTOM_MODEL_OPTION = cliModelId;
  env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME = metadata.label;
  if (metadata.outputTokens)
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(Math.min(metadata.outputTokens, 32000));
  if (metadata.providerId === "openrouter")
    env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";
  return {
    ...launch,
    args: [...launch.args, "--model", cliModelId],
    provider: {
      ...metadata,
      cliModelId,
      assumedContextTokens,
      contextStatus: assumedContextTokens ? "configured" : "native-model-default",
      modelChangeRequiresRestart: !recognizedClaude,
      notice: recognizedClaude
        ? null
        : "This provider documents non-Claude models; Anthropic does not support them. Restart the session to change the model and its context budget.",
    },
  };
}
