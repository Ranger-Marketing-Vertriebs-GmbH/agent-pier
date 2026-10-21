import test from "node:test";
import assert from "node:assert/strict";
import { appDocumentPath } from "../../server/http/security.js";
import { readUserRoute, userRoutePath } from "../../web/features/users/user-routes.js";

const at = (href) => {
  const url = new URL(href, "http://pier.test");
  return readUserRoute({ pathname: url.pathname, search: url.search });
};

test("a user's routes cover her agents, chats, settings, browser and account", () => {
  assert.deepEqual(at("/"), { view: "agents" });
  assert.deepEqual(at("/agents"), { view: "agents" });
  assert.deepEqual(at("/agents/"), { view: "agents" });
  assert.deepEqual(at("/agents/a1/chats/c-1"), {
    view: "chat",
    agentId: "a1",
    conversationId: "c-1",
  });
  assert.deepEqual(at("/agents/a1/settings"), { view: "settings", agentId: "a1" });
  assert.deepEqual(at("/agents/a1/settings?page=memory"), {
    view: "settings",
    agentId: "a1",
    page: "memory",
  });
  assert.deepEqual(at("/agents/a1/settings?page=other"), {
    view: "settings",
    agentId: "a1",
  });
  assert.deepEqual(at("/agents/a1/browser"), { view: "browser", agentId: "a1" });
  assert.deepEqual(at("/account"), { view: "account" });
});

test("anything else of the owner's app is missing in hers", () => {
  for (const href of [
    "/sessions/s1",
    "/settings",
    "/settings/users",
    "/agents/a1",
    "/agents/a1/teams/t1",
    "/agents/a b/settings",
    "/inbox",
    "/projects",
  ])
    assert.deepEqual(at(href), { view: "missing" }, href);
});

test("every route has a path that reads back to it and a deep link the server serves", () => {
  for (const route of [
    { view: "agents" },
    { view: "chat", agentId: "a1", conversationId: "c1" },
    { view: "settings", agentId: "a1" },
    { view: "settings", agentId: "a1", page: "memory" },
    { view: "browser", agentId: "a1" },
    { view: "account" },
  ]) {
    const path = userRoutePath(route);
    assert.deepEqual(at(path), route, path);
    assert.equal(appDocumentPath.test(path.split("?")[0]), true, path);
  }
  assert.equal(userRoutePath({ view: "missing" }), "/agents");
});

test("the owner's users page is a deep link the server serves", () => {
  assert.equal(appDocumentPath.test("/settings/users"), true);
  assert.equal(appDocumentPath.test("/agents/a1/browser"), true);
});
