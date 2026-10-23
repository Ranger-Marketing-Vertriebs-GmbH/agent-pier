import { assistantProblem } from "./assistant-validation.js";
import { projectFileLevels } from "./member-grants.js";
import { leadServerIds, memberServerNames } from "./team-mcp.js";
import { personalCapabilities } from "./native-capabilities.js";
import { shareableCapabilities } from "./lead-capability-shares.js";

const maxProjects = 20;
const projectId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const rank = (level) => projectFileLevels.indexOf(level);
const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * What a lead shares with a permanent member (lead-shares.js), normalized; shape
 * only. `grants` may carry only `projects` ({ projectId: "read" | "write" }) and
 * `documents` (Read images, `true`): a permanent member's other settings are the
 * owner's. `coding` names projects for coding requests, `mcpServers` servers by name.
 */
export function shareInput({ grants, coding, mcpServers } = {}) {
  if (grants !== undefined && !record(grants)) throw assistantProblem("invalid");
  if (
    grants &&
    Object.keys(grants).some(
      (key) => key !== "projects" && !shareableCapabilities.includes(key),
    )
  )
    throw assistantProblem("teamShareAccessOnly", 409);
  for (const key of shareableCapabilities)
    if (grants && key in grants && typeof grants[key] !== "boolean")
      throw assistantProblem("invalid");
  const projects = grants?.projects ?? {};
  if (!record(projects)) throw assistantProblem("invalid");
  const entries = Object.entries(projects);
  if (
    entries.length > maxProjects ||
    entries.some(([id, level]) => !projectId.test(id) || rank(level) < 0)
  )
    throw assistantProblem("invalid");
  if (
    coding !== undefined &&
    (!Array.isArray(coding) ||
      coding.length > maxProjects ||
      new Set(coding).size !== coding.length ||
      coding.some((id) => typeof id !== "string" || !projectId.test(id)))
  )
    throw assistantProblem("invalid");
  const names = memberServerNames(mcpServers);
  const change = {
    projects: Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : 1))),
    coding: [...(coding || [])].sort(),
    names,
    capabilities: shareableCapabilities.filter((key) => grants?.[key] === true),
  };
  if (
    !entries.length &&
    !change.coding.length &&
    !names.length &&
    !change.capabilities.length
  )
    throw assistantProblem("invalid");
  return change;
}

/**
 * Checks a share against what the lead holds now and resolves the server names:
 * a folder at most at the lead's level, coding only on the lead's own projects,
 * servers bound to the lead (never a stdio one for a member with its own Telegram
 * bot for other people). A revocation names servers by name only.
 */
export function leadHolds(w, lead, member, change, { revoke = false } = {}) {
  const servers = w.a.mcp?.servers || null;
  if (revoke) {
    const byName = new Map((servers?.list() || []).map((s) => [s.name, s.id]));
    return {
      ...change,
      serverIds: change.names.map((name) => byName.get(name)).filter(Boolean),
    };
  }
  const refuse = () => {
    throw assistantProblem("teamGrantNotHeld", 409);
  };
  const policy = w.access.get(lead.id);
  for (const [id, level] of Object.entries(change.projects))
    if (
      !policy.projectIds.includes(id) ||
      rank(level) < 0 ||
      rank(level) > rank(policy.projectFiles?.[id])
    )
      refuse();
  if (change.coding.some((id) => !policy.projectIds.includes(id))) refuse();
  // Read images only while the lead has it switched on itself.
  const held = personalCapabilities(lead);
  if (change.capabilities.some((key) => !held[key])) refuse();
  const serverIds = leadServerIds(servers, lead.id, change.names);
  if (
    w.a.mcp?.telegramSenders?.connected(member.assistantId) &&
    serverIds.some((id) => servers.get(id)?.transport === "stdio")
  )
    refuse();
  return { ...change, serverIds };
}

/**
 * The calling lead's own permanent member that can take a share: not archived,
 * still its permanent member. Anything else is refused like an ended member.
 */
export function shareMember(w, lead, member) {
  let agent = null;
  try {
    agent = member && w.a.store.getAssistant(member.assistantId);
  } catch {
    agent = null;
  }
  if (
    !member ||
    member.kind !== "member" ||
    member.parentAssistantId !== lead.id ||
    member.lifetime !== "permanent" ||
    member.archivedAt ||
    !agent ||
    agent.archivedAt ||
    agent.lifetime !== "permanent"
  )
    throw assistantProblem("teamGrantMemberEnded", 409);
  return member;
}

/** The granted keys of share rows, for the chat notes (member-grants.js labels). */
const keysOf = (rows) => [
  ...(rows.some((r) => r.kind === "project" && r.folder) ? ["projects"] : []),
  ...(rows.some((r) => r.kind === "project" && r.coding) ? ["coding"] : []),
  ...shareableCapabilities.filter((key) =>
    rows.some((r) => r.kind === "capability" && r.capability === key),
  ),
];

