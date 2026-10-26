import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createServer } from "vite";
import { createApplication } from "../../server/app.js";
import { devOrigins } from "../../server/lib/dev-ports.js";

const root = path.resolve(import.meta.dirname, "../..");

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

// A two-port block like a stage lease: the first port is free now, the second is
// checked by Vite itself (strictPort), so a busy neighbour just picks another block.
async function freeBlock() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const probe = net.createServer();
    const base = await listen(probe, 0);
    await new Promise((resolve) => probe.close(resolve));
    if (base < 65535) return base;
  }
  throw new Error("No free port block");
}

test("npm run dev on a leased block serves on its second port and reaches the backend on its first", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vite-dev-ports-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  await fs.mkdir(home, { mode: 0o700 });
  const saved = { ...process.env };
  t.after(() => {
    for (const key of ["AGENTPIER_PORT", "AGENTPIER_PORT_COUNT", "TUIUI_PORT"])
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
  });
  delete process.env.TUIUI_PORT;

  let application, vite, base;
  for (let attempt = 0; !vite && attempt < 5; attempt++) {
    base = await freeBlock();
    Object.assign(process.env, {
      AGENTPIER_PORT: String(base),
      AGENTPIER_PORT_COUNT: "2",
    });
    application = await createApplication({
      dataDir: path.join(dir, `data-${attempt}`),
      home,
      port: base,
      remoteUrl: null,
      ownerLogin: null,
      devOrigins: devOrigins(process.env),
      network: { enabled: false },
    });
    try {
      await listen(application.server, base);
      vite = await createServer({
        root,
        configFile: path.join(root, "vite.config.js"),
        logLevel: "silent",
        server: { hmr: false },
      });
      await vite.listen();
    } catch (error) {
      await vite?.close();
      vite = undefined;
      await application.close();
      // Vite reports a busy strictPort only by message.
      if (error.code !== "EADDRINUSE" && !/already in use/.test(error.message))
        throw error;
    }
  }
  assert.ok(vite, "a free two-port block");
  t.after(() => application.close());
  t.after(() => vite.close());

  const address = vite.httpServer.address();
  assert.equal(address.port, base + 1, "Vite listens on the block's second port");

  const page = await fetch(`http://127.0.0.1:${base + 1}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<div id="root"|<script/);

  // Proxied through Vite: the backend sees Host 127.0.0.1:<base + 1>, which only the
  // derived dev origin admits.
  const health = await fetch(`http://127.0.0.1:${base + 1}/api/health`);
  assert.equal(health.status, 200);
  assert.ok((await health.json()).version);

  const direct = await fetch(`http://127.0.0.1:${base}/api/health`);
  assert.equal(direct.status, 200, "the backend listens on the block's first port");
});
