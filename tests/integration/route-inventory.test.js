import test from "node:test";
import { Router } from "express";
import assert from "node:assert/strict";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";
import { routeInventory } from "../../server/http/route-inventory.js";

test("inventory lists every registered API route once", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const routes = routeInventory(f.application);
  const keys = routes.map(({ method, path }) => `${method} ${path}`);
  for (const expected of [
    "GET /api/assistants",
    "POST /api/assistant-conversations/:id/messages",
    "GET /api/assistant-events",
    "GET /api/inbox/events",
    "GET /api/health",
    "POST /api/users",
    "GET /api/me",
    "POST /api/operations/backups",
    "GET /api/mcp-servers/oauth/callback",
    "GET /api/connections/usage",
    "GET /api/connections/problems",
  ])
    assert.ok(keys.includes(expected), expected);
  assert.deepEqual(
    keys.filter((key, index) => keys.indexOf(key) !== index),
    [],
    "duplicate routes",
  );
  for (const route of routes) assert.match(route.path, /^\/api\//);
});

test("inventory reports the agent routes only while agents run", async (t) => {
  const f = await applicationFixture(t);
  const keys = routeInventory(f.application).map((r) => `${r.method} ${r.path}`);
  assert.ok(keys.includes("GET /api/assistant-feature"));
  assert.ok(!keys.includes("GET /api/assistants"));
});

test("inventory keeps a route registered twice, so the duplicate check can fail", () => {
  const first = Router();
  first.get("/assistants/:id/memory", () => {});
  const second = Router();
  second.get("/assistants/:id/memory", () => {});
  second.post("/assistants/:id/memory", () => {});
  const routes = routeInventory({
    apiRegistry: { entries: [{ router: first }, { router: second }] },
  });
  assert.deepEqual(
    routes.map(({ method, path }) => `${method} ${path}`),
    [
      "GET /api/assistants/:id/memory",
      "GET /api/assistants/:id/memory",
      "POST /api/assistants/:id/memory",
    ],
  );
});
