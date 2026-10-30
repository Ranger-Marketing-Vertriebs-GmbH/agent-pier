import { randomUUID } from "node:crypto";
import { assistantProblem } from "./assistant-validation.js";
import { refuseUserAgent } from "../users/user-agent-lock.js";

// Named, lasting groups of a lead's permanent members (AGENTPIER-283), such as
// "Research" or "Build". Each is a `member-group` record in the team store whose
// parent is the lead, so it goes with the lead's other team records (agent-deletion.js)
// and travels with full backups. Older releases read team records by kind and never
// this one, so they ignore groups. A member is in at most one group of its lead; a
// member that is archived, deleted or no longer a permanent member of the lead leaves
// its group, and an empty group stays until it is deleted.
export const groupKind = "member-group";
export const groupLimits = Object.freeze({ name: 60, perLead: 20 });

const clean = (name) =>
  typeof name === "string" ? name.replace(/\s+/g, " ").trim() : "";

/** What the browser and the lead's tools see of a group. */
export const publicGroup = (g) => ({
  id: g.id,
  kind: g.kind,
  revision: g.revision,
  parentAssistantId: g.parentAssistantId,
  name: g.name,
  memberIds: g.memberIds,
  createdAt: g.createdAt,
});

/**
 * Members archived or removed meanwhile leave every group they are in. Runs inside
 * the archiving transaction (TeamStore.archive), so no group names an archived member.
 */
export function leaveGroups(teams, memberIds) {
  const gone = new Set(memberIds);
  if (!gone.size) return;
  for (const g of teams.rows(groupKind))
    if (g.memberIds.some((id) => gone.has(id)))
      teams.write(g, { memberIds: g.memberIds.filter((id) => !gone.has(id)) });
}

export class MemberGroups {
  constructor(teams) {
    this.teams = teams;
  }
  records(leadId) {
    return this.teams.db
      .prepare(
        "SELECT body FROM assistant_team_records WHERE parent_id=? AND kind=? ORDER BY rowid",
      )
      .all(leadId, groupKind)
      .map((r) => JSON.parse(r.body));
  }
  /**
   * Only the owner's own leads group members: never a member, an archived agent or a
   * user's agent (which never leads a team, user-agent-lock.js).
   */
  assertLead(leadId) {
    const lead = this.teams.store.getAssistant(leadId);
    refuseUserAgent(lead);
    if (lead.teamMemberId || lead.archivedAt) throw assistantProblem("invalid", 403);
    return lead;
  }
  /** Whether `m` is a member of `leadId` that may be in a group right now. */
  groupable(leadId, m) {
    if (
      !m ||
      m.kind !== "member" ||
      m.parentAssistantId !== leadId ||
      m.lifetime !== "permanent" ||
      m.archivedAt
    )
      return false;
    try {
      return !this.teams.store.getAssistant(m.assistantId).archivedAt;
    } catch {
      return false;
    }
  }
  /** The lead's groups, oldest first, each naming only members that still belong. */
  list(leadId) {
    return this.records(leadId).map((g) => ({
      ...g,
      memberIds: g.memberIds.filter((id) => this.groupable(leadId, this.teams.find(id))),
    }));
  }
  /** Every lead's groups, for the browser's list. */
  all() {
    const leads = new Set(this.teams.rows(groupKind).map((g) => g.parentAssistantId));
    return [...leads].flatMap((id) => this.list(id)).map(publicGroup);
  }
  get(leadId, groupId) {
    const g = typeof groupId === "string" ? this.teams.find(groupId) : null;
    if (!g || g.kind !== groupKind || g.parentAssistantId !== leadId)
      throw assistantProblem("memberGroupNotFound", 404);
    return g;
  }
  /** The group a member is in, or null. */
  of(leadId, memberId) {
    return this.list(leadId).find((g) => g.memberIds.includes(memberId)) || null;
  }
  /** A usable, unique name (case does not count) of at most 60 characters. */
  name(leadId, name, exceptId = null) {
    const value = clean(name);
    if (!value || Array.from(value).length > groupLimits.name)
      throw assistantProblem("memberGroupName");
    const lower = value.toLocaleLowerCase();
    if (
      this.records(leadId).some(
        (g) => g.id !== exceptId && g.name.toLocaleLowerCase() === lower,
      )
    )
      throw assistantProblem("memberGroupNameTaken", 409);
    return value;
  }
  /** `operationKey`: a lead's tool call, so a retried call creates one group. */
  create(leadId, name, operationKey = null) {
    return this.teams.transaction(() => {
      if (operationKey) {
        const old = this.teams.db
          .prepare("SELECT id FROM assistant_team_records WHERE operation_key=?")
          .get(operationKey);
        if (old) {
          const existing = this.teams.find(old.id);
          if (existing?.kind !== groupKind || existing.name !== clean(name))
            throw assistantProblem("conflict", 409);
          return existing;
        }
      }
      this.assertLead(leadId);
      const value = this.name(leadId, name);
      if (this.records(leadId).length >= groupLimits.perLead)
        throw assistantProblem("memberGroupLimit", 409);
      return this.teams.insert(
        {
          id: randomUUID(),
          kind: groupKind,
          revision: 1,
          parentAssistantId: leadId,
          name: value,
          memberIds: [],
          createdAt: new Date().toISOString(),
        },
        operationKey,
      );
    });
  }
  rename(leadId, groupId, name) {
    return this.teams.transaction(() => {
      this.assertLead(leadId);
      const g = this.get(leadId, groupId);
      const value = this.name(leadId, name, g.id);
      return value === g.name ? g : this.teams.write(g, { name: value });
    });
  }
  /** Deletes the group; its members stay, ungrouped. Tasks already given run on. */
  remove(leadId, groupId) {
    return this.teams.transaction(() => {
      this.assertLead(leadId);
      const g = this.get(leadId, groupId);
      this.teams.db
        .prepare("DELETE FROM assistant_team_records WHERE id=? AND kind=?")
        .run(g.id, groupKind);
      return g;
    });
  }
  /**
   * Puts a permanent member into `groupId`, or with null takes it out of its group.
   * One transaction: it leaves its old group and joins the new one together, so
   * nobody ever sees it in two groups or briefly in none. A task it works on runs
   * on; the move only decides which later group tasks reach it.
   */
  move(leadId, memberId, groupId) {
    return this.teams.transaction(() => {
      this.assertLead(leadId);
      const m = typeof memberId === "string" ? this.teams.find(memberId) : null;
      if (!m || m.kind !== "member" || m.parentAssistantId !== leadId || m.archivedAt)
        throw assistantProblem("notFound", 404);
      if (!this.groupable(leadId, m))
        throw assistantProblem("memberGroupNotPermanent", 409);
      const target = groupId === null ? null : this.get(leadId, groupId);
      for (const g of this.records(leadId)) {
        const live = g.memberIds.filter(
          (id) => id !== m.id && this.groupable(leadId, this.teams.find(id)),
        );
        // Already there: it keeps its place.
        const next =
          g.id !== target?.id
            ? live
            : g.memberIds.includes(m.id)
              ? g.memberIds.filter((id) => id === m.id || live.includes(id))
              : [...live, m.id];
        if (next.join() !== g.memberIds.join()) this.teams.write(g, { memberIds: next });
      }
      return { memberId: m.id, groupId: target?.id ?? null };
    });
  }
}
