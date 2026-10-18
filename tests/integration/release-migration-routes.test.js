import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { operationsRoutes } from "../../server/http/routes/operations.js";
import { registerResponses } from "../../server/http/responses.js";

function app(releaseMigration, operations = {}) {
  const application = express();
  application.use(express.json());
  application.use("/api", operationsRoutes({ operations, releaseMigration }));
  registerResponses(application);
  return application;
}
async function request(application, method, path, body) {
  const server = application.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
    };
  } finally {
    server.close();
  }
}

test("migration routes validate the version and forward to the service", async () => {
  const calls = [];
  const migration = {
    plan: async (version) => (calls.push(["plan", version]), { version, sessions: [] }),
    migrate: (version, body) => (calls.push(["migrate", version, body]), { id: "job-1" }),
    cancel: (version) => calls.push(["cancel", version]),
  };
  const application = app(migration);
  assert.deepEqual(
    await request(application, "GET", "/api/operations/releases/cleanup/1.0.0/sessions"),
    { status: 200, body: { version: "1.0.0", sessions: [] } },
  );
  assert.deepEqual(
    await request(application, "POST", "/api/operations/releases/cleanup/1.0.0/migrate", {
      interrupt: true,
    }),
    { status: 202, body: { job: { id: "job-1" } } },
  );
  assert.equal(
    (
      await request(
        application,
        "POST",
        "/api/operations/releases/cleanup/1.0.0/migrate",
        { other: 1 },
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        application,
        "DELETE",
        "/api/operations/releases/cleanup/1.0.0/migrate",
      )
    ).status,
    204,
  );
  assert.equal(
    (
      await request(
        application,
        "GET",
        "/api/operations/releases/cleanup/..%2Fx/sessions",
      )
    ).status,
    400,
  );
  assert.deepEqual(calls, [
    ["plan", "1.0.0"],
    ["migrate", "1.0.0", { interrupt: true }],
    ["cancel", "1.0.0"],
  ]);
});

test("activate route forwards stagedId and reloadSessions to operations.activate", async () => {
  const calls = [];
  const operations = {
    activate: (input) => {
      calls.push(input);
      return { id: "job-a" };
    },
  };
  const application = app({}, operations);
  assert.deepEqual(
    await request(application, "POST", "/api/operations/releases/activate", {
      stagedId: "s",
      reloadSessions: true,
    }),
    { status: 202, body: { job: { id: "job-a" } } },
  );
  assert.deepEqual(calls, [{ stagedId: "s", reloadSessions: true }]);
});

test("stopping a version's orphaned processes forwards the chosen pids and audits it", async () => {
  const calls = [];
  const audits = [];
  const { Operations } = await import("../../server/features/operations/operations.js");
  const operations = Object.create(Operations.prototype);
  operations.releases = {
    stopOrphans: async (version, pids) => (
      calls.push([version, pids]),
      { stopped: pids }
    ),
  };
  operations.audit = { append: (entry) => audits.push(entry) };
  const application = app({}, operations);
  const path = "/api/operations/releases/cleanup/1.0.0/stop-processes";
  assert.deepEqual(await request(application, "POST", path, { pids: [4242] }), {
    status: 200,
    body: { stopped: [4242] },
  });
  assert.deepEqual(calls, [["1.0.0", [4242]]]);
  assert.equal(audits[0].action, "release.stopped");
  assert.deepEqual(audits[0].details, { version: "1.0.0", count: 1 });
  assert.equal((await request(application, "POST", path, { other: 1 })).status, 400);
  assert.equal(
    (
      await request(
        application,
        "POST",
        "/api/operations/releases/cleanup/x/stop-processes",
        {
          pids: [1],
        },
      )
    ).status,
    400,
  );
});
