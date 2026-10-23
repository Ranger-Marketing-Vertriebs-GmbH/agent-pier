import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { applicationFixture } from "../helpers/application.js";
import { englishServerMessages } from "../../server/lib/i18n/catalog-en.js";

const execute = promisify(execFile);
const helper = fileURLToPath(new URL("../../server/ssh.mjs", import.meta.url));
test("real app manages private keys and assigns new/existing sessions across restart without remote effects", async (t) => {
  const f = await applicationFixture(t);
  assert.equal((await fetch(f.url + "/api/ssh-accesses")).status, 401);
  const key = path.join(f.root, "fixture-key");
  await execute("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  const privateKey = await fs.readFile(key, "utf8");
  const hostKey = (await fs.readFile(key + ".pub", "utf8")).trim();
  const created = await f.request("/api/ssh-accesses", {
    method: "POST",
    body: {
      name: "Disposable lab",
      host: "192.0.2.1",
      username: "fixture",
      hostKey,
      privateKey,
    },
  });
  assert.equal(created.status, 201);
  const access = await created.json();
  assert.equal(JSON.stringify(access).includes("PRIVATE KEY"), false);
  assert.equal(JSON.stringify(access).includes(privateKey), false);
  assert.match(access.publicKey, /^ssh-ed25519 /);
  const start = await f.request("/api/sessions", {
    method: "POST",
    body: {
      accountId: "local-shell",
      cwd: f.home,
      sshAccessIds: [access.id],
    },
  });
  assert.equal(start.status, 201, await start.clone().text());
  const session = await start.json();
  const endpoint = `/api/sessions/${session.id}/ssh-accesses`;
  assert.deepEqual((await (await f.request(endpoint)).json()).assignedIds, [access.id]);
  const bin = path.join(f.root, "bin");
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, "ssh"), "#!/bin/sh\nprintf 'fixture-ssh-only\\n'\n", {
    mode: 0o755,
  });
  const run = () =>
    execute(
      process.execPath,
      [
        helper,
        "--data-dir",
        f.dataDir,
        "--session",
        session.id,
        "--access",
        access.id,
        "--",
        "true",
      ],
      { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, timeout: 5000 },
    );
  assert.equal((await run()).stdout.trim(), "fixture-ssh-only");
  assert.equal(
    (await f.request(endpoint, { method: "PUT", body: { accessIds: [] } })).status,
    200,
  );
  // The helper's stderr is read by coding agents, so catalog text arrives in English.
  await assert.rejects(run(), (error) =>
    error.stderr.includes(englishServerMessages.ssh.accessNotBound),
  );
  assert.equal(
    (await f.request(endpoint, { method: "PUT", body: { accessIds: [access.id] } }))
      .status,
    200,
  );
  await f.restart();
  assert.equal((await run()).stdout.trim(), "fixture-ssh-only");
  const audit = await f.request("/api/audit");
  const auditText = await audit.text();
  assert.equal(auditText.includes("PRIVATE KEY"), false);
  assert.equal(
    (await f.request(`/api/sessions/${session.id}/stop`, { method: "POST" })).status,
    200,
  );
  await assert.rejects(run());
  assert.deepEqual((await (await f.request(endpoint)).json()).assignedIds, []);
});

test("the SSH helper answers invalid arguments in English", async () => {
  await assert.rejects(
    execute(process.execPath, [helper, "--data-dir", "relative"]),
    (error) =>
      error.stderr.trim() ===
      "Usage: ssh.mjs --data-dir DIR --session ID --access ID [-- remote command]",
  );
});

test("the SSH helper refuses an SFTP host and the API never returns its password", async (t) => {
  const f = await applicationFixture(t);
  const key = path.join(f.root, "fixture-host-key");
  await execute("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  const hostKey = (await fs.readFile(key + ".pub", "utf8")).trim();
  const created = await f.request("/api/ssh-accesses", {
    method: "POST",
    body: {
      name: "Webspace",
      host: "192.0.2.1",
      username: "fixture",
      hostKey,
      type: "sftp",
      auth: "password",
      password: "fixture-password-secret",
    },
  });
  assert.equal(created.status, 201, await created.clone().text());
  const access = await created.json();
  assert.equal(access.type, "sftp");
  assert.equal(access.hasPassword, true);
  const listed = await (await f.request("/api/ssh-accesses")).text();
  for (const text of [JSON.stringify(access), listed])
    assert.equal(text.includes("fixture-password-secret"), false);
  // A shell only has the SSH helper, so it cannot be granted an SFTP host.
  const refused = await f.request("/api/sessions", {
    method: "POST",
    body: { accountId: "local-shell", cwd: f.home, sshAccessIds: [access.id] },
  });
  assert.equal(refused.status, 409, await refused.clone().text());
  assert.equal((await refused.json()).code, "SSH_HOST_TYPE");
  const start = await f.request("/api/sessions", {
    method: "POST",
    body: { accountId: "local-shell", cwd: f.home },
  });
  assert.equal(start.status, 201, await start.clone().text());
  const session = await start.json();
  const granted = await f.request(`/api/sessions/${session.id}/ssh-accesses`, {
    method: "PUT",
    body: { accessIds: [access.id] },
  });
  assert.equal(granted.status, 409, await granted.clone().text());
  const args = ["--data-dir", f.dataDir, "--session", session.id, "--access", access.id];
  await assert.rejects(
    execute(process.execPath, [helper, ...args, "--", "true"], { timeout: 5000 }),
    (error) =>
      error.stderr.trim() === englishServerMessages.ssh.accessNotBound &&
      !error.stderr.includes("fixture-password-secret"),
  );
});

test("the SSH helper refuses an SFTP host a shell inherits from its project", async (t) => {
  const f = await applicationFixture(t);
  const key = path.join(f.root, "fixture-host-key");
  await execute("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  const hostKey = (await fs.readFile(key + ".pub", "utf8")).trim();
  const project = await (
    await f.request("/api/memory/projects", { method: "POST", body: { cwd: f.project } })
  ).json();
  const created = await f.request("/api/ssh-accesses", {
    method: "POST",
    body: {
      name: "Project webspace",
      host: "192.0.2.1",
      username: "fixture",
      hostKey,
      type: "sftp",
      auth: "password",
      password: "fixture-password-secret",
      projectId: project.id,
    },
  });
  assert.equal(created.status, 201, await created.clone().text());
  const access = await created.json();
  const start = await f.request("/api/sessions", {
    method: "POST",
    body: { accountId: "local-shell", cwd: f.project },
  });
  assert.equal(start.status, 201, await start.clone().text());
  const session = await start.json();
  // A shell neither lists nor gets a command for the inherited SFTP host.
  const state = await (
    await f.request(`/api/sessions/${session.id}/ssh-accesses`)
  ).json();
  assert.deepEqual(state.inheritedIds, []);
  assert.deepEqual(state.commands, []);
  const args = ["--data-dir", f.dataDir, "--session", session.id, "--access", access.id];
  await assert.rejects(
    execute(process.execPath, [helper, ...args, "--", "true"], { timeout: 5000 }),
    (error) =>
      error.stderr.trim() === englishServerMessages.ssh.sftpOnly &&
      !error.stderr.includes("fixture-password-secret"),
  );
});
