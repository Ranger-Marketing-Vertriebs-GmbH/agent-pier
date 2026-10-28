import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mailFilesFixture } from "../helpers/mail-files-fixture.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import {
  fileContext,
  readSource,
  readSources,
  sourceAllowed,
  storedFiles,
} from "../../server/features/assistants/mail/agent-mail-sources.js";
import { mailFileType } from "../../server/features/mail/mail-file-types.js";

async function code(promise) {
  try {
    await promise;
  } catch (error) {
    return toolError(error).code;
  }
  assert.fail("the read succeeded");
}

// A folder outside the workspace, the project and AgentPier's data directory.
function hostDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mail-host-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function setup(t, options) {
  const f = await mailFilesFixture(t);
  f.access(options);
  const files = (inv = f.ownTurn()) =>
    fileContext(f.workflows, inv, f.workflows.mail.caller(inv));
  const read = (entry, inv) =>
    readSource(f.workflows, files(inv), entry, { maxBytes: 26_214_400 });
  return { ...f, files, read };
}

test("an agent without shell attaches from workspace and granted projects only", async (t) => {
  const f = await setup(t, { projectFiles: {} });
  f.access({ projectFiles: { [f.folderProject.id]: "read" } });
  assert.equal(f.files().shell, "off");
  f.file(f.ws("a.txt"), "hello");
  const own = await f.read({ path: "a.txt" });
  assert.equal(own.name, "a.txt");
  assert.equal(own.bytes.toString(), "hello");
  assert.equal(own.size, 5);
  assert.equal(own.type, "text/plain");
  assert.equal(own.sha256, createHash("sha256").update("hello").digest("hex"));
  assert.deepEqual(own.source, { kind: "workspace", path: "a.txt" });

  f.file(f.proj("docs/r.pdf"), "%PDF-1.4");
  const granted = await f.read({ path: "docs/r.pdf", projectId: f.folderProject.id });
  assert.equal(granted.type, "application/pdf");
  assert.deepEqual(granted.source, {
    kind: "project",
    projectId: f.folderProject.id,
    projectName: f.folderProject.name,
    path: "docs/r.pdf",
  });
  // An absolute path inside the granted project resolves to that project.
  const absolute = await f.read({ path: f.proj("docs/r.pdf") });
  assert.equal(absolute.source.kind, "project");
  assert.equal(absolute.source.path, "docs/r.pdf");

  const host = f.file(path.join(hostDir(t), "host.txt"));
  assert.equal(await code(f.read({ path: host })), "MAIL_SOURCE_REFUSED");
  assert.equal(await code(f.read({ path: "missing.txt" })), "MAIL_SOURCE_NOT_FOUND");
  f.file(f.ws("empty.txt"), "");
  assert.equal(await code(f.read({ path: "empty.txt" })), "MAIL_SOURCE_EMPTY");
  // A project without a grant is refused, also by absolute path.
  f.access({ projectFiles: {} });
  assert.equal(
    await code(f.read({ path: "docs/r.pdf", projectId: f.folderProject.id })),
    "PROJECT_NOT_GRANTED",
  );
  assert.equal(await code(f.read({ path: f.proj("docs/r.pdf") })), "MAIL_SOURCE_REFUSED");
});

test("with approval the shell level does not widen sources", async (t) => {
  const f = await setup(t, { shell: "approval" });
  assert.equal(f.files().shell, "approval");
  const host = f.file(path.join(hostDir(t), "host.txt"));
  assert.equal(await code(f.read({ path: host })), "MAIL_SOURCE_REFUSED");
  f.file(f.ws("a.txt"));
  assert.equal((await f.read({ path: f.ws("a.txt") })).source.kind, "workspace");
});

