import path from "node:path";
import { effectiveModel, memberInstructions } from "./team-presentation.js";
import { randomUUID } from "node:crypto";
import { privateDatabase } from "../../lib/private-database.js";
import { fencedDatabase } from "./ledger-fence.js";
import { migrateAssistants } from "./assistant-schema.js";
import { personalEligible } from "./native-capabilities.js";
import { validateDefinition, assistantProblem } from "./assistant-validation.js";

// The message cache keeps a conversation's newest messages only. A history page holds
// at most 100 messages; the chat's poll and every server-side reader ask for the
// newest page, and three pages leave room to scroll back while the Gateway is away.
// Beyond the newest page, which stays whole, the oldest leave once the texts exceed
// about 4 MB, so a conversation of huge turns cannot grow the cache past it.
export const cachedMessageLimit = 300;
export const cachedTextLimit = 4 * 1024 * 1024;
const newestPage = 100;
const textLength = (m) => (typeof m.text === "string" ? m.text.length : 0);
/** The part of sorted `messages` the cache keeps: the newest, within both bounds. */
export function cachedWindow(messages) {
  const kept = messages.slice(-cachedMessageLimit);
  let total = kept.reduce((sum, m) => sum + textLength(m), 0),
    start = 0;
  while (total > cachedTextLimit && kept.length - start > newestPage)
    total -= textLength(kept[start++]);
  return start ? kept.slice(start) : kept;
}
export class AssistantStore {
  constructor({ dataDir }) {
    const root = path.join(dataDir, "assistants");
    this.db = fencedDatabase(
      privateDatabase(root, "assistants.sqlite"),
      root,
      "assistants.sqlite",
    );
    migrateAssistants(this.db);
  }
  createAssistant(input) {
    const values = validateDefinition(input),
      id = randomUUID();
    const record = {
      id,
      ...values,
      revision: 1,
      effectiveRevision: 0,
      runtimeAgentId: `ap-${id}`,
      archivedAt: null,
    };
    this.db
      .prepare("INSERT INTO assistants VALUES (?,?,?)")
      .run(id, 1, JSON.stringify(record));
    return record;
  }
  reserveMember({ id, parent, assignment, snapshot, teamId, lifetime }) {
    this.getAssistant(parent);
    const record = {
      id,
      name: assignment.name,
      instructions: memberInstructions(snapshot, assignment),
      model: { ...snapshot.model },
      revision: 1,
      effectiveRevision: 0,
      runtimeAgentId: `ap-${id}`,
      archivedAt: null,
      teamMemberId: id,
      teamId,
      parentAssistantId: parent,
      lifetime,
      serviceGrants: [],
    };
    this.db
      .prepare("INSERT INTO assistants VALUES (?,?,?)")
      .run(id, 1, JSON.stringify(record));
    return record;
  }
  /**
   * The stored record, without resolving a temporary member's model: a task member's
   * stored model is only the one it last held when written (at creation or a later
   * write), not the one it runs on. Reads (getAssistant, listAssistants) resolve the
   * effective model.
   */
  storedAssistant(id) {
    const row = this.db.prepare("SELECT body FROM assistants WHERE id=?").get(id);
    if (!row) throw assistantProblem("notFound", 404);
    return JSON.parse(row.body);
  }
  /**
   * Every read carries the model the agent runs on (effectiveModel): a temporary
   * member's is its lead's current one, so runtime config, capability checks and
   * the agents list all follow a change to the lead without copying it.
   */
  getAssistant(id) {
    const record = this.storedAssistant(id);
    if (!record.teamMemberId) return record;
    let lead;
    try {
      lead = this.storedAssistant(record.parentAssistantId);
    } catch {
      /* No readable lead: the member keeps its own model. */
    }
    return { ...record, model: effectiveModel(record, lead) };
  }
  listAssistants() {
    const records = this.db
      .prepare("SELECT body FROM assistants ORDER BY rowid")
      .all()
      .map((r) => JSON.parse(r.body));
    const byId = new Map(records.map((r) => [r.id, r]));
    return records.map((r) =>
      r.teamMemberId
        ? { ...r, model: effectiveModel(r, byId.get(r.parentAssistantId)) }
        : r,
    );
  }
  updateAssistant(id, patch, revision) {
    const changes = validateDefinition(patch, true),
      current = this.getAssistant(id);
    if (!Number.isSafeInteger(revision) || current.revision !== revision)
      throw assistantProblem("conflict", 409);
    const { confirmInstructions, ...fields } = changes;
    // Only eligible profiles can hold a shell level; a PATCH without it keeps the stored one.
    // An ineligible profile may only restate "off", which changes nothing.
    if ("shell" in fields && !personalEligible(current)) {
      if (fields.shell !== "off") throw assistantProblem("invalid");
      delete fields.shell;
    }
    // Likewise skills: an ineligible profile may only restate an empty list.
    if ("skills" in fields && !personalEligible(current)) {
      if (fields.skills.length) throw assistantProblem("invalid");
      delete fields.skills;
    }
    const result = { ...current, ...fields, revision: revision + 1 };
    // Older clients send only the original keys; keep stored newer capabilities.
    if (fields.capabilities)
      result.capabilities = { ...current.capabilities, ...fields.capabilities };
    // Model-written instructions stay flagged until the owner rewrites or confirms them.
    if (
      current.instructionsSource &&
      (confirmInstructions ||
        ("instructions" in fields && fields.instructions !== current.instructions))
    )
      result.instructionsSource = "owner";
    if (
      !this.db
        .prepare("UPDATE assistants SET body=?,revision=? WHERE id=? AND revision=?")
        .run(JSON.stringify(result), result.revision, id, revision).changes
    )
      throw assistantProblem("conflict", 409);
    return result;
  }
  markEffective(id, revision) {
    const current = this.getAssistant(id);
    if (current.revision !== revision) throw assistantProblem("conflict", 409);
    current.effectiveRevision = revision;
    this.db
      .prepare("UPDATE assistants SET body=? WHERE id=? AND revision=?")
      .run(JSON.stringify(current), id, revision);
    return current;
  }
  saveConversation(input) {
    this.getAssistant(input.assistantId);
    const found = this.db
      .prepare("SELECT body FROM conversations WHERE session_key=?")
      .get(input.runtimeSessionKey);
    if (found) {
      const record = JSON.parse(found.body);
      if (record.assistantId !== input.assistantId)
        throw assistantProblem("conflict", 409);
      return record;
    }
    const record = {
      id: randomUUID(),
      assistantId: input.assistantId,
      runtimeSessionKey: input.runtimeSessionKey,
      channel: input.channel || "agentpier",
      createdAt: new Date().toISOString(),
      archivedAt: null,
    };
    this.db
      .prepare("INSERT INTO conversations VALUES (?,?,?,?)")
      .run(
        record.id,
        record.assistantId,
        record.runtimeSessionKey,
        JSON.stringify(record),
      );
    return record;
  }
  getConversation(id) {
    const row = this.db.prepare("SELECT body FROM conversations WHERE id=?").get(id);
    if (!row) throw assistantProblem("notFound", 404);
    return JSON.parse(row.body);
  }
  listConversations() {
    return this.db
      .prepare("SELECT body FROM conversations ORDER BY rowid")
      .all()
      .map((r) => JSON.parse(r.body));
  }
  /** Replaces the cache with the `cachedWindow` of `messages` (sorted). */
  cacheMessages(id, messages) {
    this.getConversation(id);
    this.db
      .prepare(
        "INSERT INTO messages VALUES (?,?) ON CONFLICT(conversation_id) DO UPDATE SET body=excluded.body",
      )
      .run(id, JSON.stringify(cachedWindow(messages)));
  }
  messages(id) {
    this.getConversation(id);
    return JSON.parse(
      this.db.prepare("SELECT body FROM messages WHERE conversation_id=?").get(id)
        ?.body || "[]",
    );
  }
  close() {
    this.db.close();
  }
}
