import fs from "node:fs/promises";
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
  const file = broker.file(id);
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
  // the broker directory. The directory is granted as a whole because the launch
  // file is replaced by rename, which a single-file grant does not follow on Linux,
  // but only for reading: it also holds the other sessions' launch files and
  // plugin folders, and what a session may write there its driver grants by name.
  const grants = [
    { access: "read", path: broker.directory },
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
