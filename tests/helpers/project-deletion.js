import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectMemory } from "../../server/features/memory/project-memory.js";
import { purgeProjects } from "../../server/features/memory/project-deletions.js";
import { auditEvent } from "../../server/features/audit/audit-schema.js";
import { ProjectDeletion } from "../../server/application/project-deletion.js";

export const noGit = async () => ({
  status: "none",
  worktrees: [],
  unpushedBranches: null,
  worktreesChecked: true,
});
export const owner = { role: "owner" };

/**
 * A real temp folder registered in a real ProjectMemory; the other stores are fakes.
 * The data walk is faked too: it records its call and purges the memory rows.
 */
export async function setup(
  t,
  { git = noGit, processes = [], dataLeft = () => [], beforeData = async () => {} } = {},
) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-deletion-")),
  );
  t.after(() => {
    fs.chmodSync(root, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const dataDir = path.join(root, "data");
  fs.mkdirSync(path.join(dataDir, "sessions"), { recursive: true });
  const app = path.join(root, "work", "app");
  fs.mkdirSync(path.join(app, "src"), { recursive: true });
  fs.writeFileSync(path.join(app, "src", "index.js"), "x");
  const memory = new ProjectMemory({ dataDir });
  t.after(() => memory.close());
  const project = await memory.register(app);
  const calls = [],
    live = new Map(),
    audits = [],
    runs = new Map();
  const services = {
    config: { dataDir, home: path.join(root, "home") },
    memory,
    repositories: { listProjects: () => [] },
    agentbus: { root: path.join(dataDir, "agentbus") },
    sessions: {
      get: async (id) => {
        if (!live.has(id)) throw Object.assign(new Error("gone"), { status: 404 });
        return live.get(id);
      },
      stop: async (id) => {
        calls.push(`stop:${id}`);
        live.get(id).status = "stopped";
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
      cancel: async (id) => {
        calls.push(`cancel:${id}`);
        runs.get(id).status = "cancelled";
      },
    },
    assistantWorkflows: {
      revokeProject: (id) => calls.push(`revoke:${id}`),
      sessions: { store: { get: () => null } },
    },
    audit: { append: (input) => audits.push(auditEvent(input)) },
    live: { invalidate: (name) => calls.push(`signal:${name}`) },
  };
  const scan = async () => ({ status: "ok", processes });
  const ended = [];
  const deletion = new ProjectDeletion(services, {
    probes: {
      scan,
      git,
      processContext: async () => ({}),
      classify: (found) => found,
    },
    removeData: async (_services, body, folder) => {
      await beforeData();
      calls.push(`data:${folder}`);
      assert.equal(fs.existsSync(folder) && !body.folderMissing, false);
      purgeProjects(memory, body.projectIds);
    },
    dataLeft: (...args) => dataLeft(...args),
    end: async (item) => {
      ended.push(item.pid);
      return "ended";
    },
  });
  const session = (id, data = {}, status = "running") => {
    fs.writeFileSync(
      path.join(dataDir, "sessions", `${id}.json`),
      JSON.stringify({ id, cwd: app, ...data }),
    );
    live.set(id, { id, name: `Session ${id}`, tool: "codex", status });
  };
  return {
    root,
    app,
    id: project.id,
    memory,
    services,
    deletion,
    calls,
    audits,
    ended,
    runs,
    session,
  };
}

export const quietLog = (t) => t.mock.method(console, "error", () => {});
