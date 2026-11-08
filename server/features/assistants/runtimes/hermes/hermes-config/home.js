import { mergeAuth, mergeConfig, mergeEnv } from "./home-merge.js";
import { modelEnvNames, modelSection } from "./model.js";
import {
  approvalMode,
  disabledToolsets,
  everyCommand,
  guardsEveryCommand,
  shellLevel,
} from "./tools.js";
import {
  guardDirectory,
  guardFiles,
  guardHookTimeoutS,
  guardPlugin,
} from "./guard-plugin.js";
import { memoryLimits } from "./memory.js";
import { builtInOffered, skillEntries } from "./skills.js";
import { mcpEntries, mcpEnvOwned } from "./mcp.js";
import { channelBotEnvNames, channelBotHome, senderLockedToolsets } from "./telegram.js";
import { webDirectory, webEnvNames, webHome } from "./web.js";
import { imageHome } from "./images.js";
import { pdfHome, pdfKeyEnv } from "./pdf.js";
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
 * Hermes's counterparts of the tools an agent of restricted users never holds on
 * OpenClaw (native-capabilities.js lockedTools): subagents (`delegation`, as
 * sessions_spawn), other chats (`session_search`, as the sessions tools) and connector
 * accounts (`connections`). Its shell is off through its shell level already.
 */
