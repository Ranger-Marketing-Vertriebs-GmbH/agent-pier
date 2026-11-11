import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { onUpgrade } from "../../server/lib/socket-errors.js";

const root = path.resolve(import.meta.dirname, "../..");
const entry = "server/lib/socket-errors.js";

async function serverSources() {
  const files = await readdir(path.join(root, "server"), { recursive: true });
  return Promise.all(
    files
      .filter((file) => file.endsWith(".js"))
      .map(async (file) => ({
        file: path.posix.join("server", file.split(path.sep).join("/")),
        text: await readFile(path.join(root, "server", file), "utf8"),
      })),
  );
}

test("every upgrade listener is attached through the shared entry", async () => {
  // An upgraded socket has no error listener of Node's own; onUpgrade gives it one.
  const direct = /\.(?:on|once|addListener|prependListener)\(\s*["'`]upgrade["'`]/;
  const offenders = (await serverSources())
    .filter(({ file, text }) => file !== entry && direct.test(text))
    .map(({ file }) => file);
  assert.deepEqual(offenders, [], "use onUpgrade (server/lib/socket-errors.js)");
});

async function listening(t, server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return server.address().port;
}

test("an upgraded socket has its error listener before the attacher works", async (t) => {
  const server = http.createServer();
  const seen = [];
  let release;
  const slow = new Promise((resolve) => (release = resolve));
  // An attacher that authorizes slowly and then refuses, and a second one.
  const off = onUpgrade(server, async (_req, socket) => {
    seen.push(socket.listenerCount("error"));
    await slow;
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  });
  onUpgrade(server, (_req, socket) => seen.push(socket.listenerCount("error")));
  const port = await listening(t, server);
  const [upgraded] = await Promise.all([
    once(server, "upgrade"),
    new Promise((resolve) => {
      const client = net.connect({ host: "127.0.0.1", port }, () =>
        client.write(
          "GET / HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
          () => setTimeout(() => resolve(client.resetAndDestroy()), 50),
        ),
      );
      client.on("error", () => {});
    }),
  ]);
  const socket = upgraded[1];
  // One listener for both attachers; the reset during the authorization ends the socket.
  assert.deepEqual(seen, [1, 1]);
  // Not events.once: it would reject with the very error the entry handles.
  if (!socket.closed) await new Promise((resolve) => socket.on("close", resolve));
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.destroyed, true);
  off();
  assert.equal(server.listenerCount("upgrade"), 1);
});
