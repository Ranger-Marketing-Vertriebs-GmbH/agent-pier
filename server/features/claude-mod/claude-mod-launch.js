import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isCliVersion } from "../tools/cli-version.js";

export const claudeBridgeName = "agentpier-bridge";
const moduleFile = fileURLToPath(new URL("./bridge-mod.js", import.meta.url));

/**
 * Add the bridge mod to a Claude Code launch the request broker prepares: a plugin
 * folder of this launch's own (`requests/<id>.claude-bridge`, a copy, since Claude
 * Code writes type declarations into a folder it loads a mod from), its socket in
 * the environment and the sandbox grant to reach it. Every supported Claude Code
 * loads mods (2.1.287 and later); one of unknown version starts without it.
 */
export async function addClaudeBridge(broker, id, { launch, args, env }) {
  if (!isCliVersion(launch.cliVersion)) return [];
  // Validated and kept inside the broker's directory before anything is removed.
  const directory = broker.sessionPath(id, ".claude-bridge");
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
  // Claude Code writes into the folder it loads the mod from (see above).
  return [
    { access: "allow", path: directory },
    { access: "socket", path: broker.modSocketPath },
  ];
}
