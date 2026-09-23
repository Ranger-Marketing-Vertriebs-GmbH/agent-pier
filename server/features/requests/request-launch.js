import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { claudeHookVersion, writeClaudeHooks } from "./claude-runtime.js";
import { addGrant } from "../nono/sandbox-grants.js";
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
      ...(account.tool === "claude" ? { claudeHookVersion } : {}),
      ...(account.tool === "claude" && path.isAbsolute(env.CLAUDE_CONFIG_DIR || "")
        ? { claudeTrustFile: path.join(env.CLAUDE_CONFIG_DIR, ".claude.json") }
        : {}),
      command: launch.command,
      args,
    }),
    { mode: 0o600, flag: "wx" },
  );
  // Every tool reaches the broker over its socket and reads the launch file and
  // hook payloads the broker directory holds.
  const baseGrants = [
    { access: "allow", path: broker.directory },
    { access: "socket", path: broker.socketPath },
  ];
  const grant = (prepared, grants) =>
    grants.reduce((granted, item) => addGrant(granted, item), prepared);
  if (account.tool === "codex") {
    const wrapper = moduleFile("./codex-launch.js");
    return grant(
      {
        ...launch,
        command: process.execPath,
        args: [wrapper, file],
        env,
        nativeRequests: { enabled: true, version: 1 },
      },
      // This wrapper replaces the launch command outright, so it must be runnable.
      // The nono adapter grants whatever `launch.command` names by then, which is
      // the wrapper's interpreter rather than Codex, so the original executable
      // is declared here: codex-launch.js starts it again from the request file
      // for both the backend and the TUI.
      [
        ...baseGrants,
        { access: "read", path: launch.command },
        { access: "read", path: process.execPath },
        { access: "read", path: wrapper },
      ],
    );
  }
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
    await writeClaudeHooks(broker.directory, id);
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
  return grant(
    { ...launch, args, env, nativeRequests: { enabled: true, version: 1 } },
    baseGrants,
  );
}
