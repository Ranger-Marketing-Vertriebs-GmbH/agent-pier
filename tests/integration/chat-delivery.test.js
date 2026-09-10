import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "../../server/features/sessions/session-manager.js";
import { applicationFixture } from "../helpers/application.js";

const session = {
  id: "delivery-session",
  accountId: "account-a",
  tool: "claude",
  createdAt: "2026-09-08T10:00:00.000Z",
  status: "running",
};
const scope = JSON.stringify([
  session.id,
  session.accountId,
  session.tool,
  session.createdAt,
]);
const inputPath = `/api/sessions/${session.id}/input`;
async function setup(t) {
  const f = await applicationFixture(t);
  let writes = 0;
  const install = (
    input = async () => {
      writes++;
    },
  ) => {
    f.application.sessions.get = async () => ({ ...session });
    f.application.sessions.input = async (
      _id,
      text,
      submit,
      beforeInput,
      nativeQueue,
    ) => {
      await beforeInput(session, "");
      if (nativeQueue && (await nativeQueue(session))) return;
      assert.equal(submit, true);
      return input(text);
    };
    f.application.requests.list = async () => ({ requests: [] });
    f.application.requests.hasPending = () => false;
    f.application.models.guardInput = async () => {};
  };
  install();
  const body = {
    deliveryId: randomUUID(),
    deliveryScope: scope,
    text: "private prompt",
    submit: true,
  };
  return {
    f,
    body,
    install,
    writes: () => writes,
    post: (value = body) => f.request(inputPath, { method: "POST", body: value }),
    status: () =>
      f.request(`${inputPath}/${body.deliveryId}?scope=${encodeURIComponent(scope)}`),
  };
}

test("HTTP delivery replay and restart do not repeat terminal input", async (t) => {
  const x = await setup(t);
  assert.equal((await (await x.post()).json()).status, "handed-off");
  assert.equal((await (await x.post()).json()).status, "handed-off");
  assert.equal(x.writes(), 1);
  await x.f.restart();
  x.install();
  assert.equal((await (await x.status()).json()).status, "handed-off");
  assert.equal((await (await x.post()).json()).status, "handed-off");
  assert.equal(x.writes(), 1);
});

test("Codex delivery uses the native queue when the running thread is bound", async (t) => {
  const x = await setup(t);
  const codex = { ...session, tool: "codex" };
  x.body.deliveryScope = JSON.stringify([
    codex.id,
    codex.accountId,
    codex.tool,
    codex.createdAt,
  ]);
  x.f.application.sessions.get = async () => ({ ...codex });
  x.f.application.sessions.input = async (
    _id,
    _text,
    _submit,
    beforeInput,
    nativeQueue,
  ) => {
    await beforeInput(codex, "");
    assert.equal(await nativeQueue(codex), true);
  };
  x.f.application.bindings.resolve = async () => ({ id: "thread-queue" });
  const queued = [];
  x.f.application.history.queue = async (...args) => queued.push(args);
  assert.equal((await (await x.post()).json()).status, "handed-off");
  assert.deepEqual(queued, [[codex, "thread-queue", x.body.text]]);
  assert.equal(x.writes(), 0);
});

test("concurrent identical HTTP deliveries report pending without duplicate input", async (t) => {
  const x = await setup(t);
  let release, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  x.install(async () => {
    entered();
    await held;
  });
  const first = x.post();
  await started;
  try {
    assert.equal((await (await x.status()).json()).status, "pending");
    assert.equal((await (await x.post()).json()).status, "pending");
    assert.equal((await x.post({ ...x.body, text: "different" })).status, 409);
  } finally {
    release();
  }
  assert.equal((await (await first).json()).status, "handed-off");
});

test("guards reject before input; possible terminal writes remain uncertain and sanitized", async (t) => {
  const x = await setup(t);
  x.f.application.models.guardInput = async () => {
    throw new Error("secret-token");
  };
  const rejected = await (await x.post()).json();
  assert.equal(rejected.status, "rejected");
  assert.equal(x.writes(), 0);
  assert.ok(!JSON.stringify(rejected).includes("secret-token"));
  x.body.deliveryId = randomUUID();
  x.install(async () => {
    throw new Error("secret-token");
  });
  const uncertain = await (await x.post()).json();
  assert.equal(uncertain.status, "uncertain");
  assert.ok(!JSON.stringify(uncertain).includes("secret-token"));
  await x.f.restart();
  x.install();
  assert.equal((await (await x.post()).json()).status, "uncertain");
  assert.equal(x.writes(), 0);
});

