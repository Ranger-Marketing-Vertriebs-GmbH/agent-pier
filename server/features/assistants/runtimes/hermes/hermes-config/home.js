import { mergeConfig, mergeEnv } from "./home-merge.js";
import { modelEnvNames, modelSection } from "./model.js";
import {
  approvalMode,
  disabledToolsets,
  guardsEveryCommand,
  shellLevel,
} from "./tools.js";
import { guardDirectory, guardFiles, guardPlugin } from "./guard-plugin.js";
import { memoryLimits } from "./memory.js";
import { builtInOffered, skillEntries } from "./skills.js";
import { mcpEntries, mcpEnvOwned } from "./mcp.js";
import { channelBotEnvNames, channelBotHome, senderLockedToolsets } from "./telegram.js";
import {
  teamDirectory,
  teamPlugin,
  teamPluginFiles,
  teamSkillFolder,
  teamTools,
} from "./team-plugin.js";

// One agent's Hermes home (its own HERMES_HOME, ADR 0006 decision 4) compiled from
// its desired state: config.yaml, .env, SOUL.md, the guard plugin, the team plugin
// (team-plugin.js) and the Deepgram plugin of its own Telegram bot (telegram.js),
// nothing else.
// Key names verified against Hermes v0.22.5 (hermes_cli/config_defaults.py unless
// named otherwise; docs/hermes-runtime.md lists them).

/**
 * Practical defaults (ADR 0006 decision 5): AgentPier turns off only what touches
 * credentials, sends data off the host without the owner's choice, changes the
 * installation, or rewrites the first turn.
 */
const practicalDefaults = [
  // Dangerous commands of invisible subagents reach the owner through the session's
  // approval queue of the messaging gateway (tools/delegate_tool_config.py: gateway
  // sessions resolve approvals per session; tools/approval.py `_human_decision`); this
  // fallback for a child without one denies instead of approving.
  [["delegation", "subagent_auto_approve"], false],
  // Never search through third-party free tiers the owner did not choose.
  [["web", "keyless_fallback"], false],
  // Never borrow and refresh the host's Codex or Claude Code logins.
  [["auth", "adopt_external_logins"], false],
  // No profile-building offer appended to the first message.
  [["onboarding", "profile_build"], "off"],
  // AgentPier provisions and updates the installation: no update checks, plugin
  // update checks or packages installed from PyPI at run time.
  [["updates", "check"], false],
  [["plugins", "auto_update_check_hours"], 0],
  [["security", "allow_lazy_installs"], false],
  // Shared metrics stay off (they are off by default; a consent prompt would turn
  // them on).
  [["telemetry", "shared_metrics", "enabled"], false],
  [["telemetry", "shared_metrics", "send"], false],
];

// What Hermes cannot take from the desired state yet, by reason id. `placed`: the
// assigned skills the home offers (skills.js); any other is named as `skills`.
// `mcp`: the compiled servers (mcp.js), null when the store was not read; a bound
// server left out is named as `mcp`, an OAuth one as `mcpOAuth`. `team`: the team
// plugin's files (team-plugin.js), without which team tools are named as `teams`;
// `browser`: whether the agent browses on AgentPier's Chromium, else a wish for the
// browser is named.
function unsupportedOf(agent, level, model, { placed, mcp, team, browser }) {
  const grants = agent.tools.flatMap((grant) => grant.tools || []);
  return [
    ...(model?.unsupported ? [model.unsupported] : []),
    ...(agent.browser.wanted && !browser ? ["browser"] : []),
    ...((mcp ? mcp.skipped.length : agent.mcp.servers.length) ? ["mcp"] : []),
    ...(mcp?.oauth.length ? ["mcpOAuth"] : []),
    ...(agent.skills.assigned.some((name) => !placed.includes(name)) ? ["skills"] : []),
    ...(agent.web.readPdfs ? ["readPdfs"] : []),
    ...(grants.includes("agentpier_reminder") ? ["routines"] : []),
    ...(!team && agent.tools.some((grant) => grant.needs?.includes("teams"))
      ? ["teams"]
      : []),
    ...(level !== "off" && agent.shell.pathPrepend.length ? ["shellPath"] : []),
  ];
}

/**
 * The home of `agent` (a desiredAgent): `{ runtimeAgentId, files, remove, config,
 * env, unsupported }`. `files` maps paths inside the home to their text, config.yaml
 * and .env merged over `existing` (`{ "config.yaml", ".env" }` as found there);
 * `remove` names AgentPier's paths that must not stay; `config` (`[[path, value]]`)
 * and `env` (`{ owned, values }`) are what a writer merges again over the files it
 * finds. Without `agent.model` the model section and its secrets stay as they were,
 * without `agent.instructions` SOUL.md does. `workspace`: the agent's folder, where
 * its commands start; `strict`: runtime agent ids on every-command approval;
 * `bundledSkills`: the names the installation bundles, `catalogSkills`: `{ [name]:
 * folder }` of catalog skills it may offer (skills.js); `mcp`: the MCP store's inputs
 * (the desired state's host `mcp`), without which `mcp_servers` and its secrets in
 * .env stay as they are (mcp.js); `connection`: the team bridge's `{ url, token }`
 * for the team plugin (team-plugin.js); `browser`: `{ cdpUrl, allowPrivateNetwork }`
 * of the Chromium AgentPier runs for the agent (hermes-browser.js), or none.
 * Pure: the same inputs yield the same home.
 */