test("full shell reads host files but never .git, data dir or links", async (t) => {
  const f = await setup(t, { shell: "full" });
  assert.equal(f.files().shell, "full");
  const dir = hostDir(t);
  const host = f.file(path.join(dir, "report.docx"), "docx");
  const read = await f.read({ path: host });
  assert.deepEqual(read.source, { kind: "host", path: host });
  assert.equal(
    read.type,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );

  const refusedPaths = [
    f.file(path.join(dir, ".git", "config")),
    f.file(path.join(dir, "Repo", ".GIT", "HEAD")),
  ];
  const dataDir = fs.realpathSync(f.dataDir);
  const accounts = path.join(dataDir, "mail", "accounts.json");
  assert.ok(fs.existsSync(accounts), "the mail store keeps its accounts file");
  refusedPaths.push(accounts, f.file(path.join(dataDir, "other.txt")));
  const link = path.join(dir, "link.txt");
  fs.symlinkSync(host, link);
  const linkedDir = path.join(dir, "linked");
  fs.symlinkSync(dir, linkedDir);
  const hard = path.join(dir, "hard.txt");
  fs.linkSync(f.file(path.join(dir, "original.txt")), hard);
  refusedPaths.push(link, path.join(linkedDir, "report.docx"), hard);
  for (const refused of refusedPaths)
    assert.equal(await code(f.read({ path: refused })), "MAIL_SOURCE_REFUSED", refused);

  // Links and .git are refused in the workspace and the project too.
  fs.symlinkSync(host, f.ws("out.txt"));
  f.file(f.ws(".git/config"));
  assert.equal(await code(f.read({ path: "out.txt" })), "MAIL_SOURCE_REFUSED");
  assert.equal(await code(f.read({ path: ".git/config" })), "MAIL_SOURCE_REFUSED");
  f.access({ shell: "full", projectFiles: { [f.folderProject.id]: "read" } });
  fs.symlinkSync(host, f.proj("out.txt"));
  f.file(f.proj(".git/config"));
  for (const p of ["out.txt", ".git/config"])
    assert.equal(
      await code(f.read({ path: p, projectId: f.folderProject.id })),
      "MAIL_SOURCE_REFUSED",
    );

  f.file(f.ws("notes/a.csv"), "a,b");
  const own = await f.read({ path: f.ws("notes/a.csv") });
  assert.deepEqual(own.source, { kind: "workspace", path: "notes/a.csv" });
  assert.equal(own.type, "text/csv");
});

test("traversal stays refused", async (t) => {
  const f = await setup(t, { projectFiles: {} });
  f.access({ projectFiles: { [f.folderProject.id]: "read" } });
  f.file(path.join(f.workspaces, "other-agent", "x"), "secret");
  f.file(path.join(f.base, "outside.txt"));
  for (const entry of [
    { path: "../other-agent/x" },
    { path: "notes/../../other-agent/x" },
    { path: path.join(f.workspace, "..", "other-agent", "x") },
    { path: "../../etc/passwd", projectId: f.folderProject.id },
    { path: "../outside.txt", projectId: f.folderProject.id },
  ])
    assert.equal(await code(f.read(entry)), "MAIL_SOURCE_REFUSED", entry.path);
});

test("malformed entries are invalid input", async (t) => {
  const f = await setup(t);
  f.file(f.ws("a.txt"));
  for (const entry of [
    { path: "a\u0000.txt" },
    { path: "a\n.txt" },
    { path: "a\u0085.txt" },
    { path: "" },
    { path: "   " },
    { projectId: f.folderProject.id },
    { path: "a.txt", projectId: 7 },
  ])
    assert.equal(await code(f.read(entry)), "INVALID_INPUT", JSON.stringify(entry));
  const files = f.files();
  // The same file twice, also spelled once relative and once absolute.
  for (const list of [
    [{ path: "a.txt" }, { path: "a.txt" }],
    [{ path: "a.txt" }, { path: f.ws("a.txt") }],
    Array.from({ length: 21 }, (_, i) => ({ path: `f${i}.txt` })),
  ])
    assert.equal(await code(readSources(f.workflows, files, list)), "INVALID_INPUT");
});

test("sources over 25 MB in total are refused", async (t) => {
  const f = await setup(t);
  const big = Buffer.alloc(13 * 1024 * 1024, 1);
  f.file(f.ws("one.bin"), big);
  f.file(f.ws("two.bin"), big);
  const files = f.files();
  const one = await readSources(f.workflows, files, [{ path: "one.bin" }]);
  assert.equal(one.length, 1);
  assert.equal(one[0].type, "application/octet-stream");
  assert.equal(
    await code(
      readSources(f.workflows, files, [{ path: "one.bin" }, { path: "two.bin" }]),
    ),
    "MAIL_ATTACHMENT_TOO_LARGE",
  );
  assert.equal(
    await code(readSource(f.workflows, files, { path: "one.bin" }, { maxBytes: 1024 })),
    "MAIL_ATTACHMENT_TOO_LARGE",
  );
});

