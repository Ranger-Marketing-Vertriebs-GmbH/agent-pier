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
import * as codexPipeline from "./codex/pipeline.js";
import * as claudePipeline from "./claude/pipeline.js";
import * as opencodePipeline from "./opencode/pipeline.js";
import * as codexPlugins from "./codex/plugins.js";
import * as claudePlugins from "./claude/plugins.js";
import * as opencodePlugins from "./opencode/plugins.js";
import * as codexFiles from "./codex/profile-files.js";
import * as claudeFiles from "./claude/profile-files.js";
import * as opencodeFiles from "./opencode/profile-files.js";
import * as codexMcp from "./codex/mcp.js";
import * as claudeMcp from "./claude/mcp.js";
import * as opencodeMcp from "./opencode/mcp.js";
import * as codexProvider from "./codex/provider.js";
import * as claudeProvider from "./claude/provider.js";
import * as opencodeProvider from "./opencode/provider.js";
import * as codexTransfer from "./codex/transfer.js";
import * as claudeTransfer from "./claude/transfer.js";

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
const pipelines = {
  codex: codexPipeline,
  claude: claudePipeline,
  opencode: opencodePipeline,
};
const plugins = { codex: codexPlugins, claude: claudePlugins, opencode: opencodePlugins };
const profileFiles = { codex: codexFiles, claude: claudeFiles, opencode: opencodeFiles };
const mcps = { codex: codexMcp, claude: claudeMcp, opencode: opencodeMcp };
const providers = {
  codex: codexProvider,
  claude: claudeProvider,
  opencode: opencodeProvider,
};
const transfers = { codex: codexTransfer, claude: claudeTransfer };
// Freezes plain objects and arrays; regular expressions stay as they are.
const frozen = (value) => {
  if (Array.isArray(value)) return Object.freeze(value.map(frozen));
  if (value && Object.getPrototypeOf(value) === Object.prototype)
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, frozen(child)]),
      ),
    );
  return value;
};
const drivers = new Map();

