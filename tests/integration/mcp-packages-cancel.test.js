import test from "node:test";
import assert from "node:assert/strict";
import {
  createPackaged,
  installsOf,
  packageService,
} from "../helpers/mcp-packages-service.js";

test("deleting a server during its install stops npm and leaves no stage", async (t) => {
  const s = await packageService(t);
  const held = s.hold();
  const { server } = await createPackaged(s);
  await held.reached;
  await s.changes.remove(server.id);
  const cancelled = s.packages.cancel(server.id);
  held.release();
  assert.equal(await cancelled, true);
  const job = s.packages.jobs.get(server.id);
  assert.equal(job.state, "cancelled");
  assert.equal(job.code, "MCP_PACKAGE_CANCELLED");
  await s.packages.prune();
  assert.deepEqual(installsOf(s.dataDir), []);
  assert.equal(s.servers.packages.get(server.id), null);
});
