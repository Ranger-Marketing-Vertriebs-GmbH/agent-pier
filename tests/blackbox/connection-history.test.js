import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture } from "../helpers/application.js";

// Zugänge sorts by "Zuletzt geändert" and links "Im Aktivitätsprotokoll" to one entry:
// SSH hosts keep the time of their last edit, MCP servers report their newest create
// or edit from the audit, and the audit filters by resource.

const json = async (f, path) => {
  const response = await f.request(path);
  assert.equal(response.status, 200, path);
  return response.json();
};

test("an edited SSH host carries its edit time; its creation time stays", async (t) => {
  const f = await applicationFixture(t);
  const ssh = f.application.sshManagement;
  const key = await ssh.ui("createKey", { name: "lab key" });
  const host = await ssh.ui("createHost", {
    name: "lab",
    host: "lab.invalid",
    port: 22,
    username: "deploy",
    keyId: key.id,
    hostKey: key.publicKey,
  });
  const listed = async () =>
    (await json(f, "/api/ssh-accesses")).accesses.find((a) => a.id === host.id);
  const before = await listed();
  assert.equal(before.updatedAt, undefined);
  const renamed = await f.request(`/api/ssh-accesses/${host.id}`, {
    method: "PATCH",
    body: { name: "lab-renamed" },
  });
  assert.equal(renamed.status, 200);
  const after = await listed();
  assert.equal(after.createdAt, before.createdAt);
  assert.match(after.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(Date.parse(after.updatedAt) >= Date.parse(before.createdAt));
  // The edit answer carries the same time.
  assert.equal((await renamed.json()).updatedAt, after.updatedAt);
});

test("the audit filters by resource and MCP servers report their last change", async (t) => {
  const f = await applicationFixture(t);
  const create = async (name) =>
    (
      await f.request("/api/mcp-servers", {
        method: "POST",
        body: { name, transport: "http", url: `https://${name}.example.com/mcp` },
      })
    ).json();
  const docs = await create("docs");
  const wiki = await create("wiki");
  const filtered = await json(f, `/api/audit?resourceId=${docs.id}`);
  assert.ok(filtered.events.length >= 1);
  assert.ok(filtered.events.every((event) => event.resourceId === docs.id));
  assert.equal(filtered.total, filtered.events.length);
  assert.equal((await f.request("/api/audit?resourceId=..%2Fbad")).status, 400);
  const usage = await json(f, "/api/connections/usage");
  const created = filtered.events.find((event) => event.action === "mcp.created");
  assert.equal(usage.mcp[docs.id].changedAt, created.createdAt);
  assert.match(usage.mcp[wiki.id].changedAt, /^\d{4}-\d{2}-\d{2}T/);
});
