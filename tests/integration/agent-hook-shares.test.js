import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  body,
  done,
  event,
  hookFixture,
  makeHook,
} from "../helpers/agent-hook-fixture.js";
import { AgentShares } from "../../server/features/assistants/agent-shares.js";
import { AgentProjectFiles } from "../../server/features/assistants/agent-project-files.js";
import { hookContext } from "../../server/features/assistants/agent-hook-workspace.js";
import { mainConversation } from "../../server/features/assistants/routine-targets.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";

// AGENTPIER-274: a hook's run sends the owner files through the bridge like any other
// run, also after its event settled (OpenClaw's follow-up of a command it started):
// into the agent's main chat only, never to Telegram, from the workspace or the
// hook's own folders.
async function setup(t) {
  const f = hookFixture(t);
  const revision = () => f.store.getAssistant(f.id).revision;
  f.store.updateAssistant(
    f.id,
    { capabilities: { memory: false, reminders: true } },
    revision(),
  );
  // Two folders the agent may read; the hook gets only the first.
  const dirs = {};
  for (const id of ["p1", "p2"]) {
    dirs[id] = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `hook-${id}-`)));
    t.after(() => fs.rmSync(dirs[id], { recursive: true, force: true }));
    fs.writeFileSync(path.join(dirs[id], "cut.mp4"), "MP4");
  }
  const access = {
    get: () => ({
      projectIds: [],
      sshAccesses: [],
      projectFiles: { p1: "read", p2: "read" },
    }),
    sshHosts: () => [],
    eligible: (id) => f.store.getAssistant(id),
  };
  const data = path.join(f.dataDir, "data");
  fs.mkdirSync(data, { recursive: true });
  const w = {
    a: f.assistants,
    access,
    s: {
      memory: { project: (id) => ({ id, name: id, cwd: dirs[id] }) },
      config: { dataDir: data },
    },
  };
  w.folders = new AgentProjectFiles(w);
  f.assistants.workflows = {
    access,
    folders: w.folders,
    context: (inv) => hookContext(w, inv),
  };
  f.assistants.shares = new AgentShares({
    assistants: f.assistants,
    channels: f.service,
  });
  const workspace = path.join(f.assistants.attachments.config.workspaces, f.id);
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "report.txt"), "REPORT");
  const bridge = new TeamBridge({
    assistants: f.assistants,
    teams: { store: { context: () => null } },
  });
  await bridge.start();
  t.after(() => bridge.close());
  const hook = makeHook(f, { rights: { folders: { p1: "read" } } });
  await f.hooks.deliver(hook, body(JSON.stringify({ id: "e1" })));
  const running = event(f, hook, "e1");
  const sessionKey = `agent:${f.runtimeAgentId}:cron:${running.jobId}:run:r1`;
  const share = async (input) => {
    const { ticket } = await bridge.prepare({
      agentId: f.runtimeAgentId,
      sessionKey,
      toolCallId: `call-${Math.random()}`,
      action: "share_file",
      runId: "r1",
    });
    return bridge.invoke({ ticket, action: "share_file", input });
  };
  const rows = () =>
    f.assistants.attachments.db
      .prepare("SELECT request_id, conversation_id FROM agent_attachments")
      .all()
      .map((r) => [r.request_id, r.conversation_id]);
  const files = () => f.service.outbox.all(f.channel.id).filter((e) => e.kind === "file");
  const settle = () => f.hooks.runs.complete(running.id, done(running.jobId));
  return { ...f, bridge, hook, running, share, rows, files, settle, sessionKey };
}
const refused = { status: 403 };

for (const phase of ["running", "settled"])
  test(`a hook's ${phase} session shares into the main chat from its own folders only`, async (t) => {
    const f = await setup(t);
    if (phase === "settled") {
      await f.settle();
      assert.equal(event(f, f.hook, "e1").status, "done");
    }
    const main = mainConversation(f.store, f.id);
    assert.equal((await f.share({ path: "report.txt" })).status, "shared");
    const shared = await f.share({ projectId: "p1", path: "cut.mp4" });
    assert.equal(shared.status, "shared");
    assert.equal(shared.telegram, undefined, "never to Telegram");
    // The agent's other folder is not the hook's, and nothing leaves the workspace.
    await assert.rejects(f.share({ projectId: "p2", path: "cut.mp4" }), refused);
    await assert.rejects(f.share({ path: "../escape.txt" }), refused);
    await assert.rejects(f.share({ path: ".agentpier/secrets.env" }), refused);
    assert.deepEqual(f.rows(), [
      [`share:hook:${f.running.id}`, main.id],
      [`share:hook:${f.running.id}`, main.id],
    ]);
    assert.deepEqual(f.files(), []);
  });

test("a settled hook's session still serves no other bridge tool", async (t) => {
  const f = await setup(t);
  await f.settle();
  for (const action of ["workspace", "ssh", "coding_session", "mail", "routine"])
    assert.throws(
      () =>
        f.bridge.prepare({
          agentId: f.runtimeAgentId,
          sessionKey: f.sessionKey,
          toolCallId: `call-${action}`,
          action,
        }),
      refused,
      action,
    );
  // Its hook paused since: workspace files still, its folders no longer.
  f.hooks.store.patch(f.hook.id, { enabled: false });
  assert.equal((await f.share({ path: "report.txt" })).status, "shared");
  await assert.rejects(f.share({ projectId: "p1", path: "cut.mp4" }), refused);
});
