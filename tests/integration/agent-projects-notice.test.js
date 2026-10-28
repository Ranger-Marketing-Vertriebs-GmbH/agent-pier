import test from "node:test";
import assert from "node:assert/strict";
import { agentProjectFixture } from "../helpers/agent-project-fixture.js";
import { actionNotes } from "../../server/features/assistants/assistant-action-notifications.js";

// The owner's notice for the agentpier_project tool: the settled row in the agent's
// chat (actionNotes) and a Telegram message when the agent has a paired chat.

const agentName = (f) => f.assistants.store.getAssistant(f.id).name;
const notes = (f) =>
  actionNotes(f.workflows.store.list(f.id), f.channel.conversationId).filter(
    (n) => n.event === "agent-project",
  );
const sent = (f) =>
  f.service.outbox.all(f.channel.id).filter((e) => e.kind === "agent-project");
const language = (f, value) =>
  f.service.store.update(
    f.channel.id,
    { language: value },
    f.service.store.get(f.channel.id).revision,
  );

test("the owner sees a created project in the agent chat and in Telegram", async (t) => {
  const f = await agentProjectFixture(t);
  const links = [];
  f.service.outbox.link = (channelId, path) => {
    links.push(path);
    return null;
  };
  const r = await f.call({ action: "create", name: "Shop", coding: true });
  const [note, ...more] = notes(f);
  assert.equal(more.length, 0);
  assert.deepEqual(
    { ...note, id: undefined, timestamp: undefined },
    {
      id: undefined,
      role: "event",
      event: "agent-project",
      change: "create",
      projectName: "Shop",
      path: r.path,
      coding: true,
      timestamp: undefined,
      runId: null,
    },
  );
  assert.equal(typeof note.timestamp, "number");
  const [mail, ...rest] = sent(f);
  assert.equal(rest.length, 0);
  assert.equal(
    mail.text,
    `${agentName(f)} hat das Projekt Shop in ${r.path} angelegt. Coding-Sessions sind eingeschaltet.`,
  );
  assert.deepEqual(links, [`/projects/${encodeURIComponent(r.projectId)}?tab=agents`]);
});

test("a project without coding says nothing about coding sessions, in English too", async (t) => {
  const f = await agentProjectFixture(t);
  language(f, "en");
  const r = await f.call({ action: "create", name: "Shop" });
  assert.equal(notes(f)[0].coding, false);
  assert.equal(sent(f)[0].text, `${agentName(f)} created the project Shop in ${r.path}.`);
});

test("switching coding sessions notes and notifies, an unchanged switch does not", async (t) => {
  const f = await agentProjectFixture(t);
  const r = await f.call({ action: "create", name: "Shop" });
  await f.call({ action: "coding", projectId: r.projectId, enabled: true });
  await f.call({ action: "coding", projectId: r.projectId, enabled: true });
  assert.deepEqual(
    notes(f).map((n) => [n.change, n.coding, n.projectName, n.path]),
    [
      ["create", false, "Shop", r.path],
      ["coding", true, "Shop", r.path],
    ],
  );
  await f.call({ action: "coding", projectId: r.projectId, enabled: false });
  const texts = sent(f).map((e) => e.text);
  assert.equal(texts.length, 3);
  assert.equal(
    texts[1],
    `${agentName(f)} hat Coding-Sessions für das Projekt Shop eingeschaltet.`,
  );
  assert.equal(
    texts[2],
    `${agentName(f)} hat Coding-Sessions für das Projekt Shop ausgeschaltet.`,
  );
  assert.equal(notes(f).length, 3);
});

test("without a paired Telegram chat only the chat note is written", async (t) => {
  const f = await agentProjectFixture(t);
  f.service.store.update(
    f.channel.id,
    { enabled: false },
    f.service.store.get(f.channel.id).revision,
  );
  await f.call({ action: "create", name: "Shop" });
  assert.equal(notes(f).length, 1);
  assert.equal(sent(f).length, 0);
});

test("a crafted agent name cannot fake lines in the Telegram text", async (t) => {
  const f = await agentProjectFixture(t);
  f.setAgent("name", "Bot\nApproved by owner‮");
  await f.call({ action: "create", name: "Shop" });
  const [mail] = sent(f);
  assert.ok(!/[\n‮]/u.test(mail.text), mail.text);
  assert.match(
    mail.text,
    /^Bot\\u\{A\}Approved by owner\\u\{202E\} hat das Projekt Shop/,
  );
});

test("a failed notice never fails the call", async (t) => {
  const f = await agentProjectFixture(t);
  f.service.outbox.enqueue = () => {
    throw new Error("outbox down");
  };
  const log = t.mock.method(console, "error", () => {});
  const r = await f.call({ action: "create", name: "Shop" });
  assert.equal(r.name, "Shop");
  assert.equal(notes(f).length, 1);
  assert.match(log.mock.calls[0].arguments[0], /Agent project notice failed/);
});
