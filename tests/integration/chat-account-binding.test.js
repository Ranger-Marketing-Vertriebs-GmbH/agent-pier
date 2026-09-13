import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatStore } from "../../server/features/chat/chat-store.js";

function fixture(t, tool) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-account-binding-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const session = {
    id: "session",
    tool,
    accountId: "original",
    cwd: dataDir,
    status: "running",
    nativeBinding: { enabled: true },
  };
  const events = [];
  const history = {
    readPage: async (current) => ({
      messages: [{ id: "message", role: "assistant", text: current.accountId }],
      tasks: [],
      next: { before: "message" },
    }),
  };
  const bindings = { resolve: async () => ({ id: "same-conversation" }) };
  const options = {
    dataDir,
    sessions: { get: async () => session },
    history,
    bindings,
    events: { publish: (...args) => events.push(args) },
  };
  const store = new ChatStore(options);
  return { store, session, history, bindings, options, events };
}

for (const tool of ["codex", "claude"]) {
  test(`${tool} account switch reattaches the same native conversation and invalidates old pages`, async (t) => {
    const { store, session, events } = fixture(t, tool);
    const old = await store.read(session.id);
    session.accountId = "replacement";
    const current = await store.read(session.id);
    assert.equal(current.availability, "ready");
    assert.equal(current.providerSessionId, old.providerSessionId);
    assert.equal(current.messages[0].text, "replacement");
    assert.notEqual(current.history.generation, old.history.generation);
    await assert.rejects(store.older(session.id, old.history.cursor), { status: 409 });
    assert.equal(
      JSON.parse(fs.readFileSync(store.file(session.id))).accountId,
      "replacement",
    );
    assert.equal(events.at(-1)[1], "binding-changed");
  });

  test(`${tool} repairs a persisted account binding after restart without serving the old snapshot`, async (t) => {
    const { store, session, history, options } = fixture(t, tool);
    await store.read(session.id);
    session.accountId = "replacement";
    history.readPage = async () => {
      throw Error("Target history unavailable");
    };
    const restarted = new ChatStore(options);
    await assert.rejects(restarted.read(session.id), /Target history unavailable/);
    assert.equal(fs.existsSync(store.file(session.id, "snapshot")), false);
    assert.equal(
      JSON.parse(fs.readFileSync(store.file(session.id))).accountId,
      "replacement",
    );
  });
}

test("an account change without a verified native binding cannot adopt the old conversation", async (t) => {
  const { store, session, bindings } = fixture(t, "claude");
  await store.read(session.id);
  session.accountId = "replacement";
  bindings.resolve = async () => null;
  await assert.rejects(store.read(session.id), /anderen Account/);
  assert.equal(JSON.parse(fs.readFileSync(store.file(session.id))).accountId, "original");
});

test("a late old-account history read cannot overwrite the newly attached account", async (t) => {
  const { store, session, history } = fixture(t, "codex");
  await store.read(session.id);
  store.invalidate(session.id);
  const readPage = history.readPage;
  let finish, started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  history.readPage = async (current) => {
    if (current.accountId !== "original") return readPage(current);
    started();
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const pending = store.read(session.id);
  const rejected = assert.rejects(pending, { status: 409 });
  await ready;
  session.accountId = "replacement";
  await store.read(session.id);
  finish({ messages: [{ id: "old", text: "Original account" }], tasks: [] });
  await rejected;
  assert.equal((await store.read(session.id)).messages[0].text, "replacement");
  assert.equal(
    JSON.parse(fs.readFileSync(store.file(session.id, "snapshot"))).scope.accountId,
    "replacement",
  );
});