/**
 * One settled row in the member's chat and, for a lead's change, the lead's: the
 * same note a lead's grant to a task member leaves (member-grant-notes.js).
 */
export function shareNote(
  w,
  { lead, member, rows, change, by, leadConversationId, inv, keys: named = null },
) {
  const store = w.store;
  if (!store) return;
  // A revocation names what it took back; the rows then hold what is left.
  const keys = named || keysOf(rows);
  const servers = rows.filter((r) => r.kind === "mcp").length;
  if (!keys.length && !servers) return;
  const payload = {
    action: "member_grant",
    memberId: member.id,
    memberName: member.name,
    teamId: member.teamId,
    by,
    shared: true,
    ...(change === "revoke" ? { revoked: keys } : { granted: keys }),
    mcpServers: servers,
  };
  const at = Date.now();
  for (const [assistantId, conversationId] of [
    [member.assistantId, member.conversationId],
    ...(leadConversationId ? [[lead.id, leadConversationId]] : []),
  ]) {
    if (!conversationId) continue;
    store.reserve({
      assistantId,
      conversationId,
      attemptId: inv?.attemptId || null,
      origin: { kind: "member-grant" },
      key: `lead-share:${inv?.attemptId || by}:${inv?.toolCallId || at}:${assistantId}:${Math.random()}`,
      state: "completed",
      payload,
      chatNotes: { result: { at, state: "completed" } },
      settled: true,
    });
  }
}

/**
 * A lead shares (or takes back) access with its own permanent member through
 * agentpier_team_grant: standing, applies at once, no owner approval. Returns the
 * tool result.
 */
export function leadShare(w, { lead, member, conversation, inv, input }) {
  const shares = w.shares;
  if (!shares) throw assistantProblem("unavailable", 503);
  shareMember(w, lead, member);
  const change = leadHolds(
    w,
    lead,
    member,
    shareInput({
      grants: input.grants,
      coding: input.coding,
      mcpServers: input.mcpServers,
    }),
    { revoke: input.revoke === true },
  );
  const rows = shares.apply({ lead, member, change, revoke: input.revoke === true, inv });
  if (input.revoke) return leadRevoked(w, { lead, member, conversation, inv, rows });
  shareNote(w, {
    lead,
    member,
    rows,
    change: "grant",
    by: "lead",
    leadConversationId: conversation?.id,
    inv,
  });
  return {
    status: "shared",
    memberId: member.id,
    projects: Object.keys(change.projects),
    coding: change.coding,
    mcpServers: change.serverIds.length,
    ...(change.capabilities.length ? { capabilities: change.capabilities } : {}),
  };
}

/**
 * A lead's revocation names only what it actually took back (`revoked` on each
 * changed row, lead-shares.js apply): nothing removed leaves no note and tells the
 * lead so.
 */
function leadRevoked(w, { lead, member, conversation, inv, rows }) {
  const took = (key) => rows.filter((r) => r.revoked?.includes(key));
  const servers = rows.filter((r) => r.kind === "mcp").length;
  const keys = ["projects", "coding", "documents"].filter((key) => took(key).length);
  if (!keys.length && !servers)
    return { status: "nothing_to_revoke", memberId: member.id };
  shareNote(w, {
    lead,
    member,
    rows,
    keys,
    change: "revoke",
    by: "lead",
    leadConversationId: conversation?.id,
    inv,
  });
  const capabilities = took("documents").map((r) => r.capability);
  return {
    status: "revoked",
    memberId: member.id,
    projects: took("projects").map((r) => r.projectId),
    coding: took("coding").map((r) => r.projectId),
    mcpServers: servers,
    ...(capabilities.length ? { capabilities } : {}),
  };
}

/**
 * Access a lead passes with one delegated task (agentpier_team_delegate `access`):
 * checked against the lead before the task exists. Returns what applyTaskShare
 * applies once the task is recorded.
 */
export function taskShare(w, lead, member, access) {
  if (!w?.shares) throw assistantProblem("unavailable", 503);
  if (
    !record(access) ||
    Object.keys(access).some((k) => !["projects", "coding", "mcpServers"].includes(k))
  )
    throw assistantProblem("invalid");
  shareMember(w, lead, member);
  const change = leadHolds(
    w,
    lead,
    member,
    shareInput({
      grants: access.projects === undefined ? undefined : { projects: access.projects },
      coding: access.coding,
      mcpServers: access.mcpServers,
    }),
  );
  return { w, lead, member, change };
}

/** Puts a task's access in place before the member's turn starts, noted in both chats. */
export function applyTaskShare(share, request, inv) {
  const rows = share.w.shares.apply({
    lead: share.lead,
    member: share.member,
    change: share.change,
    requestId: request.id,
    inv,
  });
  shareNote(share.w, {
    lead: share.lead,
    member: share.member,
    rows,
    change: "grant",
    by: "lead",
    leadConversationId: request.parentConversationId,
    inv,
  });
}
