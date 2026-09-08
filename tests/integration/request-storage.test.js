import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { RequestBroker } from "../../server/features/requests/request-broker.js";

test("request broker rejects symlinked private storage", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-request-storage-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "elsewhere"));
  await fs.symlink(path.join(root, "elsewhere"), path.join(root, "requests"));
  const broker = new RequestBroker({ dataDir: root, sessions: {} });
  await assert.rejects(broker.ready, /Unsafe native request storage/);
  assert.deepEqual(await fs.readdir(path.join(root, "elsewhere")), []);
});
test("a second broker cannot unlink the live broker socket", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-request-owner-"));
  const first = new RequestBroker({ dataDir: root, sessions: {} });
  t.after(async () => {
    await first.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await first.ready;
  const second = new RequestBroker({ dataDir: root, sessions: {} });
  await assert.rejects(second.ready, /already running/);
  const socket = net.createConnection(first.socketPath);
  await once(socket, "connect");
  socket.destroy();
});
test("an unauthenticated native peer cannot publish prompts", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-request-auth-"));
  let lookedUp = false;
  const broker = new RequestBroker({
    dataDir: root,
    sessions: {
      get: async () => {
        lookedUp = true;
      },
    },
  });
  t.after(async () => {
    await broker.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await broker.prepare({
    id: "fixture",
    account: { id: "account", tool: "claude" },
    cwd: root,
    launch: { command: "/fixture/claude", args: [], env: {} },
  });
  const socket = net.createConnection(broker.socketPath);
  socket.on("error", () => {});
  await once(socket, "connect");
  const closed = once(socket, "close");
  socket.write(
    JSON.stringify({
      type: "hello",
      sessionId: "fixture",
      token: "invalid-token",
      epoch: "epoch",
    }) + "\n",
  );
  await closed;
  assert.equal(lookedUp, false);
  assert.equal(broker.entries.size, 0);
});
