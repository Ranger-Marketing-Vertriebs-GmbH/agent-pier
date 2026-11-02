// Node-only: the per-CLI behaviour that touches the file system. The catalog next
// to it stays browser-safe.
import { cliDefinition } from "./catalog.js";
import * as codex from "./codex/profile.js";
import * as claude from "./claude/profile.js";
import * as opencode from "./opencode/profile.js";
import * as codexSession from "./codex/session-config.js";
import * as claudeSession from "./claude/session-config.js";
import * as opencodeSession from "./opencode/session-config.js";
import * as codexRequests from "./codex/requests.js";
import * as claudeRequests from "./claude/requests.js";
import * as opencodeRequests from "./opencode/requests.js";

const profiles = { codex, claude, opencode };
const sessions = {
  codex: codexSession,
  claude: claudeSession,
  opencode: opencodeSession,
};
const requests = {
  codex: codexRequests,
  claude: claudeRequests,
  opencode: opencodeRequests,
};
const drivers = new Map();

/**
 * profileEnv(root): variables isolating one account under `root`.
 * configRoot(env, home): where the CLI keeps its config for `env`.
 * dataRoot(env, home): where it keeps its data (history, databases).
 * parseAuthStatus(stdout, exitCode, stderr): { signedIn, state }.
 * addMcpServer(launch, { name, command, args, env? }, claude?): adds a stdio MCP
 *   server to the launch's own `args`/`env` (Claude Code also needs `{ plugin,
 *   manifest, write }`).
 * addReminder(launch, { name, script, plugin, folder, invalid }): adds a start hook
 *   (Codex hook `name` running `script`, a SessionStart hook in the Claude plugin
 *   `folder`, or the OpenCode `plugin` URL).
 * prepareRequests({ broker, id, file, args, env, grants }, launch): starts the CLI's
 *   approval relay, changing `args`, `env` and `grants` in place; may return the
 *   launch that replaces `{ ...launch, args, env }` (Codex's wrapper).
 * shellToolName: the tool whose requests carry a shell command line.
 * startupDialogs: { [presentation]: answer(broker, entry, choice) } for the startup
 *   dialogs AgentPier answers in the terminal itself.
 */
export function cliDriver(id) {
  const definition = cliDefinition(id);
  if (!drivers.has(id)) {
    const profile = profiles[id];
    drivers.set(
      id,
      Object.freeze({
        definition,
        profileEnv: profile.profileEnv,
        configRoot: profile.configRoot,
        dataRoot: profile.dataRoot,
        addMcpServer: sessions[id].addMcpServer,
        addReminder: sessions[id].addReminder,
        prepareRequests: requests[id].prepareRequests,
        shellToolName: requests[id].shellToolName,
        startupDialogs: Object.freeze({ ...requests[id].startupDialogs }),
        parseAuthStatus(stdout, exitCode, stderr = "") {
          const state = profile.parseAuthStatus(stdout, stderr, exitCode);
          return { signedIn: state === "authenticated", state };
        },
      }),
    );
  }
  return drivers.get(id);
}
