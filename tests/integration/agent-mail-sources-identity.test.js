import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mailFilesFixture } from "../helpers/mail-files-fixture.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import { personalShell } from "../../server/features/assistants/native-capabilities.js";
import { AgentHooks } from "../../server/features/assistants/agent-hooks.js";
import {
  effectiveRights,
  storedRights,
} from "../../server/features/assistants/agent-hook-rights.js";
import {
  fileContext,
  readSource,
  readSources,
  sourceAllowed,
  storedFiles,
} from "../../server/features/assistants/mail/agent-mail-sources.js";

// The data directory and hook captures: AgentPier's data is recognised by device and
// inode on every folder walked, and a hook run's capture stays within the hook.
const darwin = process.platform === "darwin";
const firmlink = "/System/Volumes/Data";

async function code(promise) {
  try {
    await promise;
  } catch (error) {
    return toolError(error).code;
  }
  assert.fail("the read succeeded");
}

async function setup(t, options = {}, fixture = {}) {
  const f = await mailFilesFixture(t, fixture);
  f.access(options);
  const files = (inv = f.ownTurn()) =>
    fileContext(f.workflows, inv, f.workflows.mail.caller(inv));
  const read = (entry, inv) =>
    readSource(f.workflows, files(inv), entry, { maxBytes: 26_214_400 });
  const dataDir = fs.realpathSync(f.dataDir);
  const secret = f.file(path.join(dataDir, "mail", "secret.txt"), "sealed");
  return { ...f, files, read, dataDir, secret };
}

// The same folder through a firmlink, when this Mac has one for it.
function viaFirmlink(file) {
  const spelled = firmlink + file;
  return fs.existsSync(spelled) ? spelled : null;
}

test(
  "full shell never reads the data directory in another case",
  { skip: !darwin },
  async (t) => {
    const f = await setup(t, { shell: "full" });
    const upper = f.secret.toUpperCase();
    assert.ok(fs.existsSync(upper), "the file system ignores case");
    assert.equal(await code(f.read({ path: upper })), "MAIL_SOURCE_REFUSED");
    // Mixed case of only the data directory's own name.
    const mixed = path.join(
      path.dirname(f.dataDir),
      path.basename(f.dataDir).toUpperCase(),
      "mail",
      "secret.txt",
    );
    assert.equal(await code(f.read({ path: mixed })), "MAIL_SOURCE_REFUSED");
  },
);

test(
  "full shell never reads the data directory through a firmlink",
  { skip: !darwin },
  async (t) => {
    const f = await setup(t, { shell: "full" });
    const spelled = viaFirmlink(f.secret);
    if (!spelled) return t.skip("no /System/Volumes/Data firmlink here");
    assert.equal(fs.readFileSync(spelled, "utf8"), "sealed");
    assert.equal(await code(f.read({ path: spelled })), "MAIL_SOURCE_REFUSED");
  },
);

test(
  "a project spelled through a firmlink or in another case opens no way into the data directory",
  { skip: !darwin },
  async (t) => {
    const f = await setup(t);
    const parent = path.dirname(f.dataDir);
    const below = path.join(path.basename(f.dataDir), "mail", "secret.txt");
    const inside = path.join("mail", "secret.txt");
    // The granted project's folder as registered with another spelling of the data
    // directory's parent, or of the data directory itself (a temp folder cannot be
    // registered, so the lookup answers with the spelling).
    const project = f.folderProject;
    const lookup = f.workflows.s.memory.project.bind(f.workflows.s.memory);
    let spelled;
    f.workflows.s.memory.project = (id) =>
      id === project.id ? { ...lookup(id), cwd: spelled } : lookup(id);
    f.access({ projectFiles: { [project.id]: "read" } });
    const cases = [
      [viaFirmlink(parent), below],
      [parent.toUpperCase(), below],
      [viaFirmlink(f.dataDir), inside],
      [f.dataDir.toUpperCase(), inside],
      // A folder below the data directory: only its ancestors name the data.
      [viaFirmlink(path.join(f.dataDir, "mail")), "secret.txt"],
    ].filter(([root]) => root);
    assert.ok(cases.length >= 2);
    for (const [root, relative] of cases) {
      spelled = root;
      assert.equal(f.workflows.s.memory.project(project.id).cwd, spelled);
      assert.equal(f.files().shell, "off");
      assert.equal(
        await code(f.read({ path: relative, projectId: project.id })),
        "MAIL_SOURCE_REFUSED",
        spelled,
      );
      assert.equal(
        await code(f.read({ path: path.join(spelled, relative) })),
        "MAIL_SOURCE_REFUSED",
        spelled,
      );
    }
  },
);

test("with workspaces in the data directory full shell reads only its own", async (t) => {
  const f = await setup(t, { shell: "full" }, { workspacesInData: true });
  assert.ok(f.workspace.startsWith(f.dataDir + path.sep));
  f.file(f.ws("own.txt"), "mine");
  const other = f.file(path.join(f.workspaces, "other-agent", "x.txt"), "theirs");
  assert.deepEqual((await f.read({ path: f.ws("own.txt") })).source, {
    kind: "workspace",
    path: "own.txt",
  });
  assert.equal((await f.read({ path: "own.txt" })).source.kind, "workspace");
  assert.equal(await code(f.read({ path: other })), "MAIL_SOURCE_REFUSED");
  assert.equal(await code(f.read({ path: f.secret })), "MAIL_SOURCE_REFUSED");
  assert.equal(
    await code(f.read({ path: "../other-agent/x.txt" })),
    "MAIL_SOURCE_REFUSED",
  );
});