test("HTTP scope and payload validation fail closed and legacy requests stay compatible", async (t) => {
  const x = await setup(t);
  assert.equal((await (await x.status()).json()).status, "absent");
  for (const change of [
    { deliveryScope: "other" },
    { deliveryId: "../bad" },
    { submit: false },
  ]) {
    assert.ok((await x.post({ ...x.body, ...change })).status >= 400);
  }
  assert.equal(x.writes(), 0);
  await x.post();
  assert.equal((await x.post({ ...x.body, text: "changed" })).status, 409);
  x.f.application.sessions.get = async () => ({ ...session, accountId: "other" });
  assert.equal((await x.status()).status, 409);
  x.install();
  assert.deepEqual(await (await x.post({ text: "legacy", submit: true })).json(), {
    ok: true,
  });
});

test("receipt files contain no prompt, are private, and corrupt receipts block replay", async (t) => {
  const x = await setup(t);
  await x.post();
  const folder = path.join(x.f.dataDir, "chat-delivery", session.id);
  const file = path.join(folder, `${x.body.deliveryId}.json`);
  const text = await fs.readFile(file, "utf8");
  assert.ok(!text.includes(x.body.text));
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(folder)).mode & 0o777, 0o700);
  await fs.writeFile(file, "broken");
  assert.equal((await x.post()).status, 503);
  assert.equal((await x.status()).status, 503);
  assert.equal(x.writes(), 1);
});

test("persisted incomplete reservations reconcile as uncertain after restart", async (t) => {
  const x = await setup(t);
  await x.post();
  const file = path.join(
    x.f.dataDir,
    "chat-delivery",
    session.id,
    `${x.body.deliveryId}.json`,
  );
  const receipt = JSON.parse(await fs.readFile(file, "utf8"));
  receipt.status = "pending";
  await fs.writeFile(file, JSON.stringify(receipt));
  await x.f.restart();
  x.install();
  assert.equal((await (await x.status()).json()).status, "uncertain");
  assert.equal((await (await x.post()).json()).status, "uncertain");
  assert.equal(x.writes(), 1);
});

test("unavailable receipt storage prevents terminal input", async (t) => {
  const x = await setup(t);
  await fs.writeFile(path.join(x.f.dataDir, "chat-delivery"), "not a directory");
  assert.equal((await x.post()).status, 503);
  assert.equal(x.writes(), 0);
});

test("request guards reject both before scheduling and inside the serialized callback", async (t) => {
  const x = await setup(t);
  x.f.application.requests.list = async () => ({ requests: [{ id: "approval" }] });
  assert.equal((await (await x.post()).json()).status, "rejected");
  assert.equal(x.writes(), 0);
  x.body.deliveryId = randomUUID();
  x.install();
  x.f.application.requests.hasPending = () => true;
  assert.equal((await (await x.post()).json()).status, "rejected");
  assert.equal(x.writes(), 0);
});

test("session scope is checked again at serialized input time", async (t) => {
  const x = await setup(t);
  x.f.application.sessions.input = async (_id, _text, _submit, beforeInput) => {
    await beforeInput({ ...session, accountId: "switched-account" }, "");
    assert.fail("changed account must never reach native input");
  };
  assert.equal((await (await x.post()).json()).status, "rejected");
});

test("real session input keeps stopped and headless guards and persists uncertainty before tmux input", async (t) => {
  const x = await setup(t);
  const manager = x.f.application.sessions;
  manager.input = SessionManager.prototype.input.bind(manager);
  const commands = [];
  manager.tmux = async (args) => {
    commands.push(args[0]);
    if (args[0] !== "capture-pane") {
      const file = path.join(
        x.f.dataDir,
        "chat-delivery",
        session.id,
        `${x.body.deliveryId}.json`,
      );
      assert.equal(JSON.parse(await fs.readFile(file, "utf8")).status, "uncertain");
    }
    return "";
  };
  for (const changed of [{ status: "stopped" }, { pipeline: { headless: true } }]) {
    x.body.deliveryId = randomUUID();
    manager.current = async () => ({ ...session, ...changed });
    assert.equal((await (await x.post()).json()).status, "rejected");
    assert.deepEqual(commands, []);
  }
  x.body.deliveryId = randomUUID();
  manager.current = async () => ({ ...session });
  assert.equal((await (await x.post()).json()).status, "handed-off");
  assert.deepEqual(commands, [
    "capture-pane",
    "load-buffer",
    "paste-buffer",
    "send-keys",
  ]);
  await x.post();
  assert.equal(commands.length, 4);
});

test("session deletion removes receipts only after successful removal", async (t) => {
  const x = await setup(t);
  await x.post();
  const folder = path.join(x.f.dataDir, "chat-delivery", session.id);
  x.f.application.sessions.remove = async () => {
    throw Object.assign(new Error("Still running"), { status: 409 });
  };
  const endpoint = `/api/sessions/${session.id}`;
  assert.equal((await x.f.request(endpoint, { method: "DELETE" })).status, 409);
  assert.ok((await fs.stat(folder)).isDirectory());
  x.f.application.sessions.remove = async () => {};
  assert.equal((await x.f.request(endpoint, { method: "DELETE" })).status, 204);
  await assert.rejects(fs.stat(folder), { code: "ENOENT" });
});
