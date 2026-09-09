import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { applicationFixture } from "../helpers/application.js";

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
  await assert.rejects(run(), /nicht zugeordnet/);
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
