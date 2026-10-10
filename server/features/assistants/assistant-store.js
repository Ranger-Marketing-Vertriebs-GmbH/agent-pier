import path from "node:path";
import { memberInstructions } from "./team-presentation.js";
import { randomUUID } from "node:crypto";
import { privateDatabase } from "../../lib/private-database.js";
import { fencedDatabase } from "./ledger-fence.js";
import { migrateAssistants } from "./assistant-schema.js";
import { validateDefinition, assistantProblem } from "./assistant-validation.js";

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
  getAssistant(id) {
    const row = this.db.prepare("SELECT body FROM assistants WHERE id=?").get(id);
    if (!row) throw assistantProblem("notFound", 404);
    return JSON.parse(row.body);
  }
  listAssistants() {
    return this.db
      .prepare("SELECT body FROM assistants ORDER BY rowid")
      .all()
      .map((r) => JSON.parse(r.body));
  }
  updateAssistant(id, patch, revision) {
    const changes = validateDefinition(patch, true),
      current = this.getAssistant(id);
    if (!Number.isSafeInteger(revision) || current.revision !== revision)
      throw assistantProblem("conflict", 409);
    const { confirmInstructions, ...fields } = changes;
    const result = { ...current, ...fields, revision: revision + 1 };
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
  cacheMessages(id, messages) {
    this.getConversation(id);
    this.db
      .prepare(
        "INSERT INTO messages VALUES (?,?) ON CONFLICT(conversation_id) DO UPDATE SET body=excluded.body",
      )
      .run(id, JSON.stringify(messages));
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
