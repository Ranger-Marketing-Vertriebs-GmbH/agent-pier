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
  assert.equal(
    readRoute({ pathname: "/settings/assistants" }).settingsSection,
    "assistants",
  );
  assert.equal(readRoute({ pathname: "/agents/../../private" }).view, "missing");
});
