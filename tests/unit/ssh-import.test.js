import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSshImport, sshImportPath } from "../../server/features/ssh/ssh-import.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-source-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"),
    dataDir = path.join(root, "data");
  fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
  fs.mkdirSync(dataDir);
  const source = path.join(home, ".ssh", "existing");
  fs.writeFileSync(source, "private fixture bytes\n", { mode: 0o600 });
  return { home, dataDir, source };
}

test("SSH import reads an explicit home path without changing the source", (t) => {
  const f = fixture(t);
  const before = fs.statSync(f.source);
  assert.equal(sshImportPath("~/.ssh/existing", f.home), f.source);
  assert.equal(
    readSshImport({ ...f, sourcePath: "~/.ssh/existing" }).toString(),
    "private fixture bytes\n",
  );
  assert.equal(fs.readFileSync(f.source, "utf8"), "private fixture bytes\n");
  assert.equal(fs.statSync(f.source).mode, before.mode);
});

test("SSH import rejects managed files and their external hardlinks", (t) => {
  const f = fixture(t);
  const managed = path.join(f.dataDir, "identity");
  fs.writeFileSync(managed, "not exportable by MCP");
  assert.throws(() => readSshImport({ ...f, sourcePath: managed }), {
    code: "SSH_IMPORT_SOURCE",
  });
  const link = path.join(f.home, "linked");
  fs.linkSync(managed, link);
  assert.throws(
    () => readSshImport({ ...f, sourcePath: link, identityPaths: [managed] }),
    { code: "SSH_IMPORT_SOURCE" },
  );
});

test("SSH import refuses symlinks, directories and oversized sources", (t) => {
  const f = fixture(t);
  const link = path.join(f.home, "symlink");
  fs.symlinkSync(f.source, link);
  for (const sourcePath of [link, f.home, "/dev/null"])
    assert.throws(() => readSshImport({ ...f, sourcePath }), {
      code: "SSH_IMPORT_SOURCE",
    });
  fs.writeFileSync(f.source, Buffer.alloc(65537));
  assert.throws(() => readSshImport({ ...f, sourcePath: f.source }), {
    code: "SSH_IMPORT_SOURCE",
  });
});

test("SSH import path input never performs shell or alternate-user expansion", (t) => {
  const f = fixture(t);
  for (const sourcePath of [
    "relative",
    "~someone/.ssh/key",
    "https://example/key",
    "~/keys/*",
    "~/key\0",
  ])
    assert.throws(() => sshImportPath(sourcePath, f.home), { code: "SSH_IMPORT_SOURCE" });
});
