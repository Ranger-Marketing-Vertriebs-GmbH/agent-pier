import assert from "node:assert/strict";
import test from "node:test";
import {
  detectOpenSsh,
  parseOpenSshVersion,
  supportsSessionBind,
} from "../../server/features/ssh/ssh-openssh-version.js";

test("OpenSSH versions parse and gate session-bind", () => {
  assert.deepEqual(parseOpenSshVersion("OpenSSH_10.2p1, LibreSSL 3.3.6"), {
    major: 10,
    minor: 2,
  });
  assert.deepEqual(parseOpenSshVersion("OpenSSH_8.9p1 Ubuntu-3ubuntu0.10, OpenSSL"), {
    major: 8,
    minor: 9,
  });
  assert.deepEqual(parseOpenSshVersion("OpenSSH_for_Windows_9.5p1, LibreSSL"), {
    major: 9,
    minor: 5,
  });
  assert.equal(supportsSessionBind({ major: 8, minor: 9 }), true);
  assert.equal(supportsSessionBind({ major: 9, minor: 0 }), true);
  assert.equal(supportsSessionBind({ major: 10, minor: 2 }), true);
  assert.equal(supportsSessionBind({ major: 8, minor: 7 }), false);
  assert.equal(supportsSessionBind({ major: 7, minor: 99 }), false);
  assert.equal(supportsSessionBind(null), false);
  assert.equal(supportsSessionBind({ major: "9", minor: 0 }), false);
  assert.equal(parseOpenSshVersion("Sun_SSH_1.1"), null);
  assert.equal(parseOpenSshVersion(""), null);
  assert.equal(parseOpenSshVersion(undefined), null);
});

test("detectOpenSsh runs ssh -V and reads stderr", async () => {
  const calls = [];
  const version = await detectOpenSsh(async (file, args) => {
    calls.push([file, args]);
    return { stdout: "", stderr: "OpenSSH_9.2p1 Debian-2+deb12u3, OpenSSL 3.0.15\n" };
  });
  assert.deepEqual(version, { major: 9, minor: 2 });
  assert.deepEqual(calls, [["ssh", ["-V"]]]);
});

test("detectOpenSsh is null without ssh or with an unknown client", async () => {
  assert.equal(
    await detectOpenSsh(async () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }),
    null,
  );
  assert.equal(
    await detectOpenSsh(async () => ({ stdout: "", stderr: "Sun_SSH_1.1" })),
    null,
  );
});

test("detectOpenSsh reads the real client", async () => {
  const version = await detectOpenSsh();
  // Every supported host has OpenSSH; the parse must succeed on it.
  assert.equal(typeof version?.major, "number");
});
