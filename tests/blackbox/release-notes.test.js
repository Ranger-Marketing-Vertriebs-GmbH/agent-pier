import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Releases } from "../../server/features/operations/releases.js";
import { operationsRoutes } from "../../server/http/routes/operations.js";

test("release notes HTTP reads are version-scoped and do not stage or activate updates", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-notes-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const releases = new Releases({
    dataDir,
    fetchImpl: async () =>
      Response.json({
        tag_name: "v1.17.5",
        draft: false,
        body: "## Fixes\n\n- Every question is visible.",
      }),
  });
  const app = express();
  app.use("/api", operationsRoutes({ operations: { releases } }));
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/operations/releases/notes/`;
  const response = await fetch(url + "1.17.5");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).body, "## Fixes\n\n- Every question is visible.");
  assert.equal((await fetch(url + "invalid")).status, 400);
  assert.deepEqual(await fs.readdir(releases.directory), []);
});
