import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AgentProjectFiles } from "../../server/features/assistants/agent-project-files.js";
import { assistantProblem } from "../../server/features/assistants/assistant-validation.js";
import { png, run, shareFixture } from "../helpers/agent-share-fixture.js";

// The agent's granted project folders (AGENTPIER-123) as AssistantWorkflows holds
// them: `levels` per agent, the owner's own turns only, AgentPier's data protected.
function withProjects(f, levels) {
  const project = path.join(f.dataDir, "project");
  fs.mkdirSync(path.join(project, "docs"), { recursive: true });
  fs.mkdirSync(path.join(project, ".git"));
  fs.writeFileSync(path.join(project, ".git", "config"), "[remote] url=secret");
  fs.writeFileSync(path.join(project, "docs", "chart.png"), png);
  fs.writeFileSync(path.join(f.dataDir, "outside.txt"), "outside");
  fs.symlinkSync(path.join(f.dataDir, "outside.txt"), path.join(project, "out.txt"));
  // AgentPier's own data inside the project folder is never shared.
  const data = path.join(project, "agentpier-data");
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, "secret.txt"), "secret");
  const w = {
    a: f.service,
    access: { get: () => ({ projectFiles: levels }) },
    s: {
      memory: { project: (id) => ({ id, name: "Site", cwd: project }) },
      config: { dataDir: data },
    },
  };
  f.service.workflows = {
    folders: new AgentProjectFiles(w),
    store: { list: () => [] },
    close() {},
    context(inv) {
      inv.assertCurrent();
      const attempt = f.service.ledger.getAttempt(inv.attemptId);
      const request = f.service.ledger.getRequest(attempt.requestId);
      const origin = f.service.teams.store.context(request.id);
      if (!["owner", "telegram"].includes(origin.kind))
        throw assistantProblem("invalid", 403);
      return {
        assistantId: f.service.store.getConversation(request.conversationId).assistantId,
      };
    },
  };
  return project;
}

test("an agent shares a file from a project folder it may read", async (t) => {
  const f = await shareFixture(t);
  withProjects(f, { p1: "read" });
  await f.turn(f.chat, "project");
  const tool = f.tool(f.agent, f.chat);
  const shared = await run(tool, { projectId: "p1", path: "docs/chart.png" });
  assert.deepEqual(shared.file, {
    name: "chart.png",
    type: "image/png",
    size: png.length,
  });
  const [message] = (await f.service.history(f.chat.id)).messages.filter((m) => m.shared);
  assert.equal(message.attachments[0].name, "chart.png");
  assert.equal(f.audit.at(-1).projectId, "p1");
  assert.equal(f.audit.at(-1).details.kind, "share");
  // The workspace stays the default root.
  f.file(f.agent, "note.txt", "note");
  assert.equal((await run(tool, { path: "note.txt" })).status, "shared");
  assert.equal(f.audit.at(-1).projectId, undefined);
});

test("project shares refuse other folders, .git, links out and AgentPier's data", async (t) => {
  const f = await shareFixture(t);
  withProjects(f, { p1: "read" });
  await f.turn(f.chat, "refusals");
  const tool = f.tool(f.agent, f.chat);
  await assert.rejects(
    run(tool, { projectId: "p2", path: "docs/chart.png" }),
    /^Error: PROJECT_NOT_GRANTED: /,
  );
  for (const target of [".git/config", "out.txt", "agentpier-data/secret.txt", "../x"])
    await assert.rejects(
      run(tool, { projectId: "p1", path: target }),
      /^Error: PROJECT_PATH_REFUSED: /,
      target,
    );
  await assert.rejects(
    run(tool, { projectId: "p1", path: "docs/missing.pdf" }),
    /^Error: SHARE_NOT_FOUND: /,
  );
});

test("project shares need the owner's own turn", async (t) => {
  const f = await shareFixture(t);
  withProjects(f, { p1: "read" });
  await f.turn(f.chat, "forwarded", { kind: "lead-request", requestId: "r1" });
  await assert.rejects(
    run(f.tool(f.agent, f.chat), { projectId: "p1", path: "docs/chart.png" }),
    /^Error: FORBIDDEN: /,
  );
});
