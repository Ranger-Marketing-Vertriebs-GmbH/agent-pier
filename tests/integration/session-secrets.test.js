import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { waitFor } from "../helpers/agent-ssh-fixture.js";
import { createSshProjectBinding } from "../../server/features/ssh/ssh-project-scope.js";
import { SECRETS_FILE_ENV } from "../../server/features/secrets/secrets-hint.js";

const owner = { kind: "owner" };

// A CLI stand-in that records the secrets variable it was started with.
function recordingCli(f) {
  const seen = path.join(f.root, "seen-env.txt");
  f.application.accounts.command = () => ({
    command: process.execPath,
    args: [
      "-e",
      `require("fs").writeFileSync(${JSON.stringify(seen)}, process.env.${SECRETS_FILE_ENV} || "none"); setInterval(() => {}, 1000)`,
      "--",
    ],
    env: {},
  });
  return seen;
}

test("a launched session gets its project and assigned secrets, live, until it stops", async (t) => {
  const f = await applicationFixture(t);
  const seen = recordingCli(f);
  const { secrets, sessionSecrets } = f.application;
  const { projectId } = await createSshProjectBinding(f.project);
  const projectSecret = secrets.create(
    { name: "ZABBIX_TOKEN", projectId, value: "zabbix-value" },
    owner,
  );
  const global = secrets.create({ name: "HA_TOKEN", value: "ha-value" }, owner);
  const response = await f.request("/api/sessions", {
    method: "POST",
    body: {
      accountId: "local-codex",
      cwd: f.project,
      agentbus: false,
      secretIds: [global.id],
    },
  });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  assert.equal(text.includes("zabbix-value") || text.includes("ha-value"), false);
  const session = JSON.parse(text);
  assert.deepEqual(session.secrets, { projectId, assignedIds: [global.id] });
  const file = sessionSecrets.file(session.id);
  assert.equal(
    await waitFor(() => fs.existsSync(seen) && fs.readFileSync(seen, "utf8"), 10_000),
    file,
  );
  assert.match(
    fs.readFileSync(file, "utf8"),
    /^HA_TOKEN='ha-value'\nZABBIX_TOKEN='zabbix-value'\n$/m,
  );
  const record = await f.application.sessions.metadata(session.id);
  assert.deepEqual(record.secrets, session.secrets);
  assert.equal(JSON.stringify(record).includes("zabbix-value"), false);

  secrets.update(projectSecret.id, { value: "rotated" }, owner);
  await waitFor(() => fs.readFileSync(file, "utf8").includes("ZABBIX_TOKEN='rotated'"));

  const stopped = await f.request(`/api/sessions/${session.id}/stop`, { method: "POST" });
  assert.equal(stopped.status, 200, await stopped.text());
  assert.equal(fs.existsSync(path.dirname(file)), false);
  const removed = await f.request(`/api/sessions/${session.id}`, { method: "DELETE" });
  assert.equal(removed.status, 204);
});

test("an unknown assigned secret refuses the launch before a session exists", async (t) => {
  const f = await applicationFixture(t);
  recordingCli(f);
  const response = await f.request("/api/sessions", {
    method: "POST",
    body: {
      accountId: "local-codex",
      cwd: f.project,
      agentbus: false,
      secretIds: ["gone"],
    },
  });
  assert.equal(response.status, 409);
  assert.equal((await f.application.sessions.list()).length, 0);
});
