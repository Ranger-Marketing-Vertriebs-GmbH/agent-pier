import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { grantAttachmentAccess } from "../../server/features/sessions/attachment-access.js";
import {
  accountAttachmentDirectory,
  attachmentDirectory,
} from "../../server/features/chat/chat-attachments.js";

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-grant-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const root = path.join(dataDir, "profile");
  fs.mkdirSync(root, { recursive: true });
  return { dataDir, profile: { root, boundary: root, account: { tool: "opencode" } } };
}

for (const tool of ["claude", "codex"])
  test(`${tool} sessions receive --add-dir for the session directory`, (t) => {
    const f = fixture(t);
    const launch = { args: ["--existing"] };
    const granted = grantAttachmentAccess({
      tool,
      dataDir: f.dataDir,
      accountId: "account",
      sessionId: "session",
      launch,
      profile: null,
    });
    const expected = attachmentDirectory(f.dataDir, "account", "session");
    assert.equal(granted.directory, expected);
    assert.deepEqual(launch.args, ["--existing", "--add-dir", expected]);
    assert.equal(fs.statSync(expected).isDirectory(), true);
  });

test("opencode sessions receive an account-scoped references entry and no flag", (t) => {
  const f = fixture(t);
  const launch = { args: ["--existing"] };
  const granted = grantAttachmentAccess({
    tool: "opencode",
    dataDir: f.dataDir,
    accountId: "account",
    sessionId: "session",
    launch,
    profile: f.profile,
  });
  assert.equal(granted.directory, attachmentDirectory(f.dataDir, "account", "session"));
  assert.deepEqual(launch.args, ["--existing"]);
  const config = JSON.parse(
    fs.readFileSync(path.join(f.profile.root, "opencode.json"), "utf8"),
  );
  assert.equal(
    config.references["agentpier-attachments"].path,
    accountAttachmentDirectory(f.dataDir, "account"),
  );
});

test("an existing opencode configuration keeps its unrelated fields and gains one entry", (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    path.join(f.profile.root, "opencode.json"),
    JSON.stringify({
      model: "anthropic/claude-sonnet-4",
      references: { docs: { path: "/docs" } },
    }),
  );
  for (const sessionId of ["first", "second"])
    grantAttachmentAccess({
      tool: "opencode",
      dataDir: f.dataDir,
      accountId: "account",
      sessionId,
      launch: { args: [] },
      profile: f.profile,
    });
  const config = JSON.parse(
    fs.readFileSync(path.join(f.profile.root, "opencode.json"), "utf8"),
  );
  assert.equal(config.model, "anthropic/claude-sonnet-4");
  assert.equal(config.references.docs.path, "/docs");
  assert.equal(Object.keys(config.references).length, 2);
});

test("opencode sessions with no profile receive no grant and no directory", (t) => {
  const f = fixture(t);
  const launch = { args: ["--existing"] };
  const granted = grantAttachmentAccess({
    tool: "opencode",
    dataDir: f.dataDir,
    accountId: "account",
    sessionId: "session",
    launch,
    profile: null,
  });
  assert.equal(granted, null);
  assert.deepEqual(launch.args, ["--existing"]);
  assert.equal(
    fs.existsSync(attachmentDirectory(f.dataDir, "account", "session")),
    false,
  );
});

test("a malformed opencode.json aborts the grant, not the launch", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.profile.root, "opencode.json"), "{ not json");
  const launch = { args: ["--existing"] };
  const granted = grantAttachmentAccess({
    tool: "opencode",
    dataDir: f.dataDir,
    accountId: "account",
    sessionId: "session",
    launch,
    profile: f.profile,
  });
  assert.equal(granted, null);
  assert.deepEqual(launch.args, ["--existing"]);
  assert.equal(
    fs.existsSync(attachmentDirectory(f.dataDir, "account", "session")),
    false,
  );
});

test("a symlinked opencode.json (the standard dotfiles pattern) aborts the grant, not the launch", (t) => {
  const f = fixture(t);
  const real = path.join(f.dataDir, "real-opencode.json");
  fs.writeFileSync(real, JSON.stringify({ model: "anthropic/claude-sonnet-4" }));
  fs.symlinkSync(real, path.join(f.profile.root, "opencode.json"));
  const launch = { args: ["--existing"] };
  const granted = grantAttachmentAccess({
    tool: "opencode",
    dataDir: f.dataDir,
    accountId: "account",
    sessionId: "session",
    launch,
    profile: f.profile,
  });
  assert.equal(granted, null);
  assert.deepEqual(launch.args, ["--existing"]);
  assert.equal(
    fs.existsSync(attachmentDirectory(f.dataDir, "account", "session")),
    false,
  );
});

