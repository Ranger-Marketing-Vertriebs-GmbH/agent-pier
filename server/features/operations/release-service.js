import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { problem } from "../../lib/storage.js";
const execute = promisify(execFile);
export async function restartService({
  platform = process.platform,
  uid = process.getuid?.(),
  run = execute,
} = {}) {
  const command =
    platform === "darwin" ? "launchctl" : platform === "linux" ? "systemctl" : null;
  if (!command) throw problem("This platform has no supported service adapter.");
  const args =
    platform === "darwin"
      ? ["kickstart", "-k", `gui/${uid}/dev.agentpier.server`]
      : ["--user", "restart", "dev.agentpier.server.service"];
  try {
    await run(command, args, { timeout: 15000, maxBuffer: 32768 });
  } catch {
    throw problem("The AgentPier user service could not be restarted.", 503);
  }
}
export async function checkHealth({
  port,
  version,
  previousInstanceId,
  fetchImpl = fetch,
  timeoutMs = 20000,
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1000),
        redirect: "error",
      });
      const value = await response.json();
      if (
        response.ok &&
        value.application === "agentpier" &&
        value.version === version &&
        typeof value.instanceId === "string" &&
        value.instanceId !== previousInstanceId
      )
        return true;
    } catch {}
    await delay(200);
  }
  return false;
}