test("the same host file twice is a duplicate by device and inode", async (t) => {
  const f = await setup(t, { shell: "full" });
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mail-host-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const host = f.file(path.join(dir, "a.txt"));
  const respelled = path.join(dir, ".", "a.txt").replace(dir, `${dir}//`);
  assert.notEqual(respelled, host);
  assert.equal(
    await code(
      readSources(f.workflows, f.files(), [{ path: host }, { path: respelled }]),
    ),
    "INVALID_INPUT",
  );
  const own = f.file(f.ws("b.txt"));
  assert.equal(
    await code(
      readSources(f.workflows, f.files(), [
        { path: "b.txt" },
        { path: `${f.workspace}//b.txt` },
      ]),
    ),
    "INVALID_INPUT",
  );
  assert.equal(
    (await readSources(f.workflows, f.files(), [{ path: own }, { path: host }])).length,
    2,
  );
});

test("format and bidi characters in a path are invalid input", async (t) => {
  const f = await setup(t);
  for (const p of ["a‮.txt", "a​.txt", "a⁦.txt", "﻿a.txt"])
    assert.equal(await code(f.read({ path: p })), "INVALID_INPUT", JSON.stringify(p));
});

test("a hook run's capture stays within the hook's live rights", async (t) => {
  const f = await setup(t, { shell: "full" });
  f.access({ shell: "full", projectFiles: { [f.folderProject.id]: "read" } });
  const hook = {
    id: "hook-1",
    assistantId: f.id,
    enabled: true,
    rights: storedRights({ shell: "full", folders: { [f.folderProject.id]: "read" } }),
  };
  const hooks = f.assistants.routines.hooks;
  const runOrigin = hooks.runOrigin;
  const live = (agent) =>
    effectiveRights(hook.rights, {
      folders: f.workflows.folders.ownAndShared(agent.id),
      shell: personalShell(agent),
      sshHosts: [],
    });
  hooks.runOrigin = (agent, key) => {
    const run = runOrigin(agent, key);
    return (
      run && {
        ...run,
        conversation: { id: f.channel.conversationId },
        effective: { ...run.effective, ...live(agent) },
      }
    );
  };
  hooks.liveRights = (agent, hookId) =>
    hookId === hook.id && hook.enabled && agent.id === hook.assistantId
      ? live(agent)
      : null;

  f.file(f.proj("r.pdf"));
  const host = f.file(path.join(f.base, "h.txt"));
  const inv = f.hookTurn();
  const files = f.files(inv);
  assert.equal(files.shell, "full");
  const project = (await f.read({ path: "r.pdf", projectId: f.folderProject.id }, inv))
    .source;
  const fromHost = (await f.read({ path: host }, inv)).source;
  const workspace = { kind: "workspace", path: "a.txt" };
  const stored = JSON.parse(JSON.stringify(storedFiles(files)));
  assert.deepEqual(stored.context, {
    assistantId: f.id,
    hook: { hookId: "hook-1", folders: { [f.folderProject.id]: "read" } },
  });
  const allowed = (source, s = stored) => sourceAllowed(f.workflows, f.id, s, source);
  assert.equal(allowed(project), true);
  assert.equal(allowed(fromHost), true);
  assert.equal(allowed(workspace), true);

  // The hook loses the folder while the agent keeps it.
  hook.rights = storedRights({ shell: "full", folders: {} });
  assert.ok(f.workflows.folders.ownAndShared(f.id)[f.folderProject.id]);
  assert.equal(allowed(project), false);
  assert.equal(allowed(fromHost), true);
  // The hook loses Full access while the agent keeps it.
  hook.rights = storedRights({ shell: "off", folders: { [f.folderProject.id]: "read" } });
  assert.equal(personalShell(f.store.getAssistant(f.id)), "full");
  assert.equal(allowed(fromHost), false);
  assert.equal(allowed(project), true);
  // A folder the capture did not hold is never allowed, whatever the hook holds now.
  const narrower = {
    ...stored,
    context: { ...stored.context, hook: { hookId: "hook-1", folders: {} } },
  };
  assert.equal(allowed(project, narrower), false);
  // A paused or deleted hook allows nothing.
  hook.enabled = false;
  for (const source of [workspace, project, fromHost])
    assert.equal(allowed(source), false);
  hook.enabled = true;
  delete hooks.liveRights;
  assert.equal(allowed(workspace), false);
});

test("AgentHooks.liveRights caps a hook by its agent and refuses a gone hook", () => {
  const agent = { id: "agent-1", capabilities: { reminders: true } };
  const hook = {
    id: "hook-1",
    assistantId: agent.id,
    enabled: true,
    rights: storedRights({ shell: "full", folders: { p1: "write", p2: "read" } }),
  };
  const self = {
    store: { get: (id) => (id === hook.id ? hook : null) },
    ceiling: () => ({ ...ceiling }),
  };
  let ceiling = { shell: "full", folders: { p1: "read" }, sshHosts: [] };
  const live = (a = agent, id = hook.id) =>
    AgentHooks.prototype.liveRights.call(self, a, id);
  assert.deepEqual(live().folders, { p1: "read" });
  assert.equal(live().shell, "full");
  ceiling = { shell: "approval", folders: {}, sshHosts: [] };
  assert.equal(live().shell, "approval");
  assert.deepEqual(live().folders, {});
  assert.equal(live(agent, "other"), null);
  assert.equal(live(agent, null), null);
  assert.equal(live({ ...agent, id: "agent-2" }), null);
  assert.equal(live({ ...agent, archivedAt: "2026-10-28T00:00:00Z" }), null);
  hook.enabled = false;
  assert.equal(live(), null);
});
