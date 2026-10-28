import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mailFilesFixture } from "../helpers/mail-files-fixture.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import { fileContext } from "../../server/features/assistants/mail/agent-mail-sources.js";
import {
  saveTarget,
  writeNewFile,
} from "../../server/features/assistants/mail/agent-mail-files.js";

const darwin = process.platform === "darwin";
const firmlink = "/System/Volumes/Data";
// The same folder through a firmlink, when this Mac has one for it.
const viaFirmlink = (file) => (fs.existsSync(firmlink + file) ? firmlink + file : null);

async function code(action) {
  try {
    await action();
  } catch (error) {
    return toolError(error).code;
  }
  assert.fail("the save succeeded");
}

async function setup(t, options = {}) {
  const f = await mailFilesFixture(t);
  f.access(options);
  const files = (inv = f.ownTurn()) =>
    fileContext(f.workflows, inv, f.workflows.mail.caller(inv));
  const target = (input = {}, inv) =>
    saveTarget(f.workflows, files(inv), { accountName: "Private", ...input });
  const save = async (name, bytes, input, inv) =>
    writeNewFile(target(input, inv), name, Buffer.from(bytes));
  const dataDir = fs.realpathSync(f.dataDir);
  return { ...f, files, target, save, dataDir };
}

// A folder outside the workspace, the project and AgentPier's data directory.
function outsideDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mail-save-out-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const entries = (dir) => fs.readdirSync(dir).sort();

test("a workspace save lands in mail/<account> and never overwrites", async (t) => {
  const f = await setup(t);
  const target = f.target();
  assert.equal(target.workspace, true);
  assert.equal(target.projectId, null);
  assert.equal(target.folder.relative, "mail/Private");
  assert.equal(target.root, fs.realpathSync(f.workspace));

  assert.deepEqual(await f.save("invoice.pdf", "first"), {
    path: "mail/Private/invoice.pdf",
  });
  assert.deepEqual(await f.save("invoice.pdf", "second"), {
    path: "mail/Private/invoice (2).pdf",
  });
  assert.deepEqual(await f.save("invoice.pdf", "third"), {
    path: "mail/Private/invoice (3).pdf",
  });
  const folder = f.ws("mail/Private");
  assert.equal(fs.readFileSync(path.join(folder, "invoice.pdf"), "utf8"), "first");
  assert.equal(fs.readFileSync(path.join(folder, "invoice (2).pdf"), "utf8"), "second");
  // Only the saved files remain: no temporary file, one link each, no executable bit.
  assert.deepEqual(entries(folder), [
    "invoice (2).pdf",
    "invoice (3).pdf",
    "invoice.pdf",
  ]);
  const stat = fs.statSync(path.join(folder, "invoice.pdf"));
  assert.equal(stat.nlink, 1);
  assert.equal(stat.mode & 0o777, 0o600);

  // A folder below mail/ given by path, relative or absolute; the account name is
  // made safe for the default folder.
  assert.deepEqual(await f.save("a.txt", "x", { path: "mail/in/2026" }), {
    path: "mail/in/2026/a.txt",
  });
  assert.deepEqual(await f.save("a.txt", "x", { path: f.ws("mail") }), {
    path: "mail/a.txt",
  });
  assert.equal(
    f.target({ accountName: "../.Team‮: Mail" }).folder.relative,
    "mail/Team_ Mail",
  );
});

test("an existing entry of any kind is never replaced", async (t) => {
  const f = await setup(t);
  const outside = outsideDir(t);
  const folder = f.ws("mail/Private");
  fs.mkdirSync(folder, { recursive: true });
  fs.symlinkSync(path.join(outside, "planted.pdf"), path.join(folder, "a.pdf"));
  fs.mkdirSync(path.join(folder, "a (2).pdf"));
  assert.deepEqual(await f.save("a.pdf", "data"), { path: "mail/Private/a (3).pdf" });
  assert.deepEqual(entries(outside), []);
  assert.equal(fs.lstatSync(path.join(folder, "a.pdf")).isSymbolicLink(), true);
});

test("a workspace path outside mail/ is refused", async (t) => {
  const f = await setup(t);
  for (const requested of [
    "skills",
    "AGENTS.md",
    "SOUL.md",
    ".agents",
    ".agentpier",
    "attachments/x",
    "../x",
    "mailbox",
    "Mail",
    ".",
    f.workspace,
    path.join(f.workspaces, "other-agent", "mail"),
    "/tmp",
  ])
    assert.equal(
      await code(() => f.save("a.txt", "x", { path: requested })),
      "MAIL_SAVE_REFUSED",
      requested,
    );
  for (const top of ["skills", "attachments", ".agentpier"])
    assert.equal(fs.existsSync(f.ws(top)), false, top);
  // A link inside the workspace that leads out of mail/ counts where it leads.
  fs.mkdirSync(f.ws("skills"));
  fs.mkdirSync(f.ws("mail"));
  fs.symlinkSync(f.ws("skills"), f.ws("mail/skills"));
  assert.equal(
    await code(() => f.save("a.txt", "x", { path: "mail/skills" })),
    "MAIL_SAVE_REFUSED",
  );
  assert.deepEqual(entries(f.ws("skills")), []);
});

