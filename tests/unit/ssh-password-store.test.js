import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  SshPasswordStore,
  passwordValue,
} from "../../server/features/ssh/ssh-password-store.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-passwords-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, store: new SshPasswordStore({ root }), host: randomUUID() };
}

test("writes 0600 inside 0700", (t) => {
  const { root, store, host } = fixture(t);
  const revision = randomUUID();
  store.write(host, revision, "pw-sëcret");
  const file = path.join(root, "passwords", host, revision);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(root, "passwords")).mode & 0o777, 0o700);
  assert.equal(store.read(host, revision), "pw-sëcret");
  assert.throws(() => store.write(host, revision, "other"));
  assert.throws(() => store.read(host, randomUUID()), { status: 409 });
  assert.throws(() => store.read("../x", revision), { status: 404 });
});

test("refuses a symlinked file", (t) => {
  const { root, store, host } = fixture(t);
  const revision = randomUUID();
  store.write(host, randomUUID(), "pw");
  const target = path.join(root, "outside");
  fs.writeFileSync(target, "leaked", { mode: 0o600 });
  fs.symlinkSync(target, path.join(root, "passwords", host, revision));
  assert.throws(() => store.read(host, revision), { status: 409 });
  assert.throws(() => store.write(host, revision, "pw"));
  assert.equal(fs.readFileSync(target, "utf8"), "leaked");
});

test("refuses a file over 1024 bytes", (t) => {
  const { root, store, host } = fixture(t);
  const revision = randomUUID();
  store.write(host, randomUUID(), "pw");
  fs.writeFileSync(path.join(root, "passwords", host, revision), "x".repeat(1025), {
    mode: 0o600,
  });
  assert.throws(() => store.read(host, revision), { status: 409 });
  assert.throws(() => store.write(host, randomUUID(), "x".repeat(1025)), {
    status: 400,
  });
});

test("passwordValue accepts 1-1024 UTF-8 bytes without NUL, CR or LF", () => {
  assert.equal(passwordValue("a b"), "a b");
  assert.equal(passwordValue("ü".repeat(512)), "ü".repeat(512));
  for (const bad of ["", "ü".repeat(513), "a\nb", "a\rb", "a\0b", 7, null])
    assert.throws(() => passwordValue(bad), { status: 400 });
});

test("removeOthers keeps only the current revision", (t) => {
  const { root, store, host } = fixture(t);
  const [old, current] = [randomUUID(), randomUUID()];
  store.write(host, old, "old");
  store.write(host, current, "new");
  store.removeOthers(host, current);
  assert.deepEqual(fs.readdirSync(path.join(root, "passwords", host)), [current]);
  assert.equal(store.read(host, current), "new");
  store.removeHost(host);
  assert.equal(fs.existsSync(path.join(root, "passwords", host)), false);
  store.removeHost(host);
  store.removeOthers(host, current);
});
