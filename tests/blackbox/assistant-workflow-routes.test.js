import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { assistantWorkflowRoutes } from "../../server/http/routes/assistant-workflows.js";

test("owner workflow routes preserve policy/action revisions and sanitize upstream failures", async (t) => {
  const f = await workflowFixture(t),
    app = express();
  app.use(express.json());
  app.use((req, res, next) =>
    req.headers.authorization === "Bearer owner" ? next() : res.sendStatus(401),
  );
  app.use(assistantWorkflowRoutes({ assistants: f.assistants }));
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message }),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = (route, method = "GET", body) =>
    fetch(url + route, {
      method,
      headers: { authorization: "Bearer owner", "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const access = `/assistants/${f.id}/access`;
  assert.equal((await fetch(url + access)).status, 401);
  assert.equal((await call(access)).status, 200);
  assert.equal((await call(access, "PUT", { ...f.policy, revision: 0 })).status, 200);
  assert.equal((await call(access, "PUT", { ...f.policy, revision: 0 })).status, 409);
  const a = await f.workflows.invoke(await f.invocation(), {
    action: "memory_write",
    projectId: f.project.id,
    title: "Reviewed",
    content: "Exact proposal",
  });
  const decision = `/assistant-actions/${a.id}/decision`;
  assert.equal(
    (
      await call(decision, "POST", {
        revision: a.revision,
        decision: "approve",
        content: "Substitution",
      })
    ).status,
    400,
  );
  assert.equal(
    (await call(decision, "POST", { revision: a.revision, decision: "approve" })).status,
    200,
  );
  assert.equal(
    (await call(decision, "POST", { revision: a.revision, decision: "approve" })).status,
    409,
  );
  f.workflows.access.catalog = () => {
    throw Error("private-config-key");
  };
  const failed = await call("/assistant-workspace-catalog");
  assert.equal(failed.status, 503);
  assert.ok(!(await failed.text()).includes("private-config-key"));
});
