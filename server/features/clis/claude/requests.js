import fs from "node:fs/promises";
import path from "node:path";
import {
  writeClaudeHooks,
  claudeDispatcher,
  claudeHookVersion,
} from "../../requests/claude-runtime.js";
import { addClaudeBridge } from "../../claude-mod/claude-mod-launch.js";
import { answerFolderTrust } from "../../requests/claude-folder-trust.js";
import { answerStartupPrompt } from "../../requests/claude-startup-prompts.js";

export const shellToolName = "Bash";

/** What the launch file records about the hooks and Claude's trust file. */
export const launchRecord = (env) => ({
  claudeHookVersion,
  ...(env.AGENTPIER_CLAUDE_HOOK_DISPATCHER
    ? { claudeHookDispatcher: env.AGENTPIER_CLAUDE_HOOK_DISPATCHER }
    : {}),
  ...(path.isAbsolute(env.CLAUDE_CONFIG_DIR || "")
    ? { claudeTrustFile: path.join(env.CLAUDE_CONFIG_DIR, ".claude.json") }
    : {}),
});
/** What the launch environment names before the launch file is written. */
export const launchEnvironment = (broker) =>
  broker.runtimeDirectory
    ? { AGENTPIER_CLAUDE_HOOK_DISPATCHER: claudeDispatcher(broker.runtimeDirectory) }
    : {};
export const startupDialogs = {
  claudeFolderTrust: answerFolderTrust,
  claudeStartupPrompt: answerStartupPrompt,
};

/** Loads the request hooks as a plugin folder and the claude-mod bridge. */
export async function prepareRequests({ broker, id, args, env, grants }, launch) {
  const directory = path.join(broker.directory, `${id}.claude`);
  await fs.mkdir(path.join(directory, ".claude-plugin"), {
    recursive: true,
    mode: 0o700,
  });
  await fs.mkdir(path.join(directory, "hooks"), { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(directory, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "agentpier-requests", version: "1.0.0" }),
    { mode: 0o600 },
  );
  await writeClaudeHooks(broker.directory, id, env.AGENTPIER_CLAUDE_HOOK_DISPATCHER);
  args.push("--plugin-dir", directory);
  // The hooks run the dispatcher from the runtime folder, which holds nothing else
  // and is only ever read; the plugin folder stays the session's own.
  if (broker.runtimeDirectory)
    grants.push({ access: "read", path: broker.runtimeDirectory });
  grants.push({ access: "allow", path: directory });
  // Live turn, text and tool reports from inside Claude Code (claude-mod/).
  grants.push(...(await addClaudeBridge(broker, id, { launch, args, env })));
}
