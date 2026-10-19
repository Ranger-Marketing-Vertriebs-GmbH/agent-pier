import { assistantProblem } from "./assistant-validation.js";
import { defaultGrants } from "./member-grants.js";

const ended = new Set(["completed", "failed", "cancelled", "declined"]);
const kinds = ["project", "mcp", "shell", "ssh", "coding"];
// Coding is not a grant of its own: a task member requests coding runs on its lead's
// projects and pipelines while its team works, each approved by the owner
// (team-coding.js). It is listed for the owner to see, never revoked on its own.
const revocable = new Set(["project", "mcp", "shell", "ssh"]);
const withResource = new Set(["project", "mcp", "coding"]);

/** The id of one inherited grant: `task:<memberId>:<kind>[:<project or server>]`. */
export const taskGrantId = (memberId, kind, resource = null) =>
  ["task", memberId, kind, ...(resource ? [resource] : [])].join(":");

/** Whether `id` names a task member's grant rather than a lead share. */
export const isTaskGrantId = (id) => typeof id === "string" && id.startsWith("task:");

/** `{ memberId, kind, resource }` of a well-formed id, otherwise null. */
export function parseTaskGrantId(id) {
  if (!isTaskGrantId(id) || id.length > 300) return null;
  const [, memberId, kind, resource = null, ...rest] = id.split(":");
  if (rest.length || !memberId || !kinds.includes(kind)) return null;
  if (withResource.has(kind) !== !!resource) return null;
  return { memberId, kind, resource };
}

/**
 * What lead agents granted their temporary (task-bound) members through
 * agentpier_team_grant or the team proposal (member-grants.js), listed beside the
 * shares with permanent members (lead-shares.js) for the owner: project folders with
 * the level the member uses now (capped live by the lead), MCP servers, shell and
 * SSH, and, for information, coding through the lead. The owner revokes a folder,
 * server, shell or SSH grant exactly like the lead's own `revoke: true`
 * (MemberGrants.ownerRevoke). Only members whose grants still matter are listed:
 * not archived, not kept as permanent agents, and working or still reachable by
 * their lead (MemberGrants.live).
 */
export class TaskMemberGrants {
  constructor(workflows) {
    this.w = workflows;
  }
  get teams() {
    return this.w.a.teams?.store || null;
  }
  get servers() {
    return this.w.a.mcp?.servers || null;
  }
  members() {
    const teams = this.teams;
    if (!teams) return [];
    return teams
      .members()
      .filter(
        (m) =>
          m.lifetime !== "permanent" &&
          !m.archivedAt &&
          !!m.assistantId &&
          (!ended.has(m.phase) || !!m.conversationId),
      );
  }
  // The member may request coding runs while its team works (team-coding.js).
  codingOpen(m) {
    const team = this.teams.find(m.teamId);
    return !!team && !team.archivedAt && !ended.has(team.phase) && !m.stopRequested;
  }
  agent(id) {
    try {
      return this.w.a.store.getAssistant(id);
    } catch {
      return null;
    }
  }
  // Whether the lead holds the server now; unreadable counts as not held.
  leadBound(leadId, serverId) {
    try {
      return !!this.servers?.bindings("agent", leadId).includes(serverId);
    } catch {
      return false;
    }
  }
  leadProjects(leadId) {
    try {
      return this.w.access.get(leadId).projectIds || [];
    } catch {
      return [];
    }
  }
  projectName(id) {
    try {
      return this.w.s.memory.project(id).name;
    } catch {
      return null;
    }
  }
  serverName(id) {
    try {
      return this.servers?.get(id)?.name ?? null;
    } catch {
      return null;
    }
  }
  /** One member's inherited grants as the owner sees them. */
  rows(m) {
    const agent = this.agent(m.assistantId);
    if (!agent || agent.archivedAt) return [];
    const lead = this.agent(m.parentAssistantId);
    const leadActive = !!lead && !lead.archivedAt;
    const inherited = agent.inherited || {};
    const grants = m.grants ?? defaultGrants;
    const row = (kind, resource, fields) => ({
      id: taskGrantId(m.id, kind, resource),
      kind,
      temporary: true,
      revocable: revocable.has(kind),
      leadId: m.parentAssistantId,
      leadName: lead?.name ?? null,
      memberId: m.id,
      memberAssistantId: m.assistantId,
      memberName: agent.name,
      requestId: null,
      ...fields,
    });
    const rows = [];
    for (const [projectId, level] of Object.entries(grants.projects || {}))
      rows.push(
        row("project", projectId, {
          projectId,
          projectName: this.projectName(projectId),
          coding: false,
          folder: level,
          live: { coding: false, folder: inherited.projects?.[projectId] || "none" },
        }),
      );
    if (leadActive && this.codingOpen(m))
      for (const projectId of this.leadProjects(m.parentAssistantId))
        rows.push(
          row("coding", projectId, {
            projectId,
            projectName: this.projectName(projectId),
            live: { coding: true },
          }),
        );
    const serverIds = [
      ...new Set([...(m.mcpServerIds || []), ...(m.grantedMcpServerIds || [])]),
    ];
    for (const serverId of serverIds)
      rows.push(
        row("mcp", serverId, {
          serverId,
          serverName: this.serverName(serverId),
          live: { bound: leadActive && this.leadBound(m.parentAssistantId, serverId) },
        }),
      );
    if (grants.shell)
      rows.push(
        row("shell", null, {
          shell: grants.shell,
          live: { shell: inherited.shell || "off" },
        }),
      );
    if (grants.ssh)
      rows.push(row("ssh", null, { live: { ssh: inherited.ssh === true } }));
    return rows;
  }
  /** Every listed grant `filter` keeps. Unreadable members are left out. */
  list(filter = () => true) {
    return this.members()
      .flatMap((m) => {
        try {
          return this.rows(m);
        } catch {
          return [];
        }
      })
      .filter(filter);
  }
  /**
   * The owner revokes one grant like the lead's own revoke: the member's record,
   * the audit with the owner as actor, notes in both chats and waiting shell or SSH
   * cards for it. Returns `{ removed, kind }`; the caller applies an MCP change.
   */
  revoke(id) {
    const parsed = parseTaskGrantId(id);
    const grants = this.w.a.teams?.grants;
    if (!parsed) throw assistantProblem("notFound", 404);
    if (!revocable.has(parsed.kind)) throw assistantProblem("invalid");
    if (!grants) throw assistantProblem("unavailable", 503);
    if (!this.list((r) => r.id === id).length) throw assistantProblem("notFound", 404);
    const { memberId, kind, resource } = parsed;
    grants.ownerRevoke(memberId, {
      removed:
        kind === "project"
          ? { projects: { [resource]: "read" } }
          : kind === "mcp"
            ? {}
            : { [kind]: true },
      ids: kind === "mcp" ? [resource] : [],
    });
    return { removed: id, kind };
  }
}
