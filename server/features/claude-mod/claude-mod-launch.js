import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atLeast } from "../tools/cli-version.js";

// Claude Code loads hooks modules (mods) from a `--plugin-dir` since this release.
export const CLAUDE_MOD_VERSION = "2.1.287";
export const claudeBridgeName = "agentpier-bridge";
const moduleFile = fileURLToPath(new URL("./bridge-mod.js", import.meta.url));

/**
 * Add the bridge mod to a Claude Code launch the request broker prepares: a plugin
 * folder of this launch's own (`requests/<id>.claude-bridge`, a copy, since Claude
 * Code writes type declarations into a folder it loads a mod from), its socket in
 * the environment and the sandbox grant to reach it. A Claude Code that is older or
 * of unknown version starts without it and keeps the MessageDisplay hook.
 */
export async function addClaudeBridge(broker, id, { launch, args, env }) {
  if (!atLeast(launch.cliVersion, CLAUDE_MOD_VERSION)) return [];
  const directory = path.join(broker.directory, `${id}.claude-bridge`);
  await fs.rm(directory, { recursive: true, force: true });
  for (const folder of [".claude-plugin", "hooks"])
    await fs.mkdir(path.join(directory, folder), { recursive: true, mode: 0o700 });
  const write = (file, content) =>
    fs.writeFile(path.join(directory, file), content, { mode: 0o600, flag: "wx" });
  await write(
    ".claude-plugin/plugin.json",
    JSON.stringify({
      name: claudeBridgeName,
      version: "1.0.0",
      description: "Live session reports for the AgentPier chat",
      author: { name: "AgentPier" },
    }),
  );
  await write("hooks/hooks.json", JSON.stringify({ modules: ["./register.js"] }));
  await write("hooks/register.js", await fs.readFile(moduleFile, "utf8"));
  args.push("--plugin-dir", directory);
  env.AGENTPIER_CLAUDE_BRIDGE_SOCKET = broker.modSocketPath;
  return [{ access: "socket", path: broker.modSocketPath }];
}
