import { createHash, randomUUID } from "node:crypto";
import { openDatabase, transaction } from "./memory-database.js";
import {
  failure,
  identifier,
  pageValue,
  textValue,
  record,
} from "./memory-validation.js";
import { projectScope } from "./project-scope.js";
const pageSize = 20;
const selection = `SELECT e.id,e.project_id,r.*, (SELECT created_at FROM revisions WHERE entry_id=e.id AND revision=1) AS original_created FROM entries e JOIN revisions r ON r.entry_id=e.id`;
function entry(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    content: row.content,
    revision: row.revision,
    archived: Boolean(row.archived),
    createdAt: row.original_created,
    updatedAt: row.created_at,
    provenance: JSON.parse(row.provenance),
  };
}
function source(value) {
  if (value?.kind === "user") return { kind: "user" };
  if (value?.kind === "session" && ["codex", "claude", "opencode"].includes(value.tool))
    return {
      kind: "session",
      sessionId: identifier(value.sessionId),
      accountId: identifier(value.accountId),
      tool: value.tool,
    };
  throw failure("Invalid memory provenance.");
}
export class ProjectMemory {
  constructor({ dataDir }) {
    Object.assign(this, openDatabase(dataDir));
    this.closed = false;
  }
  async register(cwd) {
    const scope = await projectScope(cwd);
    this.db
      .prepare("INSERT OR IGNORE INTO projects VALUES (?,?,?,?,?,?)")
      .run(
        scope.id,
        scope.name,
        scope.cwd,
        scope.kind,
        scope.identity,
        new Date().toISOString(),
      );
    return this.project(scope.id);
  }
  project(id) {
    identifier(id);
    const row = this.db
      .prepare("SELECT id,name,cwd,kind,created_at AS createdAt FROM projects WHERE id=?")
      .get(id);
    if (!row) throw failure("Memory project not found.", 404);
    return { ...row };
  }
  projects() {
    return {
      projects: this.db
        .prepare(
          `SELECT p.id,p.name,p.cwd,p.kind,p.created_at AS createdAt, (SELECT COUNT(*) FROM entries e JOIN revisions r ON r.entry_id=e.id AND r.revision=e.revision WHERE e.project_id=p.id AND r.archived=0) AS entryCount FROM projects p ORDER BY p.name COLLATE NOCASE,p.id`,
        )
        .all()
        .map((row) => ({ ...row })),
    };
  }
  list(projectId, { query = "", page = 1, archived = false } = {}) {
    this.project(projectId);
    pageValue(page);
    textValue(query, "query", 300, { empty: true });
    if (typeof archived !== "boolean") throw failure("Invalid memory archive filter.");
    const pattern = query
      .replaceAll("\\", "\\\\")
      .replaceAll("%", "\\%")
      .replaceAll("_", "\\_");
    const where = `e.project_id=? AND r.revision=e.revision AND r.archived=? AND (r.title LIKE ? ESCAPE '\\' OR r.content LIKE ? ESCAPE '\\')`;
    const args = [projectId, Number(archived), `%${pattern}%`, `%${pattern}%`];
    const total = this.db
      .prepare(
        `SELECT COUNT(*) AS total FROM entries e JOIN revisions r ON r.entry_id=e.id WHERE ${where}`,
      )
      .get(...args).total;
    const items = this.db
      .prepare(
        `${selection} WHERE ${where} ORDER BY r.created_at DESC,e.id LIMIT ? OFFSET ?`,
      )
      .all(...args, pageSize, (page - 1) * pageSize)
      .map(entry);
    return { projectId, items, page, pageSize, total };
  }
  read(projectId, id, { revision } = {}) {
    this.project(projectId);
    identifier(id);
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1))
      throw failure("Invalid memory revision.");
    const row = this.db
      .prepare(
        `${selection} WHERE e.project_id=? AND e.id=? AND r.revision=${revision === undefined ? "e.revision" : "?"}`,
      )
      .get(projectId, id, ...(revision === undefined ? [] : [revision]));
    if (!row) throw failure("Memory entry not found.", 404);
    return entry(row);
  }
  revisions(projectId, id, { page = 1 } = {}) {
    this.read(projectId, id);
    pageValue(page);
    const total = this.db
      .prepare("SELECT COUNT(*) AS total FROM revisions WHERE entry_id=?")
      .get(id).total;
    return {
      projectId,
      page,
      pageSize,
      total,
      items: this.db
        .prepare(
          `${selection} WHERE e.project_id=? AND e.id=? ORDER BY r.revision DESC LIMIT ? OFFSET ?`,
        )
        .all(projectId, id, pageSize, (page - 1) * pageSize)
        .map(entry),
    };
  }
  write(projectId, input, provenance = { kind: "user" }) {
    record(input);
    this.project(projectId);
    const title = textValue(input.title, "title", 200).trim(),
      content = textValue(input.content, "content", 32768),
      author = source(provenance);
    const id = input.id === undefined ? null : identifier(input.id);
    const expected = input.expectedRevision;
    if (id && (!Number.isSafeInteger(expected) || expected < 1))
      throw failure("An expected revision is required.");
    if (!id && expected !== undefined)
      throw failure("New memory entries cannot have an expected revision.");
    const requestId = input.requestId === undefined ? null : identifier(input.requestId);
    const hash = createHash("sha256")
      .update(JSON.stringify({ id, title, content, expected }))
      .digest("hex");
    const actor = author.sessionId || "user";
    return transaction(this.db, () => {
      if (requestId) {
        const prior = this.db
          .prepare(
            "SELECT * FROM requests WHERE project_id=? AND actor=? AND request_id=?",
          )
          .get(projectId, actor, requestId);
        if (prior) {
          if (prior.hash !== hash)
            throw failure("Memory request identifier was already used.", 409);
          return this.read(projectId, prior.entry_id, { revision: prior.revision });
        }
      }
      const current = id ? this.read(projectId, id) : null;
      if (current && (current.revision !== expected || current.archived))
        throw failure("Memory changed. Reload before saving.", 409);
      const entryId = id || randomUUID(),
        revision = (current?.revision || 0) + 1;
      if (!id)
        this.db
          .prepare("INSERT INTO entries VALUES (?,?,?)")
          .run(entryId, projectId, revision);
      this.db
        .prepare("INSERT INTO revisions VALUES (?,?,?,?,?,?,?)")
        .run(
          entryId,
          revision,
          title,
          content,
          0,
          new Date().toISOString(),
          JSON.stringify(author),
        );
      this.db.prepare("UPDATE entries SET revision=? WHERE id=?").run(revision, entryId);
      if (requestId)
        this.db
          .prepare("INSERT INTO requests VALUES (?,?,?,?,?,?)")
          .run(projectId, actor, requestId, hash, entryId, revision);
      return this.read(projectId, entryId);
    });
  }
  archive(
    projectId,
    id,
    { expectedRevision, archived = true } = {},
    provenance = { kind: "user" },
  ) {
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 1 ||
      typeof archived !== "boolean"
    )
      throw failure("An expected revision and valid archive state are required.");
    const author = source(provenance);
    return transaction(this.db, () => {
      const current = this.read(projectId, id);
      if (current.revision !== expectedRevision)
        throw failure("Memory changed. Reload before saving.", 409);
      const revision = current.revision + 1;
      this.db
        .prepare("INSERT INTO revisions VALUES (?,?,?,?,?,?,?)")
        .run(
          id,
          revision,
          current.title,
          current.content,
          Number(archived),
          new Date().toISOString(),
          JSON.stringify(author),
        );
      this.db.prepare("UPDATE entries SET revision=? WHERE id=?").run(revision, id);
      return this.read(projectId, id);
    });
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}
