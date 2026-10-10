import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantService } from "../../server/features/assistants/assistant-service.js";

test("logout waits for dispatch admission and rejects while its account has pending work", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-admission-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new AssistantStore({ dataDir });
  const assistant = store.createAssistant({
    name: "Home",
    model: { connectionId: "selected", modelId: "m" },
  });
  const conversation = store.saveConversation({
    assistantId: assistant.id,
    runtimeSessionKey: "session",
  });
  let release, entered;
  const applying = new Promise((r) => {
    entered = r;
  });
  const gate = new Promise((r) => {
    release = r;
  });
  t.after(() => release());
  const runtime = Object.assign(new EventEmitter(), {
    client: {
      ready: true,
      subscribe: () => () => {},
      call: async () => ({ runId: "run" }),
    },
    close: async () => {},
  });
  const service = new AssistantService({
    store,
    runtime,
    models: {},
    config: {
      apply: async () => {
        entered();
        await gate;
      },
    },
  });
  t.after(() => service.close());
  let loggedOut = false;
  const accounts = {
    logout: async () => {
      loggedOut = true;
      return [];
    },
  };
  const sending = service.send(conversation.id, {
    clientRequestId: "request",
    text: "Hello",
  });
  await applying;
  const logout = service.logoutAccount(accounts, "selected");
  const rejected = assert.rejects(logout, { status: 409 });
  release();
  await sending;
  await rejected;
  assert.equal(loggedOut, false);
  await service.logoutAccount(accounts, "unrelated");
  assert.equal(loggedOut, true);

  // A stale browser may repeat a completed logout. Reject it before stopping the
  // shared runtime; the account method still validates again during mutation.
  service.providerSynchronization = {
    change: () => assert.fail("unknown account must not enter maintenance"),
  };
  accounts.record = () => {
    throw Object.assign(Error("unknown account"), { status: 400 });
  };
  await assert.rejects(async () => service.logoutAccount(accounts, "removed"), {
    status: 400,
  });
});
