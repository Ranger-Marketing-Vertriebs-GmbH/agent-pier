import { isMainModule } from "../server/lib/is-main-module.js";
import { serverMessages } from "../server/lib/i18n/de.js";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../server/lib/config.js";
import { writePrivate } from "../server/lib/storage.js";
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
function run(args) {
  const socket = process.env.AGENTPIER_TAILSCALE_SOCKET;
  if (socket && (!path.isAbsolute(socket) || /[\x00-\x1f]/.test(socket)))
    throw Error("Tailscale socket must be an absolute path.");
  return execFileSync("tailscale", [...(socket ? [`--socket=${socket}`] : []), ...args], {
    encoding: "utf8",
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function main() {
  const config = loadConfig();
  const status = JSON.parse(run(["status", "--json"]));
  if (status.BackendState !== "Running")
    throw new Error(serverMessages.scripts.tailscaleDisconnected);
  const login = status.User?.[String(status.Self?.UserID)]?.LoginName;
  const host = status.Self?.DNSName?.replace(/\.$/, "");
  if (!login || !host)
    throw new Error(serverMessages.scripts.tailscaleIdentityUnavailable);
  const serve = JSON.parse(run(["serve", "status", "--json"]));
  const selectedPort = process.env.AGENTPIER_TAILSCALE_HTTPS_PORT;
  const port = selectServePort(serve, config.port, {
    httpsPort: selectedPort === undefined ? undefined : Number(selectedPort),
  });
  const remoteUrl = `https://${host}${port === 443 ? "" : `:${port}`}`;
  console.log(
    run(["serve", "--bg", `--https=${port}`, `http://127.0.0.1:${config.port}`]).trim(),
  );
  writePrivate(path.join(config.dataDir, "config.json"), {
    port: config.port,
    remoteUrl,
    ownerLogin: login,
  });
  console.log(serverMessages.scripts.remoteAccessConfigured(remoteUrl));
}
if (isMainModule(import.meta.url))
  try {
    main();
  } catch (e) {
    console.error(e.stderr?.toString().trim() || e.message);
    process.exitCode = 1;
  }
