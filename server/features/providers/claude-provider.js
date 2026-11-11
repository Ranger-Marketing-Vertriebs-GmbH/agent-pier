import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { atLeast, isCliVersion } from "../tools/cli-version.js";

// Claude Code releases that custom model contexts and custom auth headers need.
const CUSTOM_CONTEXT_VERSION = "2.1.193";
const CUSTOM_HEADER_VERSION = "2.1.227";

export function configureClaudeProvider(
  launch,
  metadata,
  cliVersion,
  { forceCustom = false, customHeader = false } = {},
) {
  const env = launch.env;
  const window =
    metadata.routingContextTokens && metadata.contextTokens
      ? Math.min(metadata.routingContextTokens, metadata.contextTokens)
      : metadata.routingContextTokens || metadata.contextTokens;
  const recognizedClaude = !forceCustom && /claude-/i.test(metadata.modelId);
  let cliModelId = metadata.modelId;
  let assumedContextTokens = null;
  if (recognizedClaude) {
    if (window >= 1000000) {
      cliModelId += "[1m]";
      assumedContextTokens = 1000000;
    }
  } else {
    if (!isCliVersion(cliVersion))
      throw problem(serverMessages.providers.claudeVersionUnverified, 409);
    if (!atLeast(cliVersion, CUSTOM_CONTEXT_VERSION))
      throw problem(serverMessages.providers.claudeVersionTooOld, 409);
    if (customHeader && !atLeast(cliVersion, CUSTOM_HEADER_VERSION))
      throw problem(serverMessages.providers.endpointClaudeCustomHeaderVersion, 409);
    if (!window) throw problem(serverMessages.providers.contextLimitUnverified, 409);
    env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(window);
    assumedContextTokens = window;
  }
  env.ANTHROPIC_MODEL = cliModelId;
  // The four family aliases Claude Code resolves through the environment
  // (https://code.claude.com/docs/en/model-config; the same four names are the
  // only `ANTHROPIC_DEFAULT_<FAMILY>_MODEL` variables in Claude Code 2.1.322).
  // `ANTHROPIC_DEFAULT_MODEL` is the model a session starts on, which
  // `ANTHROPIC_MODEL` and `--model` already decide here.
  for (const role of ["OPUS", "SONNET", "HAIKU", "FABLE"])
    env[`ANTHROPIC_DEFAULT_${role}_MODEL`] = cliModelId;
  env.CLAUDE_CODE_SUBAGENT_MODEL = cliModelId;
  env.ANTHROPIC_CUSTOM_MODEL_OPTION = cliModelId;
  env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME = metadata.label;
  // Endpoint models carry the user's limit or an already capped fallback.
  if (metadata.outputTokens)
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(
      forceCustom ? metadata.outputTokens : Math.min(metadata.outputTokens, 32000),
    );
  if (metadata.providerId === "openrouter")
    env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";
  if (forceCustom) env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "1";
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