test("duplicate JSON keys in opencode.json abort the grant, not the launch", (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    path.join(f.profile.root, "opencode.json"),
    '{"model":"a","model":"b"}',
  );
  const launch = { args: ["--existing"] };
  const granted = grantAttachmentAccess({
    tool: "opencode",
    dataDir: f.dataDir,
    accountId: "account",
    sessionId: "session",
    launch,
    profile: f.profile,
  });
  assert.equal(granted, null);
  assert.deepEqual(launch.args, ["--existing"]);
  assert.equal(
    fs.existsSync(attachmentDirectory(f.dataDir, "account", "session")),
    false,
  );
});

test("a second launch with an already-correct references entry writes nothing", (t) => {
  const f = fixture(t);
  const launch = { args: [] };
  grantAttachmentAccess({
    tool: "opencode",
    dataDir: f.dataDir,
    accountId: "account",
    sessionId: "first",
    launch,
    profile: f.profile,
  });
  const file = path.join(f.profile.root, "opencode.json");
  const before = fs.readFileSync(file, "utf8");
  const mtimeBefore = fs.statSync(file).mtimeNs;
  grantAttachmentAccess({
    tool: "opencode",
    dataDir: f.dataDir,
    accountId: "account",
    sessionId: "second",
    launch: { args: [] },
    profile: f.profile,
  });
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(fs.statSync(file).mtimeNs, mtimeBefore);
});

test("a stale references entry (e.g. after dataDir changed) is corrected", (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    path.join(f.profile.root, "opencode.json"),
    JSON.stringify({ references: { "agentpier-attachments": { path: "/old/path" } } }),
  );
  grantAttachmentAccess({
    tool: "opencode",
    dataDir: f.dataDir,
    accountId: "account",
    sessionId: "session",
    launch: { args: [] },
    profile: f.profile,
  });
  const config = JSON.parse(
    fs.readFileSync(path.join(f.profile.root, "opencode.json"), "utf8"),
  );
  assert.equal(
    config.references["agentpier-attachments"].path,
    accountAttachmentDirectory(f.dataDir, "account"),
  );
});

for (const tool of ["claude", "codex"])
  test(`${tool}: an occupied account directory aborts the grant, not the launch`, (t) => {
    const f = fixture(t);
    const accountDir = accountAttachmentDirectory(f.dataDir, "account");
    fs.mkdirSync(path.dirname(accountDir), { recursive: true });
    // A regular file sits where the account directory needs to be, so
    // mkdir -p fails with ENOTDIR: deterministic and root-safe, unlike chmod.
    fs.writeFileSync(accountDir, "not a directory");
    const launch = { args: ["--existing"] };
    const granted = grantAttachmentAccess({
      tool,
      dataDir: f.dataDir,
      accountId: "account",
      sessionId: "session",
      launch,
      profile: null,
    });
    assert.equal(granted, null);
    assert.deepEqual(launch.args, ["--existing"]);
  });

test("opencode: a directory failure after a successful config write still yields no grant", (t) => {
  const f = fixture(t);
  const accountDir = accountAttachmentDirectory(f.dataDir, "account");
  fs.mkdirSync(path.dirname(accountDir), { recursive: true });
  fs.writeFileSync(accountDir, "not a directory");
  const launch = { args: ["--existing"] };
  const granted = grantAttachmentAccess({
    tool: "opencode",
    dataDir: f.dataDir,
    accountId: "account",
    sessionId: "session",
    launch,
    profile: f.profile,
  });
  assert.equal(granted, null);
  assert.deepEqual(launch.args, ["--existing"]);
  // The config write (account-scoped) succeeded before the per-session mkdir
  // failed; the reference is harmless to leave behind (see discardAttachmentAccess).
  const config = JSON.parse(
    fs.readFileSync(path.join(f.profile.root, "opencode.json"), "utf8"),
  );
  assert.equal(config.references["agentpier-attachments"].path, accountDir);
});

test("shell sessions receive no grant at all", (t) => {
  const f = fixture(t);
  const launch = { args: ["--existing"] };
  assert.equal(
    grantAttachmentAccess({
      tool: "shell",
      dataDir: f.dataDir,
      accountId: "account",
      sessionId: "session",
      launch,
      profile: null,
    }),
    null,
  );
  assert.deepEqual(launch.args, ["--existing"]);
});
