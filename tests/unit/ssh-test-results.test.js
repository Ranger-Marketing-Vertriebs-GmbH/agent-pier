import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SshTestResults,
  reportsHostKeyChange,
  sanitizeTestDetail,
  testDetailLimit,
} from "../../server/features/ssh/ssh-test-results.js";

const id = "0b8f9a52-3a4e-4c55-9d1e-2b1c8e2f6a10";
const revision = "a".repeat(64);

test("a stored test detail keeps no password, token or key material", () => {
  const secrets = [
    "hunter2-password",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
    "sk-proj-0123456789abcdefghijkl",
    "aph_Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA",
    "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
    "c2VjcmV0LXRva2VuLXZhbHVlLXRoYXQtaXMtbG9uZw==",
    "s3cr3tUser:pa55word",
  ];
  const cases = [
    `Permission denied, password=${secrets[0]} (publickey).`,
    `token: ${secrets[1]}`,
    `Authorization: Bearer ${secrets[2]}`,
    `export OPENAI=${secrets[3]}`,
    `hook ${secrets[4]} rejected`,
    `Offending key ssh-ed25519 ${secrets[5]} in known_hosts`,
    `opaque ${secrets[6]}`,
    `fetch https://${secrets[7]}@example.test/repo failed`,
    `-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----`,
  ];
  for (const text of cases) {
    const clean = sanitizeTestDetail(text);
    for (const secret of [...secrets, "b3BlbnNzaC1rZXktdjEAAAAA", "PRIVATE KEY"])
      assert.equal(clean?.includes(secret), false, `${secret} in ${clean}`);
  }
  assert.equal(
    sanitizeTestDetail(`Permission denied, password=${secrets[0]} (publickey).`),
    "Permission denied, password=[redacted] (publickey).",
  );
  assert.equal(
    sanitizeTestDetail(`Offending key ssh-ed25519 ${secrets[5]} in known_hosts`),
    "Offending key ssh-ed25519 [redacted] in known_hosts",
  );
});

test("the detail is OpenSSH's last meaningful line, single and bounded", () => {
  assert.equal(
    sanitizeTestDetail(
      "Warning: Permanently added 'lab' (ED25519) to the list of known hosts.\r\n" +
        "deploy@192.0.2.1: Permission denied (publickey).\n\n",
    ),
    "deploy@192.0.2.1: Permission denied (publickey).",
  );
  assert.equal(sanitizeTestDetail("a\u0007b\u001b[31mc"), "a b [31mc");
  const long = sanitizeTestDetail("x ".repeat(400));
  assert.equal(long.length, testDetailLimit);
  assert.ok(long.endsWith("…"));
  for (const empty of ["", "  \n ", null, undefined, 42])
    assert.equal(sanitizeTestDetail(empty), null);
});

test("a changed host key is told apart from other failures", () => {
  assert.equal(reportsHostKeyChange("Host key verification failed.\r\n"), true);
  assert.equal(
    reportsHostKeyChange("@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @"),
    true,
  );
  assert.equal(reportsHostKeyChange("Connection refused"), false);
  assert.equal(reportsHostKeyChange(undefined), false);
});

test("results persist, follow the host's revision and are forgotten", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-ssh-results-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const results = new SshTestResults({ root });
  results.record(id, revision, {
    ok: false,
    code: null,
    hostKeyMismatch: true,
    detail: "password=hunter2 Host key verification failed.",
  });
  const file = path.join(root, "test-results.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file, "utf8").includes("hunter2"), false);
  const reloaded = new SshTestResults({ root });
  const view = reloaded.view(reloaded.read(), id, revision);
  assert.equal(view.ok, false);
  assert.equal(view.hostKeyMismatch, true);
  assert.equal(view.detail, "password=[redacted] Host key verification failed.");
  assert.equal(view.messageKey, "ssh.connectionFailed");
  assert.match(view.at, /^\d{4}-\d{2}-\d{2}T/);
  // Another endpoint, key or credential: the old result no longer applies.
  assert.equal(reloaded.view(reloaded.read(), id, "b".repeat(64)), null);
  reloaded.record(id, revision, { ok: true, commandRejected: true });
  assert.deepEqual(
    { ...reloaded.view(reloaded.read(), id, revision), at: "t" },
    {
      ok: true,
      at: "t",
      commandRejected: true,
      code: null,
      hostKeyMismatch: false,
      detail: null,
      error: null,
    },
  );
  reloaded.forget(id);
  assert.equal(reloaded.view(reloaded.read(), id, revision), null);
  // Malformed ids or revisions are never written; a broken file reads as empty.
  reloaded.record("../x", revision, { ok: true });
  reloaded.record(id, "short", { ok: true });
  assert.deepEqual(reloaded.read(), {});
  fs.writeFileSync(file, "{broken");
  assert.deepEqual(reloaded.read(), {});
});
