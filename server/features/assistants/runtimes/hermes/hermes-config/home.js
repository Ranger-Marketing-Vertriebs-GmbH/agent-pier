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
import { skillEntries } from "./skills.js";
import { mcpEntries, mcpEnvOwned } from "./mcp.js";

// One agent's Hermes home (its own HERMES_HOME, ADR 0006 decision 4) compiled from
// its desired state: config.yaml, .env, SOUL.md and the guard plugin, nothing else.
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
// server left out is named as `mcp`, an OAuth one as `mcpOAuth`.
function unsupportedOf(agent, level, model, placed, mcp) {
  const grants = agent.tools.flatMap((grant) => grant.tools || []);
  return [
    ...(model?.unsupported ? [model.unsupported] : []),
    ...(agent.browser.wanted ? ["browser"] : []),
    ...((mcp ? mcp.skipped.length : agent.mcp.servers.length) ? ["mcp"] : []),
    ...(mcp?.oauth.length ? ["mcpOAuth"] : []),
    ...(agent.skills.assigned.some((name) => !placed.includes(name)) ? ["skills"] : []),
    ...(agent.web.readPdfs ? ["readPdfs"] : []),
    ...(grants.includes("agentpier_reminder") ? ["routines"] : []),
    ...(agent.tools.some((grant) => grant.needs?.includes("teams")) ? ["teams"] : []),
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
 * .env stay as they are (mcp.js).
 * Pure: the same inputs yield the same home.
 */
export function compileHome(
  agent,
  { workspace, strict = [], existing = {}, bundledSkills, catalogSkills, mcp } = {},
) {
  const level = shellLevel(agent, strict);
  const skills = skillEntries(agent, { bundled: bundledSkills, catalog: catalogSkills });
  const servers = mcp === undefined ? null : mcpEntries(agent, mcp, { workspace });
  const guard = guardsEveryCommand(level);
  const model = agent.model ? modelSection(agent.model) : null;
  const config = [
    ...(model ? [[["model"], model.section]] : []),
    [["agent", "disabled_toolsets"], disabledToolsets(agent, level)],
    ...(model
      ? [[["agent", "image_input_mode"], model.images ? "native" : undefined]]
      : []),
    [["terminal", "backend"], "local"],
    ...(workspace ? [[["terminal", "cwd"], workspace]] : []),
    [["approvals", "mode"], approvalMode(level)],
    [["memory", "memory_enabled"], agent.memory],
    [["memory", "user_profile_enabled"], agent.memory],
    // Hermes's defaults, written so the limit AgentPier checks edits against holds.
    [["memory", "memory_char_limit"], memoryLimits["MEMORY.md"]],
    [["memory", "user_char_limit"], memoryLimits["USER.md"]],
    [["plugins", "enabled"], guard ? [guardPlugin] : []],
    ...skills.entries,
    ...(servers
      ? [
          [
            ["mcp_servers"],
            Object.keys(servers.servers).length ? servers.servers : undefined,
          ],
        ]
      : []),
    ...practicalDefaults,
  ];
  // The model's key names while the model is known, the MCP names while the store is.
  const env = {
    owned: [...(model ? modelEnvNames : []), ...(servers ? [mcpEnvOwned] : [])],
    values: { ...(model?.env || {}), ...(servers?.env || {}) },
  };
  const files = {
    "config.yaml": mergeConfig(existing["config.yaml"], config),
    ...(env.owned.length && {
      ".env": mergeEnv(existing[".env"], env.owned, env.values),
    }),
    ...(agent.instructions !== undefined && { "SOUL.md": String(agent.instructions) }),
    ...(guard && guardFiles),
  };
  return Object.freeze({
    runtimeAgentId: agent.runtimeAgentId,
    files: Object.freeze(files),
    remove: Object.freeze(guard ? [] : [guardDirectory]),
    config: Object.freeze(config),
    env: Object.freeze(env),
    unsupported: Object.freeze(
      unsupportedOf(agent, level, model, skills.placed, servers),
    ),
  });
}
