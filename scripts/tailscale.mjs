import { isMainModule } from "../server/lib/is-main-module.js";
import { serverMessages } from "../server/lib/i18n/de.js";
import { loadConfig, updateStoredConfig } from "../server/lib/config.js";
import {
  readPreviewConfig,
  tailscaleHttpsPort,
} from "../server/features/previews/preview-config.js";
import { applyPreviewServe } from "../server/features/previews/preview-serve.js";
import { runTailscale } from "../server/features/remote/tailscale-cli.js";
export function selectServePort(status, localPort, { httpsPort } = {}) {
  if (
    httpsPort !== undefined &&
    (!Number.isSafeInteger(httpsPort) || httpsPort < 1 || httpsPort > 65535)
  )
    throw Error("Invalid Tailscale HTTPS port.");
  for (const port of httpsPort === undefined ? [8443, 10000, 9443] : [httpsPort]) {
    const web = Object.entries(status.Web || {}).filter(([host]) =>
      host.endsWith(`:${port}`),
    );
    const owned =
      web.length === 1 &&
      Object.keys(web[0][1].Handlers || {}).length === 1 &&
      web[0][1].Handlers?.["/"]?.Proxy === `http://127.0.0.1:${localPort}`;
    if (owned || (!status.TCP?.[port] && !web.length)) return port;
  }
  throw new Error(serverMessages.scripts.httpsPortsOccupied);
}
/**
 * Registers the preview range with Tailscale Serve when previews are on and network mode
 * is off (the server re-applies it on every start); prints the commands of failures.
 */
export async function applyPreviews({ config, stored, remoteUrl, run, log }) {
  if (stored.network?.enabled) return null;
  const previews = readPreviewConfig(config.dataDir, {
    hostPort: config.port,
    pipelineRange: config.pipelines?.portRange,
    tailscaleHttpsPort: tailscaleHttpsPort(remoteUrl),
  });
  if (!previews.enabled) return null;
  const result = await applyPreviewServe({
    run,
    range: { start: previews.portRangeStart, end: previews.portRangeEnd },
  });
  for (const { port, reason } of result.failed)
    log(serverMessages.scripts.previewServeFailed(port, reason));
  if (result.commands.length)
    log([serverMessages.scripts.previewServeCommands, ...result.commands].join("\n"));
  return result;
}
/** Serves AgentPier over Tailscale and records the URL; `run` is injectable for tests. */
export async function configureTailscale({
  config = loadConfig(),
  run = runTailscale,
  log = console.log,
} = {}) {
  const status = JSON.parse(await run(["status", "--json"]));
  if (status.BackendState !== "Running")
    throw new Error(serverMessages.scripts.tailscaleDisconnected);
  const login = status.User?.[String(status.Self?.UserID)]?.LoginName;
  const host = status.Self?.DNSName?.replace(/\.$/, "");
  if (!login || !host)
    throw new Error(serverMessages.scripts.tailscaleIdentityUnavailable);
  const serve = JSON.parse(await run(["serve", "status", "--json"]));
  const selectedPort = process.env.AGENTPIER_TAILSCALE_HTTPS_PORT;
  const port = selectServePort(serve, config.port, {
    httpsPort: selectedPort === undefined ? undefined : Number(selectedPort),
  });
  const remoteUrl = `https://${host}${port === 443 ? "" : `:${port}`}`;
  log(
    String(
      await run(["serve", "--bg", `--https=${port}`, `http://127.0.0.1:${config.port}`]),
    ).trim(),
  );
  // Merge, never replace: network, pipelines and files settings must survive.
  const stored = updateStoredConfig(config.dataDir, {
    port: config.port,
    remoteUrl,
    // Only this account may create the owner over Tailscale; everyone else signs in.
    ownerLogin: login,
  });
  await applyPreviews({ config, stored, remoteUrl, run, log });
  log(serverMessages.scripts.remoteAccessConfigured(remoteUrl));
  return remoteUrl;
}
async function main() {
  try {
    await configureTailscale();
  } catch (e) {
    console.error(e.stderr?.toString().trim() || e.message);
    process.exitCode = 1;
  }
}
if (isMainModule(import.meta.url)) await main();