/**
 * The driver of one coding CLI; docs/coding-clis.md describes every member.
 * definition: the browser-safe record from `<id>/definition.js`.
 * profileEnv(root): variables isolating one account under `root`.
 * configRoot(env, home): where the CLI keeps its config for `env`.
 * dataRoot(env, home): where it keeps its data (history, databases).
 * parseAuthStatus(stdout, exitCode, stderr): { signedIn, state }.
 * addMcpServer(launch, { name, command, args, env? }, claude?): adds a stdio MCP
 *   server to the launch's own `args`/`env` (Claude Code also needs `{ pluginFolder,
 *   manifest, write }`).
 * inlineMcpNames(env): the MCP server names the launch environment already holds
 *   inline (OpenCode's OPENCODE_CONFIG_CONTENT, throws when invalid; others `[]`).
 * addReminder(launch, { name, script, pluginUrl, folder, invalid }): adds a start hook
 *   (Codex hook `name` running `script`, a SessionStart hook in the Claude plugin
 *   `folder`, or the OpenCode `pluginUrl`).
 * prepareRequests({ broker, id, file, args, env, grants }, launch): starts the CLI's
 *   approval relay, changing `args`, `env` and `grants` in place; may return the
 *   launch that replaces `{ ...launch, args, env }` (Codex's wrapper).
 * requests: { question(q): { multiple, allowOther, previews, notes } for one native
 *   question, launchRecord?(env): extra fields of the launch file (Claude Code's hook
 *   version and trust file) }.
 * shellToolName: the tool whose requests carry a shell command line.
 * startupDialogs: { [presentation]: answer(broker, entry, choice) } for the startup
 *   dialogs AgentPier answers in the terminal itself.
 * history: reads the CLI's own chat history. `history` in each call is the
 *   ProviderHistory that owns the shared state (clients, caches, running jobs).
 *   list(history, session), read(history, session, id),
 *   readPage(history, session, id, state): the native page or null for a page over
 *   a full read, readReloadContext(history, session, id), watchRoots(env, home, cwd):
 *   folders to watch while a chat has no known sources, slashCommands(scan, env,
 *   cwd): discovers custom commands. normalize and observe take what the CLI's own
 *   reader produced, so their arguments differ: Codex normalize(thread) and
 *   observe(thread, records), Claude Code normalize(records) and observe(records),
 *   OpenCode normalize(exported) and observe(exported).
 * tui: reads the CLI's terminal screen (see `<id>/tui.js`).
 *   activity({ lines, original, last, tail }): { state, evidence?, animated? } for
 *   the composer region once shared dialog checks found nothing to answer.
 *   composer({ raw, lines, row, line, plain, pane }): { state, text } of the draft.
 *   modelPicker: openKeys (steps of { keys } | { type } | { pauseMs }),
 *   parse(raw): the native picker or null, current(raw): the model it shows,
 *   promptReady(raw): whether the picker may be opened, unsupported(raw): a picker
 *   AgentPier must not drive.
 *   limitWarning({ raw, pane, styled, lines }): visible native limit warnings.
 * pipeline: a pipeline turn's command line and events (see `<id>/pipeline.js`).
 *   command({ args, mode, sessionId, resumeNativeId, headless, claudeDefault }):
 *   { args, permissions }, sessionArgs(sessionId), promptArgs(prompt), and
 *   events: nativeId(event), failed(event), progress(state, event), completed(event).
 * plugins: plugin management (see `<id>/plugins.js`). inventory(store, ctx,
 *   selected), selection(action, input), actionArgs(action, selection),
 *   configFolders, catalogFiles, catalogInstall, cliList (CLIs listing plugins with
 *   `plugin list`), removeFromConfig(ctx, id, recheck) (OpenCode's config-file
 *   plugins).
 * profileFiles: { roots, credentials, backupAllowlist, configFiles, sharedDocuments,
 *   extensions, assetDirectories, nativeFolder, agents } (see `codex/profile-files.js`).
 * mcp: the CLI's native MCP entry (see `<id>/mcp.js`). toNative(entry): the native
 *   entry of a central server; fromNative(entry, shape): the central fields of a native
 *   entry, with the parse helpers `shape = { stdio, remote, extra, strings,
 *   unsupported, record, fail }` passed in; timeouts: { [nativeKey]: { field, scale } }
 *   in read and write order; remoteSseAsHttp: its `remote` cannot tell SSE from HTTP;
 *   keepsOAuthScope: its native form has no OAuth scope.
 * provider: running against a provider connection (see `<id>/provider.js`).
 *   environment(env, { directory, key, description, adapterRoute, adapterToken }): the
 *   launch environment with the provider variables, `env` itself. launch(result, ctx)
 *   configures the whole launch (Claude Code); otherwise endpointLaunch(result, ctx) and
 *   catalogLaunch(result, ctx) do, for an endpoint and a catalog provider. `ctx` is
 *   { account, description, endpoint, secret, connectionName, selection, model,
 *   metadata, env, cliVersion, adapterRoute, endpointKind }; each returns `result`.
 * transfer: moving a session between accounts; null unless the definition has
 *   `capabilities.accountTransfer` (see `<id>/transfer.js`). `fail(key)` builds the
 *   session transfer problem named `key`. locate({ history, session, id, fail }):
 *   { file, historyMode }, safePath(relative, file, id), destination(entry),
 *   companions(relative, id): extra optional paths to copy, and
 *   validator({ session, id, historyMode, fail }): { record(record), finish() }.
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
        inlineMcpNames: sessions[id].inlineMcpNames,
        prepareRequests: requests[id].prepareRequests,
        shellToolName: requests[id].shellToolName,
        requests: frozen({
          question: requests[id].question,
          launchRecord: requests[id].launchRecord,
        }),
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
        pipeline: Object.freeze({
          command: pipelines[id].command,
          sessionArgs: pipelines[id].sessionArgs,
          promptArgs: pipelines[id].promptArgs,
          events: Object.freeze({ ...pipelines[id].events }),
        }),
        plugins: frozen({ ...plugins[id] }),
        profileFiles: frozen({ ...profileFiles[id] }),
        mcp: frozen({
          toNative: mcps[id].toNative,
          fromNative: mcps[id].fromNative,
          timeouts: mcps[id].timeouts,
          remoteSseAsHttp: mcps[id].remoteSseAsHttp,
          keepsOAuthScope: mcps[id].keepsOAuthScope,
        }),
        provider: frozen({ ...providers[id] }),
        transfer: definition.capabilities.accountTransfer
          ? frozen({ ...transfers[id] })
          : null,
        parseAuthStatus(stdout, exitCode, stderr = "") {
          const state = profile.parseAuthStatus(stdout, stderr, exitCode);
          return { signedIn: state === "authenticated", state };
        },
      }),
    );
  }
  return drivers.get(id);
}
