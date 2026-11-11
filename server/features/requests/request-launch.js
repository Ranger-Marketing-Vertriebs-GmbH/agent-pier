import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { addGrant } from "../nono/sandbox-grants.js";
import { isCodingCli } from "../clis/catalog.js";
import { cliDriver } from "../clis/drivers.js";
export async function prepareRequests(
  broker,
  { id, account, cwd, launch, purpose, headless } = {},
) {
  if (purpose === "login" || headless || !isCodingCli(account?.tool)) return launch;
  const token = randomBytes(32).toString("hex");
  const file = await broker.claim(id);
  const folder = path.dirname(file);
  const args = [...(launch.args || [])];
  const env = {
    ...launch.env,
    AGENTPIER_REQUEST_FILE: file,
    AGENTPIER_REQUEST_TOKEN: token,
    ...(cliDriver(account.tool).requests.launchEnvironment?.(broker) ?? {}),
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
      ...(cliDriver(account.tool).requests.launchRecord?.(env) ?? {}),
      command: launch.command,
      args,
    }),
    { mode: 0o600, flag: "wx" },
  );
  // Every tool reaches the broker over its socket and reads its launch file from
  // the launch's own folder. That folder is granted, not the file: the launch file
  // is replaced by rename, which a single-file grant does not follow on Linux. Only
  // for reading; what a session may write in it its driver grants by name. The other
  // sessions' folders beside it, with their request tokens, are not granted.
  const grants = [
    { access: "read", path: folder },
    { access: "socket", path: broker.socketPath },
  ];
  const prepared = (await cliDriver(account.tool).prepareRequests(
    { broker, id, file, folder, args, env, grants },
    launch,
  )) ?? { ...launch, args, env };
  return grants.reduce((granted, item) => addGrant(granted, item), {
    ...prepared,
    nativeRequests: { enabled: true, version: 1 },
  });
}
