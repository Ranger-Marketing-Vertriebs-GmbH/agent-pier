// The Overview's read-only "Auf einen Blick" rows (handoff 5.4): one short summary per
// tab, built only from data the page already has. A source that is not known yet
// yields null, so the row shows "—" instead of a made-up value.
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { assistantSettingsCopy } from "../../../lib/i18n/messages/assistant-settings.js";
import { assistantShellCopy } from "../../../lib/i18n/messages/assistant-shell.js";
import { assistantGithubCopy } from "../../../lib/i18n/messages/assistant-github.js";
import { shellLevel } from "../shell-level.js";
import { followsLeadModel } from "./agent-settings-fields.js";

const copy = () => assistantSettingsCopy.glance;
const joined = (parts) => parts.filter(Boolean).join(" · ");

/** Model (or "follows the lead's model") and whether it came from a template. */
export function identitySummary(assistant) {
  const following = followsLeadModel(assistant) && assistant.ownModel !== true;
  return joined([
    following ? copy().followsLead : assistant.model?.modelId,
    assistant.template ? copy().viaTemplate : "",
  ]);
}

/** The switched-on capabilities, the shell level and the number of skills. */
export function capabilitySummary(assistant) {
  const on = assistant.capabilities || {};
  const shell = shellLevel(assistant);
  const skills = (assistant.skills || []).length;
  const parts = [
    on.memory ? copy().memory : "",
    on.webSearch || on.webFetch ? copy().web : "",
    on.readPdfs ? copy().pdfs : "",
    on.documents ? copy().documents : "",
    on.browser ? copy().browser : "",
    on.reminders ? copy().reminders : "",
    shell !== "off" ? copy().shell(assistantShellCopy.levels[shell]) : "",
    skills ? copy().skills(skills) : "",
  ];
  return joined(parts) || copy().none;
}

/** Granted projects, MCP servers, SSH hosts, GitHub level and secrets; null until read. */
export function accessSummary(policy, assistant) {
  if (!policy) return null;
  const userAgent = Boolean(assistant.userAccess);
  const projects = userAgent
    ? Object.keys(policy.projectFiles || {}).length
    : (policy.projectIds || []).length;
  const mcp = (assistant.mcpServers || []).length;
  const ssh = (policy.sshAccesses || []).length;
  const secrets = (policy.secretIds || []).length;
  const level = policy.github?.level;
  return (
    joined([
      projects ? copy().projects(projects) : "",
      mcp ? copy().mcp(mcp) : "",
      ssh ? copy().ssh(ssh) : "",
      level ? copy().github(assistantGithubCopy.levels[level] || level) : "",
      secrets ? copy().secrets(secrets) : "",
    ]) || assistantSettingsCopy.access.empty
  );
}

/** How the lead uses its team and how many of its teams are active; null until known. */
export function teamSummary(policy, teams, assistantId) {
  if (!policy) return null;
  const active = (teams || []).filter(
    (team) => team.parentAssistantId === assistantId && !team.archivedAt,
  ).length;
  return joined([
    // A policy without a level reads as the server's default, as in the Team tab.
    assistantCopy.team.usageLevels[policy.usage] ||
      assistantCopy.team.usageLevels.suggest,
    active ? copy().teams(active) : "",
  ]);
}

/** Whether it checks in on its own and whether reminders and routines may run. */
export function automationSummary(assistant) {
  return joined([
    assistant.heartbeat?.enabled ? copy().checkIns : copy().noCheckIns,
    assistant.capabilities?.reminders ? "" : copy().remindersOff,
  ]);
}

/** Whether a Telegram bot is connected; null until the channels were read. */
export function channelSummary(channels, assistantId) {
  if (!channels) return null;
  const channel = channels.find((c) => c.assistantId === assistantId);
  return channel?.hasSecret ? copy().telegramConnected : copy().telegramOff;
}
