import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { applicationFixture } from "../helpers/application.js";
import { signedInUser } from "../helpers/users.js";

const DAY = 24 * 60 * 60 * 1000;
function write(file, days = 0) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(8192, 1));
  const time = new Date(Date.now() - days * DAY);
  fs.utimesSync(file, time, time);
}

test("cleanup routes list, delete, audit without paths and stay owner-only", async (t) => {
  const f = await applicationFixture(t, { storageCleanup: { cwds: async () => [] } });
  const account = f.application.accounts.create({ name: "Work", tool: "claude" });
  const project = path.join(f.dataDir, "profiles", account.id, "claude", "projects", "p");
  const old = randomUUID();
  write(path.join(project, `${old}.jsonl`), 120);
  const backup = randomUUID();
  write(path.join(f.dataDir, "assistants", "backups", backup, "payload", "a.bin"));
  fs.writeFileSync(
    path.join(f.dataDir, "assistants", "backups", backup, "committed"),
    "x",
  );
  const workspace = path.join(f.dataDir, "assistants", "workspaces", "agent-1");
  write(path.join(workspace, "node_modules", "pkg", "index.js"));

  const json = async (endpoint, options) => {
    const response = await f.request(endpoint, options);
    const body = await response.json();
    for (const secret of [f.root, f.dataDir, os.homedir()])
      assert.ok(!JSON.stringify(body).includes(secret), `no path in ${endpoint}`);
    return { status: response.status, body };
  };
  const base = "/api/system-status/cleanup";
  const backups = await json(`${base}/update-backups`);
  assert.equal(backups.status, 200);
  assert.equal(backups.body.snapshots[0].id, backup);
  const transcripts = await json(`${base}/transcripts`);
  const profile = transcripts.body.profiles.find((p) => p.id === account.id);
  assert.equal(profile.name, "Work");
  assert.deepEqual(
    profile.cutoffs.map((c) => c.count),
    [1, 1, 0],
  );
  const dependencies = await json(`${base}/dependencies`);
  assert.equal(dependencies.body.agents[0].id, "agent-1");
  assert.equal(dependencies.body.agents[0].folders, 1);

  const user = await signedInUser(f);
  const refused = await f.request(`${base}/update-backups/${backup}`, {
    method: "DELETE",
    headers: { cookie: user.cookie },
  });
  assert.ok([403, 404].includes(refused.status), `a user gets ${refused.status}`);
  assert.ok(fs.existsSync(path.join(f.dataDir, "assistants", "backups", backup)));

  assert.equal(
    (
      await json(`${base}/transcripts/${account.id}`, {
        method: "POST",
        body: { olderThanDays: 7 },
      })
    ).status,
    400,
  );
  const deleted = await json(`${base}/transcripts/${account.id}`, {
    method: "POST",
    body: { olderThanDays: 90 },
  });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.removed, 1);
  assert.ok(!fs.existsSync(path.join(project, `${old}.jsonl`)));
  assert.equal(
    (await json(`${base}/update-backups/${backup}`, { method: "DELETE" })).status,
    200,
  );
  assert.ok(!fs.existsSync(path.join(f.dataDir, "assistants", "backups", backup)));
  const removed = await json(`${base}/dependencies/agent-1`, { method: "DELETE" });
  assert.equal(removed.body.removed, 1);
  assert.ok(!fs.existsSync(path.join(workspace, "node_modules")));

  const audit = await json("/api/audit?action=storage.deleted");
  const events = audit.body.events;
  assert.equal(events.length, 3);
  const areas = Object.fromEntries(events.map((e) => [e.details.area, e]));
  assert.equal(areas.transcripts.resourceId, account.id);
  assert.equal(areas.transcripts.details.olderThanDays, 90);
  assert.equal(areas.transcripts.details.removed, 1);
  assert.equal(areas["update-backup"].resourceId, backup);
  assert.ok(areas.dependencies.details.bytes > 0);
  assert.ok(!JSON.stringify(events).includes(old), "no transcript id in the audit");
});