test("a link swapped into the destination is refused", async (t) => {
  const f = await setup(t);
  const outside = outsideDir(t);
  fs.symlinkSync(outside, f.ws("mail"));
  assert.equal(await code(() => f.save("a.txt", "x")), "MAIL_SAVE_REFUSED");
  fs.unlinkSync(f.ws("mail"));
  // A folder swapped for a link between choosing the target and the write.
  const target = f.target();
  fs.symlinkSync(outside, f.ws("mail"));
  assert.equal(
    await code(() => writeNewFile(target, "a.txt", Buffer.from("x"))),
    "MAIL_SAVE_REFUSED",
  );
  fs.unlinkSync(f.ws("mail"));
  fs.mkdirSync(f.ws("mail"));
  const deeper = f.target();
  fs.symlinkSync(outside, f.ws("mail/Private"));
  assert.equal(
    await code(() => writeNewFile(deeper, "a.txt", Buffer.from("x"))),
    "MAIL_SAVE_REFUSED",
  );
  assert.deepEqual(entries(outside), []);
  // A file where the folder should be.
  fs.unlinkSync(f.ws("mail/Private"));
  fs.writeFileSync(f.ws("mail/Private"), "file");
  assert.equal(await code(() => f.save("a.txt", "x")), "MAIL_SAVE_REFUSED");
});

test("a name that is not a safe name is refused", async (t) => {
  const f = await setup(t);
  const target = f.target();
  for (const name of ["", "../a.txt", ".hidden", "a/b", "CON.txt", "a‮.txt", 7])
    assert.equal(
      await code(() => writeNewFile(target, name, Buffer.from("x"))),
      "MAIL_SAVE_REFUSED",
      String(name),
    );
  assert.equal(fs.existsSync(f.ws("mail")), false);
});

test("a project save follows the reserved paths", async (t) => {
  const f = await setup(t, { projectFiles: {} });
  const id = f.folderProject.id;
  f.access({ projectFiles: { [id]: "write" } });
  fs.mkdirSync(f.proj(".git"));
  for (const requested of [
    ".git/x",
    ".GIT",
    ".claude",
    ".vscode",
    "AGENTS.md",
    "docs/.husky",
    "../x",
    "a\\b",
    path.join(f.base, "elsewhere"),
  ])
    assert.equal(
      await code(() => f.save("a.txt", "x", { projectId: id, path: requested })),
      "MAIL_SAVE_REFUSED",
      requested,
    );
  const target = f.target({ projectId: id, path: "docs/in" });
  assert.equal(target.workspace, false);
  assert.equal(target.projectId, id);
  assert.equal(target.projectName, f.folderProject.name);
  assert.deepEqual(target.protectedRoots, f.workflows.folders.protectedRoots);
  assert.deepEqual(await writeNewFile(target, "r.pdf", Buffer.from("%PDF")), {
    path: "docs/in/r.pdf",
  });
  assert.deepEqual(await writeNewFile(target, "r.pdf", Buffer.from("again")), {
    path: "docs/in/r (2).pdf",
  });
  assert.equal(fs.readFileSync(f.proj("docs/in/r.pdf"), "utf8"), "%PDF");
  // An instruction file or tool configuration as the file name is refused too.
  for (const name of ["CLAUDE.md", "AGENTS.md", "mise.toml", "lefthook.yml"])
    assert.equal(
      await code(() => writeNewFile(target, name, Buffer.from("x"))),
      "MAIL_SAVE_REFUSED",
      name,
    );
  assert.deepEqual(entries(f.proj("docs/in")), ["r (2).pdf", "r.pdf"]);
  assert.deepEqual(entries(f.proj(".git")), []);
});

test("a read-only project grant cannot save", async (t) => {
  const f = await setup(t, { projectFiles: {} });
  const id = f.folderProject.id;
  f.access({ projectFiles: { [id]: "read" } });
  assert.equal(
    await code(() => f.save("a.txt", "x", { projectId: id, path: "docs" })),
    "PROJECT_READ_ONLY",
  );
  f.access({ projectFiles: {} });
  assert.equal(
    await code(() => f.save("a.txt", "x", { projectId: id, path: "docs" })),
    "PROJECT_NOT_GRANTED",
  );
  f.access({ projectFiles: { [id]: "write" } });
  f.guard.live = false;
  assert.equal(
    await code(() => f.save("a.txt", "x", { projectId: id, path: "docs" })),
    "PROJECT_WRITE_UNAVAILABLE",
  );
  assert.equal(fs.existsSync(f.proj("docs")), false);
});