export function compileHome(
  agent,
  {
    workspace,
    strict = [],
    existing = {},
    bundledSkills,
    catalogSkills,
    mcp,
    connection,
    browser,
  } = {},
) {
  const level = shellLevel(agent, strict);
  const servers = mcp === undefined ? null : mcpEntries(agent, mcp, { workspace });
  const guard = guardsEveryCommand(level);
  // The browser needs the agent's own setting, AgentPier's Chromium and the guard,
  // which starts that Chromium and pins every call to it.
  const browsing = !!(agent.browser.wanted && browser?.cdpUrl && connection);
  // Built-in skills (shopping) need the browser, so they come with the team plugin.
  const builtIn = builtInOffered(agent, browsing);
  const team = teamPluginFiles(agent, {
    connection,
    browser: browsing,
    skills: builtIn,
  });
  const skills = skillEntries(agent, {
    bundled: bundledSkills,
    catalog: catalogSkills,
    builtIn: Object.fromEntries(builtIn.map((name) => [name, teamSkillFolder(name)])),
  });
  const model = agent.model ? modelSection(agent.model) : null;
  // The agent's own bot, when the desired state knows it (an apply, not a bare start).
  const bot = agent.channelBot !== undefined ? channelBotHome(agent) : null;
  const toolsets = [
    ...disabledToolsets(agent, level, { browser: browsing }),
    ...(bot?.senders ? senderLockedToolsets : []),
  ];
  const plugins = [
    ...(guard ? [guardPlugin] : []),
    ...(team ? [teamPlugin] : []),
    ...(bot?.plugin ? [bot.plugin] : []),
  ];
  const config = [
    ...(model ? [[["model"], model.section]] : []),
    [["agent", "disabled_toolsets"], [...new Set(toolsets)].sort()],
    ...(model
      ? [[["agent", "image_input_mode"], model.images ? "native" : undefined]]
      : []),
    [["terminal", "backend"], "local"],
    ...(workspace ? [[["terminal", "cwd"], workspace]] : []),
    [["approvals", "mode"], approvalMode(level)],
    // Hermes's Tool Search would put plugin tools behind its tool_search bridge
    // (tools/tool_search.py is_deferrable_tool_name); the team tools stay at hand, as
    // OpenClaw offers them, and the instructions name them directly.
    ...(team && teamTools(agent).length
      ? [[["tools", "tool_search", "enabled"], "off"]]
      : []),
    // Hermes's own browser tools (backend "off": not Browser Use) on AgentPier's
    // Chromium: a CDP URL never launches a browser of Hermes's own
    // (tools/browser_tool_session.py). Private and loopback addresses follow the
    // owner's browser network setting, as on OpenClaw; cloud metadata addresses stay
    // blocked either way (tools/url_safety.py).
    ...(browsing
      ? [
          [["browser", "backend"], "off"],
          [["browser", "cdp_url"], browser.cdpUrl],
          [["browser", "allow_private_urls"], browser.allowPrivateNetwork === true],
        ]
      : []),
    [["memory", "memory_enabled"], agent.memory],
    [["memory", "user_profile_enabled"], agent.memory],
    // Hermes's defaults, written so the limit AgentPier checks edits against holds.
    [["memory", "memory_char_limit"], memoryLimits["MEMORY.md"]],
    [["memory", "user_char_limit"], memoryLimits["USER.md"]],
    [["plugins", "enabled"], plugins],
    ...skills.entries,
    ...(servers
      ? [
          [
            ["mcp_servers"],
            Object.keys(servers.servers).length ? servers.servers : undefined,
          ],
        ]
      : []),
    ...(bot ? bot.config : []),
    ...practicalDefaults,
  ];
  // .env names a part of the home owns only while the desired state knows that part:
  // the model's key names while the model is known, the MCP names while the store is,
  // the bot's while its settings are.
  const env = {
    owned: [
      ...(model ? modelEnvNames : []),
      ...(servers ? [mcpEnvOwned] : []),
      ...(bot ? channelBotEnvNames : []),
    ],
    values: { ...model?.env, ...servers?.env, ...bot?.env },
  };
  const files = {
    "config.yaml": mergeConfig(existing["config.yaml"], config),
    ...(env.owned.length && {
      ".env": mergeEnv(existing[".env"], env.owned, env.values),
    }),
    ...(agent.instructions !== undefined && { "SOUL.md": String(agent.instructions) }),
    ...(guard && guardFiles),
    ...bot?.files,
    ...team,
  };
  return Object.freeze({
    runtimeAgentId: agent.runtimeAgentId,
    files: Object.freeze(files),
    remove: Object.freeze([
      ...(guard ? [] : [guardDirectory]),
      ...(team ? [] : [teamDirectory]),
      ...(bot?.remove || []),
    ]),
    config: Object.freeze(config),
    env: Object.freeze(env),
    unsupported: Object.freeze(
      unsupportedOf(agent, level, model, {
        placed: skills.placed,
        mcp: servers,
        team,
        browser: browsing,
      }),
    ),
  });
}
