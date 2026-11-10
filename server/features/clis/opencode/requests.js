import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const shellToolName = "bash";
export const startupDialogs = {};

/** Adds the request plugin to the launch's own TUI configuration. */
export async function prepareRequests({ broker, id, env, grants }) {
  const own = path.join(broker.directory, `${id}.tui.json`);
  const configFile = env.OPENCODE_TUI_CONFIG || own;
  const parent = await fs.realpath(path.dirname(configFile));
  const dataDir = await fs.realpath(path.dirname(broker.directory));
  if (parent !== dataDir && !parent.startsWith(dataDir + path.sep))
    throw Error("Native TUI configuration is not owned by this launch");
  const info = await fs.lstat(configFile).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (info && !info.isFile()) throw Error("Unsafe native TUI configuration");
  const config = info ? JSON.parse(await fs.readFile(configFile, "utf8")) : {};
  config.plugin = [
    ...(config.plugin || []),
    pathToFileURL(
      fileURLToPath(new URL("../../requests/opencode-plugin.js", import.meta.url)),
    ).href,
  ];
  await fs.writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  env.OPENCODE_TUI_CONFIG = configFile;
  // The launch's own TUI configuration stays writable for it; the request folder
  // around it is only read.
  if (configFile === own) grants?.push({ access: "allow", path: own });
}
