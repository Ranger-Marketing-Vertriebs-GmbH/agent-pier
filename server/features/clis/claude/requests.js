import fs from "node:fs/promises";
import path from "node:path";
import { writeClaudeHooks, claudeHookVersion } from "../../requests/claude-runtime.js";
import { addClaudeBridge } from "../../claude-mod/claude-mod-launch.js";
import { answerFolderTrust } from "../../requests/claude-folder-trust.js";
import { answerStartupPrompt } from "../../requests/claude-startup-prompts.js";

export const shellToolName = "Bash";

/** How the chat shows one AskUserQuestion question. */
export const question = (q) => ({
  multiple: q.multiSelect === true,
  allowOther: true,
  previews: true,
  notes: true,
});

/** What the launch file records about the hooks and Claude's trust file. */
export const launchRecord = (env) => ({
  claudeHookVersion,
  ...(path.isAbsolute(env.CLAUDE_CONFIG_DIR || "")
    ? { claudeTrustFile: path.join(env.CLAUDE_CONFIG_DIR, ".claude.json") }
    : {}),
});
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
  await writeClaudeHooks(broker.directory, id);
  args.push("--plugin-dir", directory);
  // Live turn, text and tool reports from inside Claude Code (claude-mod/).
  grants.push(...(await addClaudeBridge(broker, id, { launch, args, env })));
}
