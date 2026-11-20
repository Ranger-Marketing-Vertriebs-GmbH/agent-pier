import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A real temp folder with the stores the deletion scope and preflight read, faked in
 * memory (tests/unit/project-deletion-preflight*.test.js).
 */
export function preflightFixture(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-preflight-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "work", "app");
  fs.mkdirSync(app, { recursive: true });
  const dataDir = path.join(root, "data");
  fs.mkdirSync(path.join(dataDir, "sessions"), { recursive: true });
  const rows = [],
    repositories = [],
    runs = new Map(),
    queue = new Map(),
    rebuilds = new Map(),
    live = new Map();
  const services = {
    config: { dataDir, home: path.join(root, "home") },
    memory: { projects: () => ({ projects: rows.map((row) => ({ ...row })) }) },
    repositories: { listProjects: () => repositories.map((item) => ({ ...item })) },
    agentbus: { root: path.join(dataDir, "agentbus") },
    sessions: {
      get: async (id) => {
        if (!live.has(id)) throw Object.assign(new Error("gone"), { status: 404 });
        return live.get(id);
      },
    },
    pipelines: {
      store: {
        all: () => [...runs.values()],
        get: (id) => {
          if (!runs.has(id)) throw Object.assign(new Error("gone"), { status: 404 });
          return runs.get(id);
        },
      },
    },
    pipelineQueue: { store: { list: (projectId) => queue.get(projectId) ?? [] } },
    craftRebuilds: {
      list: () => [...rebuilds.values()],
      get: (id) => rebuilds.get(id) ?? null,
    },
  };
  const session = (id, data, state = { status: "stopped" }) => {
    fs.writeFileSync(
      path.join(dataDir, "sessions", `${id}.json`),
      JSON.stringify({ id, name: `Session ${id}`, tool: "codex", ...data }),
    );
    live.set(id, { id, name: `Session ${id}`, tool: "codex", ...data, ...state });
  };
  const row = (id, cwd, extra = {}) =>
    rows.push({
      id,
      name: path.basename(cwd),
      cwd,
      kind: "git",
      createdAt: "2026-01-01",
      ...extra,
    });
  return {
    root,
    app,
    dataDir,
    services,
    rows,
    repositories,
    runs,
    queue,
    rebuilds,
    session,
    row,
  };
}
