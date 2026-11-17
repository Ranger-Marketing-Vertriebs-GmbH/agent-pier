import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { trustAttachmentFolder } from "../../server/features/clis/claude/attachment-trust.js";
import { cliDriver } from "../../server/features/clis/drivers.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-attachment-trust-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = path.join(root, "profile");
  const folder = path.join(root, "chat-attachments", "a1", "s1");
  fs.mkdirSync(profile);
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(profile, ".claude.json");
  return {
    env: { CLAUDE_CONFIG_DIR: profile },
    folder,
    key: fs.realpathSync(folder),
    file,
    read: () => JSON.parse(fs.readFileSync(file, "utf8")),
  };
}

test("the attachment folder is trusted in the account's Claude profile", (t) => {
  const f = fixture(t);
  assert.equal(trustAttachmentFolder(f.env, f.folder), true);
  assert.deepEqual(f.read(), { projects: { [f.key]: { hasTrustDialogAccepted: true } } });
  // Again: nothing to change.
  const before = fs.readFileSync(f.file, "utf8");
  assert.equal(trustAttachmentFolder(f.env, f.folder), true);
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
});

test("the rest of Claude's configuration and the folder's entry are kept", (t) => {
  const f = fixture(t);
  const other = { "/project": { hasTrustDialogAccepted: true, allowedTools: [] } };
  fs.writeFileSync(
    f.file,
    JSON.stringify(
      {
        numStartups: 3,
        projects: { ...other, [f.key]: { lastCost: 1 } },
        mcpServers: { one: { command: "x" } },
      },
      null,
      2,
    ),
  );
  assert.equal(trustAttachmentFolder(f.env, f.folder), true);
  assert.deepEqual(f.read(), {
    numStartups: 3,
    projects: { ...other, [f.key]: { lastCost: 1, hasTrustDialogAccepted: true } },
    mcpServers: { one: { command: "x" } },
  });
});

test("a local account's own profile or an unreadable one is left alone", (t) => {
  const f = fixture(t);
  assert.equal(trustAttachmentFolder({}, f.folder), false);
  assert.equal(trustAttachmentFolder({ CLAUDE_CONFIG_DIR: "relative" }, f.folder), false);
  assert.equal(trustAttachmentFolder(undefined, f.folder), false);
  assert.equal(fs.existsSync(f.file), false);
  // A missing folder, a broken file or an unexpected shape: no write, no throw.
  assert.equal(trustAttachmentFolder(f.env, path.join(f.folder, "missing")), false);
  for (const text of [
    "{ not json",
    '{"projects": []}',
    `{"projects": {"${f.key}": 1}}`,
  ]) {
    fs.writeFileSync(f.file, text);
    assert.equal(trustAttachmentFolder(f.env, f.folder), false);
    assert.equal(fs.readFileSync(f.file, "utf8"), text);
  }
});

test("Claude's attachment grant records the trust on launch and reload", (t) => {
  for (const reload of [false, true]) {
    const f = fixture(t);
    const launch = { args: [], env: f.env };
    assert.equal(
      cliDriver("claude").grantDirectory(launch, f.folder, {
        reload,
        ensure: () => true,
      }),
      true,
    );
    assert.deepEqual(launch.args, ["--add-dir", f.folder]);
    assert.equal(f.read().projects[f.key].hasTrustDialogAccepted, true);
  }
});
