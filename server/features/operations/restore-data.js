import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { projectScope } from "../memory/project-scope.js";
import { atomic, readJson } from "./files.js";
import { problem } from "../../lib/storage.js";

export function database(file, fn, expectedVersion) {
  const db = new DatabaseSync(file);
  try {
    if (
      expectedVersion !== undefined &&
      db.prepare("PRAGMA user_version").get().user_version !== expectedVersion
    )
      throw problem("Unsupported embedded SQLite schema version.", 409);
    const checks = db.prepare("PRAGMA integrity_check").all();
    if (checks.length !== 1 || Object.values(checks[0])[0] !== "ok")
      throw problem("Backup database integrity check failed.");
    return fn(db);
  } finally {
    db.close();
  }
}
export function backupProjects(directory) {
  const file = path.join(directory, "memory/memory.sqlite");
  return fs.existsSync(file)
    ? database(file, (db) =>
        db.prepare("SELECT id,name,cwd,kind FROM projects ORDER BY id").all(),
      )
    : [];
}
export async function mapProjects(directory, projectMap = {}) {
  if (
    !projectMap ||
    typeof projectMap !== "object" ||
    Array.isArray(projectMap) ||
    Object.keys(projectMap).length > 1000
  )
    throw problem("Invalid project mapping.");
  const projects = backupProjects(directory),
    mappings = [],
    targets = new Set();
  for (const [oldId, cwd] of Object.entries(projectMap)) {
    const old = projects.find((project) => project.id === oldId);
    if (!old) throw problem("Project mapping references an unknown project.");
    const scope = await projectScope(cwd);
    if (
      targets.has(scope.id) ||
      projects.some(
        (p) => p.id === scope.id && p.id !== oldId && !Object.hasOwn(projectMap, p.id),
      )
    )
      throw problem("Project mappings collide.", 409);
    targets.add(scope.id);
    mappings.push({ from: oldId, to: scope.id, oldCwd: old.cwd, cwd: scope.cwd, scope });
  }
  if (projects.length)
    database(path.join(directory, "memory/memory.sqlite"), (db) => {
      db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
      try {
        db.exec("DELETE FROM capabilities");
        for (const m of mappings) {
          const temporary = `import-${m.from}`;
          for (const table of ["entries", "requests"])
            db.prepare(`UPDATE ${table} SET project_id=? WHERE project_id=?`).run(
              temporary,
              m.from,
            );
          db.prepare("UPDATE projects SET id=? WHERE id=?").run(temporary, m.from);
        }
        for (const m of mappings) {
          const temporary = `import-${m.from}`;
          for (const table of ["entries", "requests"])
            db.prepare(`UPDATE ${table} SET project_id=? WHERE project_id=?`).run(
              m.to,
              temporary,
            );
          db.prepare(
            "UPDATE projects SET id=?,name=?,cwd=?,kind=?,identity=? WHERE id=?",
          ).run(
            m.to,
            m.scope.name,
            m.scope.cwd,
            m.scope.kind,
            m.scope.identity,
            temporary,
          );
        }
        if (db.prepare("PRAGMA foreign_key_check").all().length)
          throw problem("Restored memory references are invalid.");
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  const definitionsFile = path.join(directory, "pipelines/definitions.json"),
    definitions = readJson(definitionsFile, null);
  if (definitions) {
    const verification = Object.create(null);
    for (const [id, steps] of Object.entries(definitions.verification || {}))
      verification[mappings.find((m) => m.from === id)?.to || id] = steps;
    definitions.verification = verification;
    atomic(definitionsFile, definitions);
  }
  const preferencesFile = path.join(directory, "preferences.json"),
    preferences = readJson(preferencesFile, null);
  if (preferences) {
    const mapped = mappings.find((m) => m.oldCwd === preferences.defaultCwd);
    atomic(preferencesFile, mapped ? { defaultCwd: mapped.cwd } : {});
  }
  const repositoriesFile = path.join(directory, "repositories.json"),
    repositories = readJson(repositoriesFile, null);
  if (repositories) {
    repositories.projects = (repositories.projects || []).map((project) => ({
      ...project,
      path: mappings.find((m) => m.oldCwd === project.path)?.cwd || project.path,
    }));
    atomic(repositoriesFile, repositories);
  }
  return mappings.map(({ scope: _scope, ...mapping }) => mapping);
}
export function historicalOnly(directory) {
  let importedSessions = 0,
    importedRuns = 0;
  const sessions = path.join(directory, "sessions");
  if (fs.existsSync(sessions))
    for (const name of fs.readdirSync(sessions)) {
      if (!/^[A-Za-z0-9_-]+\.json$/.test(name)) continue;
      const file = path.join(sessions, name),
        session = readJson(file);
      const originalStatus = session.status;
      session.status = "stopped";
      session.imported = {
        originalStatus,
        restoredAt: new Date().toISOString(),
        historyOnly: true,
      };
      for (const key of [
        "pid",
        "panePid",
        "exitCode",
        "nativeBinding",
        "memory",
        "agentbus",
        "requests",
        "nativeRequests",
      ])
        delete session[key];
      atomic(file, session);
      importedSessions++;
    }
  const runs = path.join(directory, "pipeline-runs/runs.sqlite");
  if (fs.existsSync(runs))
    database(runs, (db) => {
      for (const row of db.prepare("SELECT id,doc FROM runs").all()) {
        const run = JSON.parse(row.doc);
        run.imported = {
          originalStatus: run.status,
          restoredAt: new Date().toISOString(),
          historyOnly: true,
        };
        if (!["completed", "failed", "cancelled"].includes(run.status))
          run.status = "cancelled";
        run.finishedAt ||= new Date().toISOString();
        run.activeTurn = null;
        run.verifyJob = null;
        run.workspace = null;
        for (const key of [
          "pendingTurn",
          "pendingAdvance",
          "pendingConclusion",
          "cancelRequested",
          "usageResumeAt",
        ])
          delete run[key];
        run.phase = "imported";
        db.prepare("UPDATE runs SET revision=revision+1,doc=? WHERE id=?").run(
          JSON.stringify({ ...run, revision: run.revision + 1 }),
          row.id,
        );
        importedRuns++;
      }
    });
  return { importedSessions, importedRuns };
}
