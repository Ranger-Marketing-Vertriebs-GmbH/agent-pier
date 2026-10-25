import test from "node:test";
import assert from "node:assert/strict";
import { ProjectRebind } from "../../server/application/project-rebind.js";

const scope = { id: "TO", name: "p", cwd: "/p", kind: "git", identity: "i" };

function fixture(record) {
  const saved = [];
  let refreshes = 0;
  const rebind = new ProjectRebind({
    dataDir: "/nonexistent",
    memory: {},
    sshManagement: {},
    sessionSecrets: {
      refresh: async () => {
        refreshes++;
      },
    },
    artifacts: {},
    sessions: {
      metadata: async () => structuredClone(record),
      save: async (session) => saved.push(session),
    },
    audit: {},
  });
  return { rebind, saved, refreshes: () => refreshes };
}

test("a session whose secrets binding moves refreshes the secrets files", async () => {
  const f = fixture({ id: "s", secrets: { projectId: "FROM", assignedIds: [] } });
  await f.rebind.rebindSession("s", "FROM", scope, null);
  assert.equal(f.saved[0].secrets.projectId, "TO");
  assert.equal(f.refreshes(), 1);
});

test("a session of another project is left alone and refreshes nothing", async () => {
  const f = fixture({ id: "s", secrets: { projectId: "OTHER", assignedIds: [] } });
  await f.rebind.rebindSession("s", "FROM", scope, null);
  assert.equal(f.saved.length, 0);
  assert.equal(f.refreshes(), 0);
});
