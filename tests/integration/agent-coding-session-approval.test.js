import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { agentSessionFixture } from "../helpers/agent-coding-session-fixture.js";
import { sessionContext } from "../../server/features/assistants/coding-sessions/session-turns.js";
import { startSession } from "../../server/features/assistants/coding-sessions/session-start.js";
import { notifyAction } from "../../server/features/assistants/assistant-action-notifications.js";
import { serverCatalogs } from "../../server/lib/i18n/catalogs.js";

// A team turn: the start waits for the owner (session-start.js).
async function teamStart(f, input) {
  const inv = await f.invocation();
  const ctx = { ...sessionContext(f.workflows, inv), sessionClass: "team" };
  const r = await startSession(f.workflows, ctx, {
    action: "start",
    requestId: crypto.randomUUID(),
    projectId: f.project.id,
    ...input,
  });
  assert.equal(r.state, "awaiting_approval");
  return f.workflows.store.get(r.actionId);
}

// The Telegram approval text of an action, in the channel's language.
function approvalText(action, language) {
  const sent = [];
  const w = {
    s: {
      assistantChannels: {
        outbox: { all: () => [], enqueue: (entry) => sent.push(entry) },
        store: { get: () => ({ language }) },
      },
    },
  };
  notifyAction(
    w,
    {
      ...action,
      origin: { kind: "telegram", channelId: "c", chatId: "1", userId: "2" },
    },
    "approval",
  );
  assert.equal(sent.length, 1);
  return sent[0].text;
}

test("a waiting start keeps what the owner approves: mode, account, access, sandbox and tools", async (t) => {
  const f = await agentSessionFixture(t);
  const nono = path.join(f.dataDir, "nono");
  fs.writeFileSync(
    nono,
    "#!/bin/sh\nprintf '  Built-in:\\n    strict  Strict profile\\n'\n",
  );
  fs.chmodSync(nono, 0o755);
  f.services.nonoSandbox = { executable: () => nono };
  const a = await teamStart(f, {
    tool: "claude",
    accountId: "work-claude",
    launchMode: "bypass",
    secretIds: ["secret-1"],
    sshAccessIds: ["ssh-1"],
    nonoProfile: "strict",
    agentbus: false,
  });
  assert.deepEqual(a.launch, {
    launchMode: "bypass",
    unattended: true,
    account: "Work",
    connection: null,
    model: null,
    secrets: 1,
    sshAccesses: 1,
    sandbox: "strict",
    agentpierTools: true,
    agentbus: false,
  });
  assert.equal(f.workflows.project(a).launch.unattended, true);
  const en = approvalText(a, "en");
  assert.match(en, /Launch mode: bypass \(unattended: runs commands without asking\)/);
  assert.match(en, /Account: Work/);
  assert.match(en, /Secrets: 1 · SSH accesses: 1/);
  assert.match(en, /Sandbox profile: strict/);
  assert.match(en, /AgentPier tools: on · AgentBus: off/);
  const de = approvalText(a, "de");
  assert.ok(
    de.includes(serverCatalogs.de.agentCodingSessions.startLaunch.mode("bypass")),
  );
  assert.match(de, /Secrets: 1 · SSH-Zugänge: 1/);

  // Defaults: Codex runs yolo, unattended; a connection names itself and its model.
  const b = await teamStart(f, {
    tool: "codex",
    providerConnectionId: "router",
    providerModelId: "local-model",
  });
  assert.deepEqual(b.launch, {
    launchMode: "yolo",
    unattended: true,
    account: null,
    connection: "Router",
    model: "local-model",
    secrets: 0,
    sshAccesses: 0,
    sandbox: null,
    agentpierTools: true,
    agentbus: true,
  });
  const text = approvalText(b, "en");
  assert.match(text, /Launch mode: yolo \(unattended/);
  assert.match(text, /Connection: Router · `local-model`/);
  assert.match(text, /Sandbox profile: none/);
  assert.match(text, /AgentPier tools: on · AgentBus: on/);
  // An attended mode is named without the warning.
  const c = await teamStart(f, { tool: "codex", launchMode: "default" });
  assert.equal(c.launch.unattended, false);
  assert.doesNotMatch(approvalText(c, "en"), /unattended/);
});
