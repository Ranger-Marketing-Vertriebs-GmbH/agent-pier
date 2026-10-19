import api from "../../lib/api.js";
import { leadShareCopy as copy } from "../../lib/i18n/messages/lead-shares.js";

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
