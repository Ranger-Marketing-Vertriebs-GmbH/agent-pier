import { isMainModule } from "../server/lib/is-main-module.js";
import { serverMessages } from "../server/lib/i18n/de.js";
import { loadConfig } from "../server/lib/config.js";
import {
  detectNetworkAddresses,
  networkUrls,
  readNetworkConfig,
  writeNetworkConfig,
} from "../server/features/remote/network-access.js";
import {
  restartService,
  checkHealth,
} from "../server/features/operations/release-service.js";
import { AuditStore } from "../server/features/audit/audit-store.js";
import { applicationVersion } from "../server/features/operations/version.js";

const COMMANDS = ["status", "enable", "disable", "hosts"];
export function parseRemoteArguments(argv) {
  const [command = "status", ...rest] = argv;
  if (!COMMANDS.includes(command))
    throw new Error(serverMessages.scripts.remoteUsage(COMMANDS.join("|")));
  const result = {
    command,
    bind: "0.0.0.0",
    hosts: [],
    add: [],
    remove: [],
    accept: false,
    restart: true,
  };
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    const value = () => {
      const next = rest[index + 1];
      if (next === undefined || next.startsWith("--"))
        throw new Error(serverMessages.scripts.remoteFlagValueRequired(flag));
      index++;
      return next;
    };
    if (flag === "--bind") result.bind = value();
    else if (flag === "--host") result.hosts.push(value());
    else if (flag === "--add") result.add.push(value());
    else if (flag === "--remove") result.remove.push(value());
    else if (flag === "--accept-plain-http") result.accept = true;
    else if (flag === "--no-restart") result.restart = false;
    else throw new Error(serverMessages.scripts.remoteUsage(COMMANDS.join("|")));
  }
  return result;
}
function recordAudit(dataDir, outcome) {
  let audit;
  try {
    audit = new AuditStore({ dataDir });
    audit.append({
      action: outcome === "success" ? "setting.updated" : "setting.failed",
      resourceType: "setting",
      resourceId: "network-access",
      outcome,
      // The audit vocabulary allows only user, system and mcp: the headless script is "system".
      source: "system",
    });
  } catch {
    console.error(serverMessages.scripts.remoteAuditFailed);
  } finally {
    audit?.close();
  }
}
export async function runRemote({
  argv,
  dataDir,
  log = console.log,
  restart = restartService,
  health = checkHealth,
  detect = detectNetworkAddresses,
} = {}) {
  const options = parseRemoteArguments(argv);
  const config = readNetworkConfig(dataDir);
  const port = config.port || 4380;
  const detected = detect();
  const print = (network) => {
    log(serverMessages.scripts.remoteStatus(network.enabled, network.bind, dataDir));
    for (const url of networkUrls({ ...network, enabled: true }, port, detected))
      log(`  ${url}`);
    if (network.enabled) log(serverMessages.scripts.remotePlainHttpWarning);
  };
  if (options.command === "status") {
    print(config.network);
    return 0;
  }
  let network = config.network;
  if (options.command === "enable") {
    if (!options.accept) {
      log(serverMessages.scripts.remotePlainHttpWarning);
      log(serverMessages.scripts.remoteAcceptRequired);
      return 2;
    }
    network = {
      enabled: true,
      bind: options.bind,
      hosts: [...network.hosts, ...options.hosts],
    };
  } else if (options.command === "disable") network = { ...network, enabled: false };
  else {
    const remove = options.remove.map((host) => host.toLowerCase());
    for (const host of remove)
      if (!network.hosts.includes(host))
        log(serverMessages.scripts.remoteHostNotListed(host));
    network = {
      ...network,
      hosts: [...network.hosts.filter((host) => !remove.includes(host)), ...options.add],
    };
  }
  try {
    writeNetworkConfig(dataDir, network);
  } catch (error) {
    recordAudit(dataDir, "failure");
    throw error;
  }
  recordAudit(dataDir, "success");
  print(readNetworkConfig(dataDir).network);
  if (!options.restart) {
    log(serverMessages.scripts.remoteRestartSkipped);
    return 0;
  }
  try {
    await restart();
  } catch {
    log(serverMessages.scripts.remoteServiceMissing);
    return 1;
  }
  const healthy = await health({ port, version: applicationVersion() });
  log(
    healthy
      ? serverMessages.scripts.remoteRestarted
      : serverMessages.scripts.remoteUnhealthy(port),
  );
  return healthy ? 0 : 1;
}
if (isMainModule(import.meta.url)) {
  const config = loadConfig();
  runRemote({ argv: process.argv.slice(2), dataDir: config.dataDir })
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
