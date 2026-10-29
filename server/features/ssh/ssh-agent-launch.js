// Composes a launch with the session's SSH agent (ssh-session-agents.js): the wrappers
// first on PATH, Git and rsync pointed at the `ssh` wrapper, the config and socket
// named for hints and fallbacks, and the sandbox grants of the agent's own paths. A
// variable the CLI actually receives (the launch's, or the server's as
// `cleanEnvironment` passes it on) is never replaced, so the user's own agent keeps
// serving every other host (spec call 6, R1, R29).
import path from "node:path";
import { cleanEnvironment } from "../accounts/account-store.js";
import { addGrant } from "../nono/sandbox-grants.js";
import { SSH_AGENT_HINT_ENV } from "./ssh-hook.js";
import { SSH_AGENT_SOCK_ENV, SSH_CONFIG_ENV } from "./ssh-session-agents.js";

// GIT_SSH_COMMAND runs through `sh -c`: one single-quoted word.
export function shellWord(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// rsync splits RSYNC_RSH itself: inside quotes a doubled quote is a literal one.
export function rsyncWord(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * The launch with the agent's environment and grants. `inherited` is what the CLI gets
 * from the server besides `launch.env`: the server's environment as filtered for every
 * launch, so a server variable that never reaches the CLI does not count.
 */
export function withAgentEnvironment(
  launch,
  details,
  { tool, inherited = cleanEnvironment() },
) {
  const env = { ...launch.env };
  const absent = (key) => env[key] === undefined && inherited[key] === undefined;
  const base = launch.env?.PATH ?? inherited.PATH;
  env.PATH = base ? `${details.binDir}${path.delimiter}${base}` : details.binDir;
  const ssh = path.join(details.binDir, "ssh");
  if (absent("GIT_SSH_COMMAND")) env.GIT_SSH_COMMAND = shellWord(ssh);
  if (absent("RSYNC_RSH")) env.RSYNC_RSH = rsyncWord(ssh);
  if (absent("SSH_AUTH_SOCK")) env.SSH_AUTH_SOCK = details.socketPath;
  env[SSH_CONFIG_ENV] = details.configPath;
  env[SSH_AGENT_SOCK_ENV] = details.socketPath;
  // The start hint names the agent; shell sessions have no hint.
  if (tool === "shell") delete env[SSH_AGENT_HINT_ENV];
  else env[SSH_AGENT_HINT_ENV] = "1";
  return details.grants.reduce((granted, grant) => addGrant(granted, grant), {
    ...launch,
    env,
  });
}

/**
 * The launch adapter: prepares the session's agent (launch, reload) and composes the
 * launch from its paths. Without an agent the launch comes back as prepared.
 */
export async function prepareSessionSshAgent(sshAgents, input) {
  if (!sshAgents) return input.launch;
  const launch = await sshAgents.prepare(input);
  if (!launch?.sshAgent) return launch;
  const details = sshAgents.launchDetails(input.id);
  if (!details) {
    // Discarded while it started: the session runs without an agent.
    const { sshAgent: _gone, ...rest } = launch;
    return rest;
  }
  return withAgentEnvironment(launch, details, { tool: input.account?.tool });
}