test("a mail-result follow-up attaches from its workspace only", async (t) => {
  const f = await setup(t, { projectFiles: {} });
  f.access({ projectFiles: { [f.folderProject.id]: "read" } });
  const inv = f.ownTurn({ kind: "mail-result", actionId: "a1" });
  const files = f.files(inv);
  assert.deepEqual(files.ctx, { assistantId: f.id, workspaceOnly: true });
  f.file(f.ws("a.txt"));
  f.file(f.proj("r.pdf"));
  assert.equal((await f.read({ path: "a.txt" }, inv)).source.kind, "workspace");
  assert.equal(
    await code(f.read({ path: "r.pdf", projectId: f.folderProject.id }, inv)),
    "PROJECT_NOT_GRANTED",
  );
  assert.equal(await code(f.read({ path: f.proj("r.pdf") }, inv)), "MAIL_SOURCE_REFUSED");
  assert.deepEqual(storedFiles(files), {
    context: { assistantId: f.id, workspaceOnly: true },
    shell: "off",
  });
  const project = { kind: "project", projectId: f.folderProject.id, path: "r.pdf" };
  assert.equal(sourceAllowed(f.workflows, f.id, storedFiles(files), project), false);
});

test("a hook run attaches with the hook's live shell level", async (t) => {
  const f = await setup(t, { shell: "full" });
  const inv = f.hookTurn();
  f.hook.shell = undefined;
  const runOrigin = f.assistants.routines.hooks.runOrigin;
  f.assistants.routines.hooks.runOrigin = (agent, key) => {
    const run = runOrigin(agent, key);
    return (
      run && {
        ...run,
        conversation: { id: f.channel.conversationId },
        effective: { ...run.effective, folders: {}, shell: f.hook.shell },
      }
    );
  };
  assert.equal(f.files(inv).shell, "off");
  f.hook.shell = "full";
  assert.equal(f.files(inv).shell, "full");
  f.hook.running = false;
  assert.throws(
    () => f.files(inv),
    (error) => toolError(error).status === 403,
  );
});

test("sourceAllowed follows a revoked project and a lowered shell", async (t) => {
  const f = await setup(t, { shell: "full" });
  f.access({ shell: "full", projectFiles: { [f.folderProject.id]: "read" } });
  f.file(f.proj("r.pdf"));
  const host = f.file(path.join(hostDir(t), "h.txt"));
  const files = f.files();
  const project = (await f.read({ path: "r.pdf", projectId: f.folderProject.id })).source;
  const fromHost = (await f.read({ path: host })).source;
  const workspace = { kind: "workspace", path: "a.txt" };
  const stored = JSON.parse(JSON.stringify(storedFiles(files)));
  assert.equal(stored.shell, "full");
  assert.equal(stored.context.assistantId, f.id);
  assert.equal(sourceAllowed(f.workflows, f.id, stored, workspace), true);
  assert.equal(sourceAllowed(f.workflows, f.id, stored, project), true);
  assert.equal(sourceAllowed(f.workflows, f.id, stored, fromHost), true);
  assert.equal(sourceAllowed(f.workflows, f.id, stored, { kind: "other" }), false);

  f.access({ shell: "full", projectFiles: {} });
  assert.equal(sourceAllowed(f.workflows, f.id, stored, project), false);
  assert.equal(sourceAllowed(f.workflows, f.id, stored, fromHost), true);
  f.access({ shell: "approval" });
  assert.equal(sourceAllowed(f.workflows, f.id, stored, fromHost), false);
  // A capture under With approval never allows a host file later.
  f.access({ shell: "full" });
  assert.equal(
    sourceAllowed(f.workflows, f.id, { ...stored, shell: "approval" }, fromHost),
    false,
  );
});

test("the attachment type table maps the agreed extensions", () => {
  assert.equal(mailFileType("A.PDF"), "application/pdf");
  assert.equal(
    mailFileType("s.xlsx"),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  assert.equal(
    mailFileType("p.pptx"),
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  );
  assert.equal(mailFileType("i.png"), "image/png");
  assert.equal(mailFileType("i.jpg"), "image/jpeg");
  assert.equal(mailFileType("noext"), "application/octet-stream");
  assert.equal(mailFileType("x.constructor"), "application/octet-stream");
});
