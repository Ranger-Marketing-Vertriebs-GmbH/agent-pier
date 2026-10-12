import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Releases } from "../../server/features/operations/releases.js";
import { operationsRoutes } from "../../server/http/routes/operations.js";

test("channel settings HTTP persists only valid selections without staging updates", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-channel-http-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const releases = new Releases({ dataDir, channel: "" });
  const app = express();
  app.use(express.json());
  app.use("/api", operationsRoutes({ operations: { releases } }));
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/operations/releases`;
  const put = (body) =>
    fetch(`${url}/channel`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal((await (await fetch(url)).json()).updateChannel, "stable");
  const response = await put({ updateChannel: "preview" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).updateChannel, "preview");
  for (const body of [
    {},
    { updateChannel: "beta" },
    { updateChannel: "stable", url: "https://example.com" },
  ]) {
    assert.equal((await put(body)).status, 400);
  }
  assert.equal(new Releases({ dataDir, channel: "" }).status().updateChannel, "preview");
  assert.deepEqual(await fs.readdir(releases.directory), []);
});
