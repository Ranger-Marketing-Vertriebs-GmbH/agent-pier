import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { leadShareFixture } from "../helpers/lead-share-fixture.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import { routineTools } from "../../server/features/assistants/native-capabilities.js";

const code = (key) => (error) => toolError(error).code === key;

// The lead "Home" and its permanent member "Scout" each with one routine; a run
// session of a routine has no ledger attempt, so the bridge binds the call to the
// routine (TeamBridge.routineRun) and the workspace reads it live (routineContext).
async function setup(t) {
  const f = await leadShareFixture(t);
  // Routines on for both, written directly (the member's profile is the lead's).
  for (const id of [f.lead, f.member.assistantId]) {
    const agent = f.store.storedAssistant(id);
    const next = { ...agent, capabilities: { ...agent.capabilities, reminders: true } };
    f.store.db
      .prepare("UPDATE assistants SET body=? WHERE id=?")
      .run(JSON.stringify(next), id);
  }
  const routines = new Map();
  const routine = (agentId, chatId) => {
    const agent = f.store.getAssistant(agentId);
    const r = {
      on: true,
      session: `agent:${agent.runtimeAgentId}:cron:job-${routines.size}:run:r1`,
      binding: {
        id: `binding-${routines.size}`,
        assistantId: agentId,
        definition: { name: "Nightly render" },
      },
      conversation: f.store.getConversation(chatId),
      agentId,
    };
    routines.set(r.session, r);
    return r;
  };
  f.assistants.routines = {
    runOrigin: (agent, key) => {
      const r = routines.get(key);
      return r?.on && r.agentId === agent.id
        ? { binding: r.binding, conversation: r.conversation }
        : null;
    },
  };
  f.assistants.runtime.generation = 1;
  const bridge = new TeamBridge({ assistants: f.assistants, teams: {} });
  await bridge.start();
  t.after(() => bridge.close());
  const call = async (r, input, sessionKey = r.session) => {
    const agent = f.store.getAssistant(r.agentId);
    const { ticket } = bridge.prepare({
      agentId: agent.runtimeAgentId,
      sessionKey,
      toolCallId: randomUUID(),
      action: "workspace",
    });
    return bridge.invoke({
      ticket,
      action: "workspace",
      input: { projectId: f.folderProject.id, ...input },
    });
  };
  return {
    ...f,
    bridge,
    call,
    lead: routine(f.lead, f.channel.conversationId),
    scout: routine(f.member.assistantId, f.memberChat.id),
  };
}

test("a routine run is offered the workspace tool", () => {
  assert.ok(routineTools.includes("agentpier_workspace"));
});

test("a routine reads its agent's folders and writes only when the owner allows it", async (t) => {
  const f = await setup(t);
  const read = await f.call(f.lead, { action: "file_read", path: "README.md" });
  assert.equal(read.content, "# Site\n");
  await assert.rejects(
    f.call(f.lead, { action: "file_write", path: "out.md", content: "x" }),
    code("ROUTINE_READ_ONLY"),
  );
  assert.equal(fs.existsSync(path.join(f.folder, "out.md")), false);
  // The owner's switch is read live from the binding.
  f.lead.binding.routineWrites = true;
  const written = await f.call(f.lead, {
    action: "file_write",
    path: "out.md",
    content: "rendered",
  });
  assert.equal(written.created, true);
  const audit = f.audits.find((e) => e.details?.kind === "project-file");
  assert.equal(audit.resourceId, f.lead.agentId);
  assert.equal(audit.details.origin, "routine");
  assert.equal(audit.details.routineId, f.lead.binding.id);
  // The level still counts: a read-only folder stays read-only.
  f.leadAccess({ [f.folderProject.id]: "read" });
  await assert.rejects(
    f.call(f.lead, { action: "file_write", path: "out.md", content: "y" }),
    code("PROJECT_READ_ONLY"),
  );
});

test("a member's routine reads its lead's standing share, never a task's", async (t) => {
  const f = await setup(t);
  await assert.rejects(
    f.call(f.scout, { action: "files_list" }),
    code("PROJECT_NOT_GRANTED"),
  );
  const { taskShare, applyTaskShare } =
    await import("../../server/features/assistants/lead-share-input.js");
  const lead = f.store.getAssistant(f.lead.agentId);
  const task = await f.task();
  applyTaskShare(
    taskShare(f.workflows, lead, f.teams.member(f.member.id), {
      projects: { [f.folderProject.id]: "read" },
    }),
    f.teams.get(task.id),
    task.inv,
  );
  await assert.rejects(
    f.call(f.scout, { action: "files_list" }),
    code("PROJECT_NOT_GRANTED"),
  );
  await f.share({ grants: { projects: { [f.folderProject.id]: "write" } } });
  assert.equal((await f.call(f.scout, { action: "files_list" })).access, "write");
  await assert.rejects(
    f.call(f.scout, { action: "file_write", path: "s.md", content: "s" }),
    code("ROUTINE_READ_ONLY"),
  );
  f.scout.binding.routineWrites = true;
  assert.equal(
    (await f.call(f.scout, { action: "file_write", path: "s.md", content: "s" })).created,
    true,
  );
});

test("a paused routine, another session or an archived agent reaches nothing", async (t) => {
  const f = await setup(t);
  await assert.rejects(
    f.call(f.lead, { action: "files_list" }, "agent:other:cron:job-9:run:r1"),
    code("FORBIDDEN"),
  );
  // Paused after the call was prepared: the step re-checks the routine.
  const agent = f.store.getAssistant(f.lead.agentId);
  const { ticket } = f.bridge.prepare({
    agentId: agent.runtimeAgentId,
    sessionKey: f.lead.session,
    toolCallId: randomUUID(),
    action: "workspace",
  });
  f.lead.on = false;
  await assert.rejects(
    async () =>
      f.bridge.invoke({
        ticket,
        action: "workspace",
        input: { projectId: f.folderProject.id, action: "files_list" },
      }),
    code("FORBIDDEN"),
  );
  await assert.rejects(f.call(f.lead, { action: "files_list" }), code("FORBIDDEN"));
  f.lead.on = true;
  f.teams.archive(f.member.id, f.teams.member(f.member.id).revision);
  await assert.rejects(f.call(f.scout, { action: "files_list" }), code("FORBIDDEN"));
});

test("a routine's coding request always waits for the owner and cannot cancel runs", async (t) => {
  const f = await setup(t);
  // Even with the owner's standing permission to start pipelines.
  f.leadAccess({ [f.folderProject.id]: "write" }, { autonomous: true });
  const action = await f.call(f.lead, {
    action: "coding_start",
    pipelineId: f.pipeline.id,
    task: "Render nightly",
  });
  assert.equal(action.state, "awaiting_approval");
  const stored = f.workflows.store.get(action.id);
  assert.equal(stored.conversationId, f.channel.conversationId, "shown in its chat");
  assert.equal(stored.routineId, f.lead.binding.id);
  assert.equal(stored.attemptId, null);
  await assert.rejects(
    f.call(f.lead, { action: "coding_cancel", id: action.id }),
    code("FORBIDDEN"),
  );
});
