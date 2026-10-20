import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";
import { routeInventory } from "../../server/http/route-inventory.js";
import {
  agentScoped,
  contentKinds,
  ownerContentRoutes,
  ownerMetadataRoutes,
} from "../../server/http/owner-content-routes.js";

test("every agent-scoped route is classified exactly once", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const keys = new Set(
    routeInventory(f.application)
      .filter((route) => !route.regex)
      .map(({ method, path }) => `${method} ${path}`),
  );
  const scoped = [...keys].filter((key) =>
    agentScoped.some((pattern) => pattern.test(key.slice(key.indexOf(" ") + 1))),
  );
  assert.ok(scoped.length > 40, `found ${scoped.length} agent-scoped routes`);
  for (const key of scoped) {
    const places =
      Number(key in ownerContentRoutes) + Number(ownerMetadataRoutes.has(key));
    assert.equal(places, 1, `${key} must be classified exactly once`);
  }
  for (const key of [...Object.keys(ownerContentRoutes), ...ownerMetadataRoutes])
    assert.ok(scoped.includes(key), `stale classification ${key}`);
  for (const [key, kind] of Object.entries(ownerContentRoutes))
    assert.ok(contentKinds.includes(kind), `${key}: unknown kind ${kind}`);
});

test("the examples of private content are classified as content", () => {
  assert.equal(
    ownerContentRoutes["GET /api/assistant-conversations/:id/messages"],
    "conversation",
  );
  assert.equal(ownerContentRoutes["GET /api/assistant-attachments/:file"], "attachment");
  assert.equal(ownerContentRoutes["GET /api/assistants/:id/memory"], "agent");
  assert.equal(ownerContentRoutes["GET /api/assistants/:id/browser"], "agent");
});
