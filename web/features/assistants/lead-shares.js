import api from "../../lib/api.js";
import { leadShareCopy as copy } from "../../lib/i18n/messages/lead-shares.js";
import { assistantShellCopy as shellCopy } from "../../lib/i18n/messages/assistant-shell.js";

// What lead agents share with their permanent members (server lead-shares.js).
export const leadSharesPath = (filter = {}) => {
  const query = new URLSearchParams(
    Object.entries(filter).filter(([, value]) => value),
  ).toString();
  return `/assistant-lead-shares${query ? `?${query}` : ""}`;
};
export const revokeLeadShare = (id) =>
  api(`/assistant-lead-shares/${encodeURIComponent(id)}`, "DELETE");

/** The share's name: the project or the MCP server. */
export const shareName = (share) =>
  share.kind === "mcp"
    ? copy.mcpServer(share.serverName || copy.unknownServer)
    : share.projectName || copy.unknownProject;

/** What a project share gives as it counts now: "Folder: read · Coding". */
export function shareDetail(share) {
  const parts =
    share.kind === "mcp"
      ? []
      : [
          share.live?.folder && share.live.folder !== "none"
            ? copy.folder[share.live.folder]
            : "",
          share.live?.coding ? copy.coding : "",
        ].filter(Boolean);
  const active = share.kind === "mcp" ? share.live?.bound : parts.length > 0;
  return [
    ...(active ? parts : [copy.inactive]),
    share.requestId ? copy.forTask : copy.standing,
  ].join(" · ");
}

/**
 * A task-bound member's grant from its lead (server task-member-grants.js): the
 * project, server, "Shell" or "SSH" it gives.
 */
export const memberGrantName = (grant) =>
  grant.kind === "shell"
    ? shellCopy.title
    : grant.kind === "ssh"
      ? copy.sshShort
      : shareName(grant);

/**
 * What the grant gives as it counts now, marked as a task-bound member's: a grant
 * the lead does not hold right now is marked as not in effect.
 */
export function memberGrantDetail(grant) {
  const live = grant.live || {};
  let active = true,
    level = "";
  if (grant.kind === "project") {
    active = !!copy.folder[live.folder];
    level = active ? copy.folder[live.folder] : "";
  } else if (grant.kind === "mcp") active = live.bound === true;
  else if (grant.kind === "shell") {
    active = !!live.shell && live.shell !== "off";
    level = active ? copy.shell(shellCopy.levels[live.shell] || live.shell) : "";
  } else if (grant.kind === "ssh") {
    active = live.ssh === true;
    level = active ? copy.ssh : "";
  } else level = copy.codingViaLead;
  return [copy.taskMember, active ? level : copy.inactive].filter(Boolean).join(" · ");
}