test("a hook run cannot save to the workspace", async (t) => {
  const f = await setup(t);
  const inv = f.hookTurn();
  const runOrigin = f.assistants.routines.hooks.runOrigin;
  f.assistants.routines.hooks.runOrigin = (agent, key) => {
    const run = runOrigin(agent, key);
    return run && { ...run, conversation: { id: f.channel.conversationId } };
  };
  assert.ok(f.files(inv).ctx.hook);
  assert.equal(await code(() => f.save("a.txt", "x", {}, inv)), "MAIL_SAVE_REFUSED");
  assert.equal(fs.existsSync(f.ws("mail")), false);
});

test("a follow-up without its turn's context saves to its workspace only", async (t) => {
  const f = await setup(t, { projectFiles: {} });
  const id = f.folderProject.id;
  f.access({ projectFiles: { [id]: "write" } });
  const inv = f.ownTurn({ kind: "mail-result", actionId: "a1" });
  assert.equal(f.files(inv).ctx.workspaceOnly, true);
  assert.equal(
    await code(() => f.save("a.txt", "x", { projectId: id, path: "docs" }, inv)),
    "MAIL_SAVE_REFUSED",
  );
  assert.deepEqual(await f.save("a.txt", "x", {}, inv), { path: "mail/Private/a.txt" });
  assert.equal(fs.existsSync(f.proj("docs")), false);
});

test("malformed save input is invalid", async (t) => {
  const f = await setup(t, { projectFiles: {} });
  const id = f.folderProject.id;
  f.access({ projectFiles: { [id]: "write" } });
  for (const input of [
    { path: "mail/a\u0000b" },
    { path: "mail/a\nb" },
    { path: "mail/‮b" },
    { path: " " },
    { path: 7 },
    { projectId: id },
    { projectId: 7, path: "docs" },
  ])
    assert.equal(
      await code(() => f.target(input)),
      "INVALID_INPUT",
      JSON.stringify(input),
    );
});

test("a project in AgentPier's data directory is refused by identity", async (t) => {
  const f = await setup(t, { projectFiles: {} });
  const project = f.folderProject;
  const lookup = f.workflows.s.memory.project.bind(f.workflows.s.memory);
  let spelled;
  f.workflows.s.memory.project = (id) =>
    id === project.id ? { ...lookup(id), cwd: spelled } : lookup(id);
  f.access({ projectFiles: { [project.id]: "write" } });
  const parent = path.dirname(f.dataDir);
  const name = path.basename(f.dataDir);
  const cases = [
    [f.dataDir, "mail"],
    [path.join(f.dataDir, "mail"), "x"],
    [parent, `${name}/mail`],
    ...(darwin
      ? [
          [f.dataDir.toUpperCase(), "mail"],
          [parent.toUpperCase(), `${name.toUpperCase()}/mail`],
          // Through a firmlink: no spelling of the data directory matches.
          [viaFirmlink(f.dataDir), "mail"],
          [viaFirmlink(path.join(f.dataDir, "mail")), "x"],
          // The root passes; a folder walked below it is the data directory.
          [viaFirmlink(parent), `${name}/mail`],
        ].filter(([root]) => root)
      : []),
  ];
  fs.mkdirSync(path.join(f.dataDir, "mail"), { recursive: true });
  const before = entries(path.join(f.dataDir, "mail"));
  for (const [root, requested] of cases) {
    spelled = root;
    assert.equal(
      await code(() => f.save("a.txt", "x", { projectId: project.id, path: requested })),
      "MAIL_SAVE_REFUSED",
      `${root} ${requested}`,
    );
    // A missing file below it answers the same: no existence oracle.
    assert.equal(
      await code(() =>
        f.save("a.txt", "x", { projectId: project.id, path: `${requested}/missing` }),
      ),
      "MAIL_SAVE_REFUSED",
    );
  }
  assert.deepEqual(entries(path.join(f.dataDir, "mail")), before);
});

test("a folder walked that is the data directory by identity is refused", async (t) => {
  const f = await setup(t);
  // A folder on the way with the data directory's device and inode, whatever its
  // spelling (as through a firmlink): the walk compares every folder it creates or
  // passes.
  const chosen = f.target();
  fs.mkdirSync(f.ws("mail/Private"), { recursive: true });
  const stat = fs.statSync(f.ws("mail"), { bigint: true });
  const target = Object.defineProperty({ ...chosen }, "refuseDirs", {
    value: [{ dev: stat.dev, ino: stat.ino }],
  });
  assert.equal(
    await code(() => writeNewFile(target, "a.txt", Buffer.from("x"))),
    "MAIL_SAVE_REFUSED",
  );
  assert.deepEqual(entries(f.ws("mail/Private")), []);
});
