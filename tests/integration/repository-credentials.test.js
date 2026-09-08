import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { RepositoryStore } from "../../server/features/repositories/repository-store.js";
import { setup, helper } from "../helpers/repositories.js";
test("named credentials persist independently, keep blank updates and expose metadata only", (t) => {
  const { dir, store } = setup(t);
  const a = store.createCredential({
    name: "Work",
    host: "github.com",
    token: "private-work-token",
  });
  const b = store.createCredential({
    name: "Personal",
    host: "https://github.com",
    token: "private-personal-token",
  });
  assert.notEqual(a.id, b.id);
  assert.deepEqual(Object.keys(a).sort(), [
    "agentDefault",
    "createdAt",
    "hasSecret",
    "host",
    "id",
    "name",
  ]);
  assert.equal(a.host, "https://github.com");
  assert.equal(a.hasSecret, true);
  store.updateCredential(a.id, { name: "Renamed", token: "" });
  const saved = new RepositoryStore({ dataDir: path.join(dir, "data"), home: dir });
  assert.equal(saved.listCredentials().find((item) => item.id === a.id).name, "Renamed");
  assert.equal(JSON.stringify(saved.listCredentials()).includes("private-"), false);
  const metadata = fs.readFileSync(path.join(dir, "data", "repositories.json"), "utf8");
  assert.equal(metadata.includes("private-"), false);
  const secret = path.join(dir, "data", "repository-secrets", `${a.id}.json`);
  assert.equal(JSON.parse(fs.readFileSync(secret)).token, "private-work-token");
  assert.equal(fs.statSync(secret).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(secret)).mode & 0o777, 0o700);
  saved.updateCredential(a.id, {
    name: "Renamed",
    token: "replacement-token",
    host: "git.example.org:8443",
  });
  assert.equal(
    saved.listCredentials().find((item) => item.id === a.id).host,
    "https://git.example.org:8443",
  );
  assert.equal(JSON.parse(fs.readFileSync(secret)).token, "replacement-token");
  saved.removeCredential(a.id);
  assert.equal(fs.existsSync(secret), false);
  assert.deepEqual(
    saved.listCredentials().map((item) => item.id),
    [b.id],
  );
  assert.throws(() => saved.removeCredential("../outside"), { status: 404 });
});

test("credential origin validation rejects URL confusion and invalid secrets without echoing inputs", (t) => {
  const { store } = setup(t);
  for (const host of [
    "http://github.com",
    "https://github.com/path",
    "https://github.com?x",
    "https://github.com#x",
    "https://user@github.com",
    "github.com\\evil",
    "github.com\n",
    "https://github.com/%2e%2e",
    "https://github.com:bad",
    "github.com evil",
  ]) {
    assert.throws(
      () => store.createCredential({ name: "Test", host, token: "sensitive-input" }),
      (error) => error.status === 400 && !error.message.includes("sensitive-input"),
      host,
    );
  }
  for (const token of ["", "\nsecret", "x\0y", 42])
    assert.throws(
      () => store.createCredential({ name: "Test", host: "github.com", token }),
      { status: 400 },
    );
  assert.deepEqual(store.listCredentials(), []);
});

test("ephemeral credential helper releases a token only for get on its exact HTTPS origin", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-helper-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const secretFile = path.join(dir, "credential.json");
  fs.writeFileSync(
    secretFile,
    JSON.stringify({ host: "https://git.example.org:8443", token: "fixture-secret" }),
    { mode: 0o600 },
  );
  const run = (input, operation = "get") =>
    spawnSync(process.execPath, [helper, operation], {
      input,
      encoding: "utf8",
      env: { ...process.env, AGENTPIER_GIT_CREDENTIAL_FILE: secretFile },
    });
  const result = run("protocol=https\nhost=git.example.org:8443\n\n");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "username=x-access-token\npassword=fixture-secret\n\n");
  assert.equal(
    run(
      'capability[]=authtype\ncapability[]=state\nprotocol=https\nhost=git.example.org:8443\nwwwauth[]=Basic realm="fixture"\n\n',
    ).stdout,
    "username=x-access-token\npassword=fixture-secret\n\n",
  );
  for (const input of [
    "protocol=http\nhost=git.example.org:8443\n\n",
    "protocol=https\nhost=git.example.org\n\n",
    "protocol=https\nhost=git.example.org:8443.evil.org\n\n",
    "protocol=https\nhost=git.example.org:8443@evil.org\n\n",
    "protocol=https\nhost=evil.org\nhost=git.example.org:8443\n\n",
    "protocol=https\nhost=git.example.org:8443/path\n\n",
  ]) {
    const denied = run(input);
    assert.equal(denied.stdout, "");
    assert.equal(denied.stderr.includes("fixture-secret"), false);
  }
  for (const operation of ["store", "erase"])
    assert.equal(
      run("protocol=https\nhost=git.example.org:8443\n\n", operation).stdout,
      "",
    );
});

test("agent defaults are explicit per host, legacy defaults deterministic, and project credentials remain independent", (t) => {
  const { store } = setup(t);
  const a = store.createCredential({ name: "A", host: "github.com", token: "a" });
  const b = store.createCredential({ name: "B", host: "github.com", token: "b" });
  const e = store.createCredential({ name: "E", host: "enterprise.test", token: "e" });
  assert.equal(a.agentDefault, true);
  assert.equal(b.agentDefault, false);
  assert.equal(e.agentDefault, true);
  store.updateCredential(b.id, { name: "B", agentDefault: true });
  assert.deepEqual(
    store
      .listCredentials()
      .filter((x) => x.agentDefault)
      .map((x) => x.id),
    [b.id, e.id],
  );
  store.updateCredential(b.id, { name: "B", agentDefault: false });
  assert.equal(
    store
      .listCredentials()
      .filter((x) => x.host === "https://github.com" && x.agentDefault).length,
    1,
  );
  for (const item of store.credentials) delete item.agentDefault;
  assert.equal(store.listCredentials().find((x) => x.id === a.id).agentDefault, true);
  store.updateCredential(a.id, { name: "A", agentDefault: false });
  assert.equal(
    store
      .listCredentials()
      .filter((x) => x.host === "https://github.com" && x.agentDefault).length,
    1,
  );
  assert.throws(
    () =>
      store.createCredential({
        name: "Bad",
        host: "github.com",
        token: "t",
        agentDefault: "yes",
      }),
    { status: 400 },
  );
});
