import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { carries, sendFilesFixture } from "../helpers/mail-send-files-fixture.js";
import { mimeWith, pdfWith } from "../helpers/mail-documents.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { personalShell } from "../../server/features/assistants/native-capabilities.js";
import {
  effectiveRights,
  storedRights,
} from "../../server/features/assistants/agent-hook-rights.js";

// agentpier_mail from a hook run through the real tool bridge: a ticket prepared for
// the hook's cron session, then the call as the Gateway plugin sends it, so the
// hook binding, the ticket check and AgentMail's gate all run as installed.

const pdfType = "application/pdf";

// `folders` (project id → level, from the fixture) is what the hook holds.
async function setup(t, folders = () => ({})) {
  const f = await sendFilesFixture(t);
  f.access({ level: "send", projectFiles: { [f.folderProject.id]: "write" } });
  const hook = {
    id: "hook-1",
    assistantId: f.id,
    enabled: true,
    rights: storedRights({ shell: "off", mail: true, folders: folders(f) }),
  };
  const live = (agent) =>
    effectiveRights(hook.rights, {
      folders: f.workflows.folders.ownAndShared(agent.id),
      shell: personalShell(agent),
      sshHosts: [],
      mail: true,
    });
  const hooks = f.assistants.routines.hooks;
  const runOrigin = hooks.runOrigin;
  hooks.runOrigin = (agent, key) => {
    const run = runOrigin(agent, key);
    return (
      run && {
        ...run,
        conversation: { id: f.channel.conversationId, assistantId: f.id },
        effective: { ...run.effective, ...live(agent) },
      }
    );
  };
  hooks.liveRights = (agent, hookId) =>
    hookId === hook.id && hook.enabled && agent.id === hook.assistantId
      ? live(agent)
      : null;
  // The hook event of the cron session, as the bridge looks it up.
  hooks.events = { byJob: (job) => (job === "hook-job" ? { id: "event-1" } : null) };
  const bridge = new TeamBridge({
    assistants: f.assistants,
    teams: { store: { context: () => null } },
  });
  const { url, token } = await bridge.start();
  t.after(() => bridge.close());
  // A POST as the Gateway plugin sends it: its JSON, or { error, reason } with status.
  const post = async (route, body) => {
    const res = await fetch(`${url}${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok)
      throw Object.assign(new Error(json.error), { status: res.status, ...json });
    return json;
  };
  const agent = f.store.getAssistant(f.id);
  const sessionKey = `agent:${agent.runtimeAgentId}:cron:hook-job:run:h1`;
  /** One agentpier_mail call of the hook run through prepare and invoke. */
  const call = async (input) => {
    const { ticket } = await post("/prepare", {
      agentId: agent.runtimeAgentId,
      sessionKey,
      toolCallId: crypto.randomUUID(),
      action: "mail",
    });
    return post("/invoke", {
      ticket,
      action: "mail",
      input: { accountId: f.account.id, ...input },
    });
  };
  const codeOf = async (input) => {
    try {
      await call(input);
    } catch (error) {
      if (!error.error) throw error;
      return error.error;
    }
    assert.fail("the call succeeded");
  };
  return { ...f, bridge, call, codeOf };
}

test("a hook run saves an attachment to a project it may write", async (t) => {
  const f = await setup(t, (x) => ({ [x.folderProject.id]: "write" }));
  const id = f.folderProject.id;
  const pdf = pdfWith("Rechnung");
  const { uid } = f.imap.mailbox.append(
    "INBOX",
    Buffer.from(
      mimeWith({
        subject: "Rechnung",
        text: "Anbei.",
        attachments: [{ name: "r.pdf", type: pdfType, content: pdf }],
      }),
      "latin1",
    ),
  );
  const saved = await f.call({
    action: "attachment",
    folder: "INBOX",
    uid,
    part: "2",
    mode: "save",
    projectId: id,
    path: "docs",
  });
  assert.equal(saved.saved.path, "docs/r.pdf");
  assert.deepEqual(fs.readFileSync(f.proj("docs/r.pdf")), pdf);
  // The hook's own workspace stays out of reach for saves.
  assert.equal(
    await f.codeOf({
      action: "attachment",
      folder: "INBOX",
      uid,
      part: "2",
      mode: "save",
    }),
    "MAIL_SAVE_REFUSED",
  );
});

test("a hook run sends with a workspace file and the owner sees its path", async (t) => {
  const f = await setup(t);
  const bytes = pdfWith("Offer");
  fs.writeFileSync(f.ws("offer.pdf"), bytes);
  const r = await f.call({
    action: "send",
    ...f.fields,
    attachments: [{ path: "offer.pdf" }],
  });
  assert.equal(r.status, "awaiting_approval");
  const a = f.workflows.get(r.actionId);
  assert.equal(a.origin.kind, "hook");
  assert.deepEqual(a.payload.attachments[0].source, {
    kind: "workspace",
    path: "offer.pdf",
  });
  assert.deepEqual(a.payload.files.context, {
    assistantId: f.id,
    hook: { hookId: "hook-1", folders: {} },
  });
  await f.decide(r.actionId);
  assert.equal((await f.settled(r.actionId)).state, "completed");
  assert.ok(carries(f.smtp.messages[0].raw, bytes));
});

test("a hook run cannot attach from a project it does not hold", async (t) => {
  // The agent holds the project; the hook does not.
  const f = await setup(t);
  f.file(f.proj("r.pdf"));
  assert.equal(
    await f.codeOf({
      action: "send",
      ...f.fields,
      attachments: [{ path: "r.pdf", projectId: f.folderProject.id }],
    }),
    "PROJECT_NOT_GRANTED",
  );
  // Refused before a draft was saved.
  assert.equal(f.count("Drafts"), 0);
  assert.equal(f.smtp.messages.length, 0);
});