export const userLockedToolsets = Object.freeze([
  "connections",
  "delegation",
  "session_search",
]);

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
  // PDFs never go to Firecrawl's hosted OCR (tools/read_extract.py, used with a
  // FIRECRAWL_API_KEY): AgentPier's pdf tool reads scanned pages with the model the
  // owner chose (pdf.js).
  [["file_tools", "hosted_ocr"], false],
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
// browser is named; `images`: whether it creates images (images.js), else a wish for
// them is named.
function unsupportedOf(agent, level, model, { placed, mcp, team, browser, images }) {
  return [
    ...(model?.unsupported ? [model.unsupported] : []),
    ...((agent.browser.wanted || agent.browser.borrowed) && !browser ? ["browser"] : []),
    ...((mcp ? mcp.skipped.length : agent.mcp.servers.length) ? ["mcp"] : []),
    ...(mcp?.oauth.length ? ["mcpOAuth"] : []),
    ...(agent.skills.assigned.some((name) => !placed.includes(name)) ? ["skills"] : []),
    // Images need a ChatGPT login AgentPier holds, its proxy and the guard.
    ...(agent.web.createImages && !images ? ["createImages"] : []),
    // AgentPier's own and team tools come with the team plugin and its bridge.
    ...(!team && teamTools(agent).length ? ["teams"] : []),
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
 * of the Chromium AgentPier runs for the agent (hermes-browser.js), or none; `web`:
 * `{ search, ddgs }` for its web search and fetch (web.js webHome), without which
 * the search backend and its key stay as they are; `modelProxy`: `{ url,
 * credentialFor(profileId) }` of AgentPier's model proxy for this agent, through
 * which a ChatGPT account is reached (model.js); `imageLogin`: the profile id of the
 * ChatGPT login AgentPier holds that the agent creates images with (images.js), or
 * none; `pdfFallback`: the owner's PDF fallback connection as an apply resolves it
 * (pdf.js), null without one, undefined when the apply does not name it.
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
    web,
    modelProxy,
    imageLogin,
    pdfFallback,
  } = {},
) {
  const level = shellLevel(agent, strict);
  const servers = mcp === undefined ? null : mcpEntries(agent, mcp, { workspace });
  // The browser needs the agent's own setting, AgentPier's Chromium and the guard,
  // which starts that Chromium and pins every call to it.
  // A temporary member's browser is the one its lead granted (`borrowed`).
  const browsing = !!(
    (agent.browser.wanted || agent.browser.borrowed) &&
    browser?.cdpUrl &&
    connection
  );
  // Built-in skills (shopping) need the browser, so they come with the team plugin.
  const builtIn = builtInOffered(agent, browsing);
  const model = agent.model ? modelSection(agent.model, { modelProxy }) : null;
  // The team plugin's guard, which image creation and the pdf tool ask at each call.
  const guarded = !!(connection?.url && connection?.token);
  // Image creation through the proxy, every call checked by the team plugin's guard.
  const imagePart = imageHome(agent, {
    model,
    modelProxy,
    imageLogin,
    guarded,
  });
  const images = !!imagePart && !imagePart.unsupported;
  // AgentPier's pdf tool; the fallback only while the apply names it (pdfFallback).
  const pdf = pdfHome(agent, {
    model,
    pdf: pdfFallback,
    modelProxy,
    workspace,
    guarded,
  });
  const pdfKnown = !!model && pdfFallback !== undefined;
  const team = teamPluginFiles(agent, {
    connection,
    browser: browsing,
    skills: builtIn,
    images: images && workspace ? { folder: workspace } : null,
    pdf: pdf?.settings,
  });
  // Routine runs on an asking level ask the owner through the team bridge, which the
  // team plugin's bridge.json names (guard-plugin.js); Hermes's cron gate then lets
  // through only what the guard let through (`approvals.cron_mode: approve`).
  const cronAsks = !!team && ["approval", everyCommand].includes(level);
  const guard = guardsEveryCommand(level) || cronAsks;
  const skills = skillEntries(agent, {
    bundled: bundledSkills,
    catalog: catalogSkills,
    builtIn: Object.fromEntries(builtIn.map((name) => [name, teamSkillFolder(name)])),
  });
  // The agent's own bot, when the desired state knows it (an apply, not a bare start).
  const bot = agent.channelBot !== undefined ? channelBotHome(agent) : null;
  // Web search and fetch (web.js); the search backend while the apply names `web`.
  const webPart = webHome(agent, web);
  const toolsets = [
    ...disabledToolsets(agent, level, { browser: browsing, images }),
    ...(bot?.senders ? senderLockedToolsets : []),
    ...(agent.locked ? userLockedToolsets : []),
    ...(webPart?.toolsets || []),
  ];
  const plugins = [
    ...(guard ? [guardPlugin] : []),
    ...(team ? [teamPlugin] : []),
    ...(bot?.plugin ? [bot.plugin] : []),
    ...(webPart ? [webPart.plugin] : []),
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
    // Hermes's own default `deny` without the guard's question (tools/approval.py).
    [["approvals", "cron_mode"], cronAsks ? "approve" : undefined],
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
    // The guard's question waits for the owner (hermes_cli/plugins.py, at most 600 s).
    [["plugins", "hook_callback_timeout"], cronAsks ? guardHookTimeoutS : undefined],
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
    ...(webPart?.config || []),
    [["image_gen", "provider"], images ? "openai-codex" : undefined],
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
      // The web key names while the apply names the web settings, so a key the
      // agent no longer uses goes.
      ...(web && typeof web === "object" ? webEnvNames : []),
      // The Codex URL of an image row (images.js) while the model is unknown.
      ...(images && imagePart.env ? Object.keys(imagePart.env) : []),
      // The PDF fallback's key while the model and the fallback are known.
      ...(pdfKnown ? [pdfKeyEnv] : []),
    ],
    values: {
      ...model?.env,
      ...servers?.env,
      ...bot?.env,
      ...webPart?.env.values,
      ...(images && imagePart.env),
      ...(pdfKnown && pdf?.env),
    },
  };
  // The proxy's pool row: the ChatGPT model's, else the image login's (images.js).
  const authKnown = !!model || (images && !!imagePart.auth);
  const authRow = model?.auth || (images && imagePart.auth) || null;
  const files = {
    "config.yaml": mergeConfig(existing["config.yaml"], config),
    ...(env.owned.length && {
      ".env": mergeEnv(existing[".env"], env.owned, env.values),
    }),
    // The model proxy's pool row while the model is known (model.js `auth`).
    ...(authKnown &&
      mergeAuth(existing["auth.json"], authRow) !== undefined && {
        "auth.json": mergeAuth(existing["auth.json"], authRow),
      }),
    ...(agent.instructions !== undefined && { "SOUL.md": String(agent.instructions) }),
    ...(guard && guardFiles({ everyCommand: guardsEveryCommand(level), cronAsks })),
    ...bot?.files,
    ...webPart?.files,
    ...team,
  };
  return Object.freeze({
    runtimeAgentId: agent.runtimeAgentId,
    files: Object.freeze(files),
    remove: Object.freeze([
      ...(guard ? [] : [guardDirectory]),
      ...(team ? [] : [teamDirectory]),
      ...(bot?.remove || []),
      ...(webPart ? [] : [webDirectory]),
    ]),
    config: Object.freeze(config),
    env: Object.freeze(env),
    // The auth.json pool row a writer merges again (null: AgentPier's row goes).
    auth: authKnown ? authRow : undefined,
    unsupported: Object.freeze(
      unsupportedOf(agent, level, model, {
        placed: skills.placed,
        mcp: servers,
        team,
        browser: browsing,
        images,
      }).concat(webPart?.unsupported || []),
    ),
  });
}
