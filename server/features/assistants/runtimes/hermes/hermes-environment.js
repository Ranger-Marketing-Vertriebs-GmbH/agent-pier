import path from "node:path";
import { proxyEnvironment } from "../../../../lib/proxy-environment.js";

// Hermes treats these as launch policy or supervisor claims (its
// gateway_runtime_start.DAEMON_STRIPPED_ENV and hermes_cli.main): an AgentPier
// variable named like them would change what the agent's processes do.
const refused =
  /^(?:AGENTPIER_|HERMES_|XPC_|LAUNCHD_|INVOCATION_ID$|JOURNAL_STREAM$|NOTIFY_SOCKET$|WATCHDOG_)/;

/**
 * The environment of one Hermes agent's processes, built from nothing: its own HOME,
 * HERMES_HOME, TMPDIR and XDG folders inside AgentPier's Hermes folder, a minimal
 * PATH (Hermes's environment, the folders AgentPier provides, the system's), UTF-8,
 * and the host's proxy settings and time zone. Nothing else of AgentPier's own
 * environment reaches them (no AgentPier token, no owner credential); `extra` adds
 * variables a later configuration step supplies (model keys come through Hermes's
 * own secret source instead) and may not name AgentPier's or Hermes's own variables.
 * The agent's shell inherits this from the messaging gateway.
 */
export function hermesEnvironment({
  agent,
  runtime,
  pathPrepend = [],
  extra = {},
  parent = process.env,
  platform = process.platform,
}) {
  for (const name of Object.keys(extra))
    if (refused.test(name) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      throw Object.assign(Error("Refused Hermes environment variable."), {
        code: "HERMES_ENVIRONMENT_REFUSED",
      });
  const folders = [
    path.dirname(runtime.pythonPath),
    ...pathPrepend.filter(
      (folder) => typeof folder === "string" && path.isAbsolute(folder),
    ),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  return {
    ...proxyEnvironment(parent),
    ...(parent.TZ ? { TZ: parent.TZ } : {}),
    ...extra,
    HOME: agent.home,
    HERMES_HOME: agent.hermesHome,
    TMPDIR: agent.tmp,
    XDG_CONFIG_HOME: path.join(agent.home, ".config"),
    XDG_DATA_HOME: path.join(agent.home, ".local", "share"),
    XDG_CACHE_HOME: path.join(agent.home, ".cache"),
    XDG_STATE_HOME: path.join(agent.home, ".local", "state"),
    PATH: [...new Set(folders)].join(path.delimiter),
    LANG: platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8",
    LC_ALL: platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8",
    PYTHONIOENCODING: "utf-8",
    PYTHONNOUSERSITE: "1",
    TERM: "dumb",
  };
}
