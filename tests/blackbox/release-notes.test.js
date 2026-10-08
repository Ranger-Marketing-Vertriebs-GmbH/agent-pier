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

test("release notes range HTTP reads validate both versions and return newest first", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-notes-range-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const requested = [];
  const releases = new Releases({
    dataDir,
    fetchImpl: async (url) => {
      requested.push(url);
      return Response.json(
        ["1.24.1", "1.24.0", "1.23.0"].map((version) => ({
          tag_name: `v${version}`,
          draft: false,
          prerelease: false,
          published_at: "2026-10-01T10:00:00Z",
          body: `Notes ${version}`,
        })),
      );
    },
  });
  const app = express();
  app.use("/api", operationsRoutes({ operations: { releases } }));
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/operations/releases/notes`;
  const response = await fetch(`${url}?from=1.23.0&to=1.24.1`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(
    body.releases.map((entry) => entry.version),
    ["1.24.1", "1.24.0"],
  );
  assert.equal(requested.length, 1);
  assert.equal((await fetch(`${url}?from=bad&to=1.24.1`)).status, 400);
  assert.equal((await fetch(`${url}?from=1.23.0`)).status, 400);
  assert.equal((await fetch(`${url}?from=1.0.0&from=1.1.0&to=1.24.1`)).status, 400);
  assert.deepEqual(await fs.readdir(releases.directory), []);
});
