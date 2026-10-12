import { assistantProblem } from "./assistant-validation.js";
import { staleHash } from "./exec-decisions.js";
import { allowAlwaysGroup, groupOf } from "./exec-allowlist-links.js";
import { personalEligible } from "./native-capabilities.js";

const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value, max) =>
  typeof value === "string" ? value.slice(0, max) : undefined;
// One write per delete; a run in between changes the base hash, so one retry.
const removeAttempts = 2;
const auditable = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;

const companion = (entry) => entry.pattern.startsWith("=");

/**
 * An allowlist entry as the owner sees it. OpenClaw's allow-always entries carry
 * `source: "allow-always"`; AgentPier's own program entries carry none. OpenClaw
 * drops command text, so `origin` (the exec action that led to the entry) gives
 * it where AgentPier knows it. An `=`-pattern is OpenClaw's command companion of
 * a path entry, not a program (exec-allowlist-links.js).
 */
function present(entry, origin, ours, companions = []) {
  const argPattern = text(entry.argPattern, 300);
  const lastUsedCommand = text(entry.lastUsedCommand, 4096);
  return {
    id: entry.id,
    pattern: entry.pattern.slice(0, 4096),
    ...(argPattern ? { argPattern } : {}),
    source: entry.source === "allow-always" ? "openclaw" : ours ? "agentpier" : "other",
    kind: companion(entry) ? "command" : "program",
    ...(Number.isSafeInteger(entry.lastUsedAt) ? { lastUsedAt: entry.lastUsedAt } : {}),
    ...(lastUsedCommand ? { lastUsedCommand } : {}),
    ...(origin
      ? {
          command: origin.command,
          ...(origin.cwd ? { cwd: origin.cwd } : {}),
          requestedAt: origin.requestedAt,
        }
      : {}),
    ...(companions.length ? { companions } : {}),
  };
}

/**
 * The agent's exec allowlist in the Gateway (`exec.approvals.get/set`, keyed by its
 * runtime agent id). Eligible agents only: temporary members never get shell.
 */
export class ExecAllowlist {
  constructor(assistants) {
    this.a = assistants;
  }
  profile(id) {
    const profile = this.a.store.getAssistant(id);
    if (!personalEligible(profile)) throw assistantProblem("invalid");
    return profile;
  }
  client() {
    const client = this.a.runtime.client;
    if (this.a.closed || !client?.ready) throw assistantProblem("unavailable", 503);
    return client;
  }
  async read(client) {
    try {
      return await client.call("exec.approvals.get", {});
    } catch {
      throw assistantProblem("unavailable", 503);
    }
  }
  /**
   * From the agent's exec actions: AgentPier's own entries by id, and the groups
   * of entries OpenClaw wrote for an allow-always it answered itself.
   */
  history(id) {
    const known = new Map(),
      groups = [];
    for (const action of this.a.workflows?.store?.list(id) || []) {
      const group = allowAlwaysGroup(action);
      if (group) groups.push(group);
      const allowlist = action.result?.allowlist;
      if (action.payload?.action !== "exec" || !allowlist?.written) continue;
      for (const entry of allowlist.entries || [])
        known.set(entry.entryId, {
          command: action.payload.command,
          cwd: action.payload.cwd,
          requestedAt: action.createdAt,
        });
    }
    return { known, groups };
  }
  /** Each valid entry with the action group it belongs to, if AgentPier knows it. */
  linked(profile, list) {
    const { known, groups } = this.history(profile.id);
    return (Array.isArray(list) ? list : [])
      .filter(
        (e) => record(e) && typeof e.id === "string" && typeof e.pattern === "string",
      )
      .map((entry) => ({
        entry,
        ours: known.get(entry.id),
        group: known.has(entry.id) ? undefined : groupOf(entry, groups),
      }));
  }
  /**
   * The entries as listed: a companion whose path entry is listed folds into it
   * (`companions`); one AgentPier cannot place stays visible, so it can be removed.
   */
  entries(profile, file) {
    const linked = this.linked(
      profile,
      file?.agents?.[profile.runtimeAgentId]?.allowlist,
    );
    const companionsOf = (group) =>
      group
        ? linked
            .filter((l) => l.group === group && companion(l.entry))
            .map((l) => l.entry.id)
        : [];
    const hasPath = (group) =>
      linked.some((l) => l.group === group && !companion(l.entry));
    return linked
      .filter((l) => !(companion(l.entry) && l.group && hasPath(l.group)))
      .map((l) =>
        present(
          l.entry,
          l.ours || l.group,
          !!l.ours,
          companion(l.entry) ? [] : companionsOf(l.group),
        ),
      );
  }
  async list(id) {
    const profile = this.profile(id);
    const current = await this.read(this.client());
    return { entries: this.entries(profile, current?.file) };
  }
  /**
   * Deletes one entry, and with a path entry its OpenClaw companions: reads,
   * filters by id and writes at once with the base hash. The next matching command
   * asks again. A stale hash is retried once, then 409.
   */
  remove(id, entryId) {
    return this.a.admit(async () => {
      const profile = this.profile(id);
      const client = this.client();
      for (let attempt = 0; attempt < removeAttempts; attempt++) {
        const current = await this.read(client);
        const file = record(current?.file) ? current.file : {};
        const agent = record(file.agents?.[profile.runtimeAgentId])
          ? file.agents[profile.runtimeAgentId]
          : {};
        const list = Array.isArray(agent.allowlist) ? agent.allowlist : [];
        if (typeof entryId !== "string" || !list.some((e) => e?.id === entryId))
          throw assistantProblem("allowlistEntryNotFound", 404);
        const linked = this.linked(profile, list);
        const target = linked.find((l) => l.entry.id === entryId);
        const companions =
          target && !companion(target.entry) && target.group
            ? linked
                .filter((l) => l.group === target.group && companion(l.entry))
                .map((l) => l.entry.id)
            : [];
        const removed = new Set([entryId, ...companions]);
        const next = {
          ...file,
          agents: {
            ...file.agents,
            [profile.runtimeAgentId]: {
              ...agent,
              allowlist: list.filter((e) => !removed.has(e?.id)),
            },
          },
        };
        try {
          await client.call("exec.approvals.set", { baseHash: current.hash, file: next });
        } catch (error) {
          if (staleHash(error)) continue;
          throw assistantProblem("unavailable", 503);
        }
        this.audit(id, entryId, companions.length);
        this.a.changed();
        return { removed: entryId, companions, entries: this.entries(profile, next) };
      }
      throw assistantProblem("conflict", 409);
    });
  }
  audit(id, entryId, companions) {
    try {
      this.a.audit?.append({
        action: "assistant.revoked",
        resourceType: "assistant",
        resourceId: id,
        source: "user",
        outcome: "success",
        // Only a well-formed id reaches the audit log; the entry may be foreign.
        details: {
          kind: "allowlist",
          ...(auditable.test(entryId) ? { entryId } : {}),
          ...(companions ? { count: companions } : {}),
        },
      });
    } catch (error) {
      console.error("Assistant allowlist audit failed:", error?.message);
    }
  }
}
