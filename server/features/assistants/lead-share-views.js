// How lead shares (lead-shares.js) are recorded and shown: the audit record of a
// change, the owner's list and what a lead sees of its own standing shares.

/** One record per change: ids, kinds, levels and counts, never names or content. */
export function auditShares(
  shares,
  rows,
  { change, by, requestId = null, reason = null },
) {
  const first = rows[0];
  const skills = rows.filter((r) => r.kind === "skill").length;
  try {
    shares.w.s.audit?.append({
      action: "assistant.updated",
      resourceType: "assistant",
      resourceId: first.memberAssistantId,
      source: by === "owner" ? "user" : "system",
      outcome: "success",
      details: {
        kind: "lead-share",
        change,
        by,
        leadAssistantId: first.leadId,
        memberId: first.memberId,
        ...((requestId || first.requestId) && {
          requestId: requestId || first.requestId,
        }),
        ...(reason && { reason }),
        projects: rows
          .filter((r) => r.kind === "project")
          .map((r) => ({
            projectId: r.projectId,
            coding: !!r.coding,
            folder: r.folder || "none",
            ...(r.removed && { removed: true }),
          })),
        mcpServerIds: rows.filter((r) => r.kind === "mcp").map((r) => r.serverId),
        capabilities: rows
          .filter((r) => r.kind === "capability")
          .map((r) => r.capability),
        // Shared skills as their number, like a task member's skill grant.
        ...(skills && { skills }),
      },
    });
  } catch (error) {
    console.error("Lead share audit failed:", error?.message);
  }
}

/**
 * Shares as the owner sees them, with names and what applies now; `filter` keeps
 * a member's, a project's or a server's. Ended ones are pruned first.
 */
export function listShares(shares, filter = () => true) {
  try {
    if (shares.prune() && shares.w.a.mcp) shares.w.a.mcp.pending = true;
  } catch {
    /* Listed as they are. */
  }
  const store = shares.w.a.store;
  const name = (id) => {
    try {
      return store.getAssistant(id).name;
    } catch {
      return null;
    }
  };
  const projectName = (id) => {
    try {
      return shares.w.s.memory.project(id).name;
    } catch {
      return null;
    }
  };
  const serverName = (id) => {
    try {
      return shares.servers?.get(id)?.name ?? null;
    } catch {
      return null;
    }
  };
  return shares
    .rows()
    .filter(filter)
    .map((row) => {
      const live = shares.live(row);
      return {
        id: row.id,
        kind: row.kind,
        leadId: row.leadId,
        leadName: name(row.leadId),
        memberAssistantId: row.memberAssistantId,
        memberName: name(row.memberAssistantId),
        requestId: row.requestId || null,
        grantedAt: row.grantedAt,
        ...(row.kind === "capability"
          ? { capability: row.capability, live: { on: live.on === true } }
          : row.kind === "skill"
            ? { skill: row.skill, live: { on: live.on === true } }
            : row.kind === "project"
              ? {
                  projectId: row.projectId,
                  projectName: projectName(row.projectId),
                  coding: !!row.coding,
                  folder: row.folder || "none",
                  live: { coding: live.coding, folder: live.folder || "none" },
                }
              : {
                  serverId: row.serverId,
                  serverName: serverName(row.serverId),
                  live: { bound: live.bound },
                }),
      };
    });
}

/** `{ shares }` of a lead's permanent member `m` for agentpier_team_members, or `{}`. */
export function sharedWith(assistants, m, leadId) {
  const shares =
    m.lifetime === "permanent"
      ? assistants.workflows?.shares?.standing(m.assistantId, leadId)
      : null;
  return shares ? { shares } : {};
}

/**
 * What `leadId` shares with one of its members for good, as that lead reads it in
 * agentpier_team_members: folder levels and coding by project id, server names,
 * Read images and skill names, each only while it counts now; null without any.
 * Never throws.
 */
export function standingShares(shares, memberAssistantId, leadId) {
  const out = { projects: {}, coding: [], mcpServers: [], skills: [] };
  try {
    for (const row of shares.rows(memberAssistantId)) {
      if (row.leadId !== leadId || row.requestId) continue;
      const live = shares.live(row);
      if (row.kind === "project") {
        if (live.folder) out.projects[row.projectId] = live.folder;
        if (live.coding) out.coding.push(row.projectId);
      } else if (row.kind === "mcp") {
        const name = live.bound && shares.servers?.get(row.serverId)?.name;
        if (name) out.mcpServers.push(name);
      } else if (row.kind === "capability") {
        if (live.on) out[row.capability] = true;
      } else if (row.kind === "skill" && live.on) out.skills.push(row.skill);
    }
  } catch {
    return null;
  }
  const kept = Object.fromEntries(
    Object.entries(out).filter(([, value]) =>
      Array.isArray(value)
        ? value.length
        : typeof value === "object"
          ? Object.keys(value).length
          : value,
    ),
  );
  if (kept.skills) kept.skills.sort();
  return Object.keys(kept).length ? kept : null;
}
