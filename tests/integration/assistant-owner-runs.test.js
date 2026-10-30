import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { agentRunFixture } from "../helpers/agent-run-fixture.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";

// AGENTPIER-276: the owner's own agents are not blocked by the origin of a run. Every
// run of the owner's chat (their turns, check-ins and reminders, OpenClaw's follow-up
// after a background command) works on the agent's standing grants for project
// folders and memory; forwarded content, members' content and user agents keep
// their limits.
async function setup(t, options) {
  const f = await agentRunFixture(t, options);
  // A project folder outside AgentPier's data (project-paths.js refuses that).
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "owner-run-")));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const project = await f.memory.register(folder);
  // A user agent holds no projects (user-agent-lock.js).
  if (!options?.userAccess)
    f.workflows.access.save(
      f.id,
      {
        ...f.policy,
        projectIds: [project.id],
        projectFiles: { [project.id]: "write" },
      },
      f.workflows.access.get(f.id).revision,
    );
  f.assistants.config = { ...f.assistants.config, writeGuard: () => true };
  // As the plugin prepares and invokes a workspace call of a run of this session.
  const workspace = async (input, runId = "turn-1") => {
    const { ticket } = await f.bridge.prepare({
      agentId: f.agentId,
      sessionKey: "session",
      toolCallId: randomUUID(),
      action: "workspace",
      ...(runId ? { runId } : {}),
    });
    return f.bridge.invoke({ ticket, action: "workspace", input });
  };
  const write = (name = "notes/render.md") =>
    workspace({
      action: "file_write",
      projectId: project.id,
      path: name,
      content: "RENDERED\n",
    });
  return { ...f, project, workspace, write };
}
const forbidden = (error) => toolError(error).code === "FORBIDDEN";

test("a follow-up run writes after any turn of the owner's own", async (t) => {
  for (const origin of [
    { kind: "owner" },
    { kind: "telegram" },
    { kind: "reminder" },
    { kind: "member-result", requestId: "r9" },
    { kind: "unknown" },
  ]) {
    const f = await setup(t);
    await f.turn(origin);
    const ctx = await f.eventTurn();
    assert.equal(await f.call("notes.md", { ctx }), true, JSON.stringify(origin));
    assert.equal(await f.call("MEMORY.md", { ctx, toolName: "edit" }), true);
    assert.deepEqual(f.writes(), ["notes.md", "MEMORY.md"]);
    // Any run of the chat, also one that reports no run id.
    assert.equal(await f.call("later.md", { ctx: { ...ctx, runId: undefined } }), true);
  }
});

test("a follow-up run reaches the agent's project folders and its catalog", async (t) => {
  const f = await setup(t);
  await f.turn({ kind: "owner" });
  await f.eventTurn();
  const catalog = await f.workspace({ action: "catalog" });
  assert.deepEqual(
    catalog.projects.find((p) => p.id === f.project.id).folder.access,
    "write",
  );
  const written = await f.write();
  assert.equal(written.access, "write");
  assert.equal(
    fs.readFileSync(path.join(f.project.cwd, "notes/render.md"), "utf8"),
    "RENDERED\n",
  );
  const read = await f.workspace({
    action: "file_read",
    projectId: f.project.id,
    path: "notes/render.md",
  });
  assert.match(read.content, /RENDERED/);
  const audit = f.audits.find((e) => e.details?.kind === "project-file");
  assert.equal(audit.details.via, "agent-run");
  assert.equal(audit.details.filePath, "notes/render.md");
});

test("someone else's content and user agents keep their limits", async (t) => {
  for (const origin of [
    { kind: "owner", forwarded: true },
    { kind: "member-report", requestId: "r1" },
  ]) {
    const f = await setup(t);
    await f.turn(origin);
    const ctx = await f.eventTurn();
    assert.equal(await f.call("notes.md", { ctx }), false, JSON.stringify(origin));
    await assert.rejects(f.write(), forbidden);
    // A newer owner turn ends it: the chat works for the owner again.
    await f.turn({ kind: "owner" }, { exec: false });
    assert.equal(await f.call("notes.md", { ctx }), true);
  }
  const userAccess = {
    mode: "own",
    members: [{ userId: "anna", level: "chat" }],
    released: [],
  };
  const f = await setup(t, { userAccess });
  await f.turn({ kind: "owner" });
  const ctx = await f.eventTurn();
  assert.equal(await f.call("notes.md", { ctx }), false);
  await assert.rejects(f.workspace({ action: "catalog" }), { status: 403 });
});

test("a reminder's turn of the owner's chat works like their own", async (t) => {
  const f = await setup(t);
  const inv = await f.invocation(randomUUID(), { kind: "reminder" });
  const result = await f.workflows.invoke(inv, {
    action: "files_list",
    projectId: f.project.id,
  });
  assert.equal(result.access, "write");
  const forwarded = await f.invocation(randomUUID(), { kind: "owner", forwarded: true });
  await assert.rejects(
    f.workflows.invoke(forwarded, { action: "files_list", projectId: f.project.id }),
    { status: 403 },
  );
});
