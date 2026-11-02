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
import * as codexHistory from "./codex/history.js";
import * as claudeHistory from "./claude/history.js";
import * as opencodeHistory from "./opencode/history.js";
import * as codexTui from "./codex/tui.js";
import * as claudeTui from "./claude/tui.js";
import * as opencodeTui from "./opencode/tui.js";

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
const histories = {
  codex: codexHistory,
  claude: claudeHistory,
  opencode: opencodeHistory,
};
const tuis = { codex: codexTui, claude: claudeTui, opencode: opencodeTui };
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
 * history: reads the CLI's own chat history. `history` in each call is the
 *   ProviderHistory that owns the shared state (clients, caches, running jobs).
 *   list(history, session), read(history, session, id),
 *   readPage(history, session, id, state): the native page or null for a page over
 *   a full read, readReloadContext(history, session, id), normalize(records),
 *   observe(records), watchRoots(env, home, cwd): folders to watch while a chat has
 *   no known sources, slashCommands(scan, env, cwd): discovers custom commands.
 * tui: reads the CLI's terminal screen (see `<id>/tui.js`).
 *   activity({ lines, original, last, tail }): { state, evidence?, animated? } for
 *   the composer region once shared dialog checks found nothing to answer.
 *   composer({ raw, lines, row, line, plain, pane }): { state, text } of the draft.
 *   modelPicker: openKeys (steps of { keys } | { type } | { pauseMs }),
 *   parse(raw): the native picker or null, current(raw): the model it shows,
 *   promptReady(raw): whether the picker may be opened, unsupported(raw): a picker
 *   AgentPier must not drive.
 *   limitWarning({ raw, pane, styled, lines }): visible native limit warnings.
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
        history: Object.freeze({
          list: histories[id].list,
          read: histories[id].read,
          readPage: histories[id].readPage,
          readReloadContext: histories[id].readReloadContext,
          normalize: histories[id].normalize,
          observe: histories[id].observe,
          watchRoots: histories[id].watchRoots,
          slashCommands: histories[id].slashCommands,
        }),
        tui: Object.freeze({
          activity: tuis[id].activity,
          composer: tuis[id].composer,
          limitWarning: tuis[id].limitWarning,
          modelPicker: Object.freeze({
            ...tuis[id].modelPicker,
            openKeys: Object.freeze(
              tuis[id].modelPicker.openKeys.map((step) => Object.freeze({ ...step })),
            ),
          }),
        }),
        parseAuthStatus(stdout, exitCode, stderr = "") {
          const state = profile.parseAuthStatus(stdout, stderr, exitCode);
          return { signedIn: state === "authenticated", state };
        },
      }),
    );
  }
  return drivers.get(id);
}
