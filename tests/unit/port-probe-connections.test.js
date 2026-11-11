import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { closeConnection } from "../../server/lib/socket-errors.js";

const root = path.resolve(import.meta.dirname, "../..");

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

test("no listener accepts connections without handling them", async () => {
  // net.createServer() without a connection listener still accepts sockets.
  const offenders = (await serverSources())
    .filter(({ text }) => /net\.createServer\(\s*\)/.test(text))
    .map(({ file }) => file);
  assert.deepEqual(offenders, [], "pass closeConnection (server/lib/socket-errors.js)");
});

async function listening(t, server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return server.address().port;
}

test("a port probe closes whoever connects to it", async (t) => {
  const port = await listening(t, net.createServer(closeConnection));
  const client = net.connect({ host: "127.0.0.1", port });
  client.on("error", () => {});
  client.resume();
  await new Promise((resolve) => client.on("close", resolve));
});
