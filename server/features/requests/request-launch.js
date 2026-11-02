import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { claudeHookVersion } from "./claude-runtime.js";
import { addGrant } from "../nono/sandbox-grants.js";
import { isCodingCli } from "../clis/catalog.js";
import { cliDriver } from "../clis/drivers.js";
export async function prepareRequests(
  broker,
  { id, account, cwd, launch, purpose, headless } = {},
) {
  if (purpose === "login" || headless || !isCodingCli(account?.tool)) return launch;
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
  const grants = [
    { access: "allow", path: broker.directory },
    { access: "socket", path: broker.socketPath },
  ];
  const prepared = (await cliDriver(account.tool).prepareRequests(
    { broker, id, file, args, env, grants },
    launch,
  )) ?? { ...launch, args, env };
  return grants.reduce((granted, item) => addGrant(granted, item), {
    ...prepared,
    nativeRequests: { enabled: true, version: 1 },
  });
}
