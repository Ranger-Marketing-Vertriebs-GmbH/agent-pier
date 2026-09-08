import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { shellQuote } from "../../lib/launch-serialization.js";
const moduleFile = (name) => fileURLToPath(new URL(name, import.meta.url));
export async function prepareRequests(
  broker,
  { id, account, cwd, launch, purpose, headless } = {},
) {
  if (
    purpose === "login" ||
    headless ||
    !["codex", "claude", "opencode"].includes(account?.tool)
  )
    return launch;
  const token = randomBytes(32).toString("hex");
  const file = broker.file(id);
  const args = [...(launch.args || [])];
  const env = {
    ...launch.env,
    AGENTPIER_REQUEST_FILE: file,
    AGENTPIER_REQUEST_TOKEN: token,
  };
  await fs.writeFile(
    file,
    JSON.stringify({
      id,
      accountId: account.id,
      tool: account.tool,
      cwd,
      token,
      socketPath: broker.socketPath,
      command: launch.command,
      args,
    }),
    { mode: 0o600, flag: "wx" },
  );
  if (account.tool === "codex")
    return {
      ...launch,
      command: process.execPath,
      args: [moduleFile("./codex-launch.js"), file],
      env,
      nativeRequests: { enabled: true, version: 1 },
    };
  if (account.tool === "claude") {
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
    const hook = {
      type: "command",
      command: [process.execPath, moduleFile("./claude-hook.js")]
        .map(shellQuote)
        .join(" "),
      timeout: 600,
    };
    await fs.writeFile(
      path.join(directory, "hooks/hooks.json"),
      JSON.stringify({
        hooks: {
          PermissionRequest: [{ hooks: [hook] }],
          PreToolUse: [{ matcher: "AskUserQuestion", hooks: [hook] }],
        },
      }),
      { mode: 0o600 },
    );
    args.push("--plugin-dir", directory);
  }
  if (account.tool === "opencode") {
    const configFile =
      env.OPENCODE_TUI_CONFIG || path.join(broker.directory, `${id}.tui.json`);
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
      pathToFileURL(moduleFile("./opencode-plugin.js")).href,
    ];
    await fs.writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
    env.OPENCODE_TUI_CONFIG = configFile;
  }
  return { ...launch, args, env, nativeRequests: { enabled: true, version: 1 } };
}
