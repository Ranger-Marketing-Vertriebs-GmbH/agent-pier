import test from "node:test";
import assert from "node:assert/strict";
import { readRoute, routePath } from "../../web/app/routes.js";
import { appDocumentPath } from "../../server/http/security.js";
test("assistant deep links retain selected chat and settings with server document support", () => {
  for (const [pathname, expected] of [
    ["/agents", { view: "agents" }],
    [
      "/agents/home/chats/dinner",
      { view: "agents", assistantId: "home", conversationId: "dinner" },
    ],
    [
      "/agents/home/teams/team-1",
      { view: "agents", assistantId: "home", teamId: "team-1" },
    ],
    [
      "/agents/home/settings",
      { view: "agents", assistantId: "home", agentSettings: true },
    ],
  ]) {
    assert.deepEqual(readRoute({ pathname }), expected);
    assert.equal(routePath(expected), pathname);
    assert.ok(appDocumentPath.test(pathname));
  }
  assert.deepEqual(readRoute({ pathname: "/settings/assistants" }), {
    view: "agents",
    agentsTab: "runtime",
  });
  assert.equal(readRoute({ pathname: "/agents/../../private" }).view, "missing");
});
test("the new-agent flow has its own address", () => {
  const route = readRoute({ pathname: "/agents", search: "?new=1" });
  assert.deepEqual(route, { view: "agents", creating: true });
  assert.equal(routePath(route), "/agents?new=1");
  assert.deepEqual(readRoute({ pathname: "/agents", search: "" }), { view: "agents" });
  // "Create agent" from an Agency entry carries the template and its revision.
  const revision = "a".repeat(40);
  const templated = readRoute({
    pathname: "/agents",
    search: `?new=1&template=engineering__frontend&revision=${revision}`,
  });
  assert.deepEqual(templated, {
    view: "agents",
    creating: true,
    template: { id: "engineering__frontend", revision },
  });
  assert.equal(
    routePath(templated),
    `/agents?new=1&template=engineering__frontend&revision=${revision}`,
  );
  assert.deepEqual(readRoute({ pathname: "/agents", search: "?new=1&template=x" }), {
    view: "agents",
    creating: true,
  });
});
