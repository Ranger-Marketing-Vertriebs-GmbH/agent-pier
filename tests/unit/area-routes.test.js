import test from "node:test";
import assert from "node:assert/strict";
import { readRoute, routePath, screenRoute } from "../../web/app/routes.js";
import { screenOf } from "../../web/app/route-screens.js";
import { appDocumentPath } from "../../server/http/security.js";
import { agentsHubRoute } from "../../web/features/assistants/hub-routes.js";
import { codingRoute } from "../../web/features/coding/routes.js";
import { connectionsRoute } from "../../web/features/connections/routes.js";

const read = (path) => readRoute(new URL(path, "http://localhost"));

test("the agents hub tabs are deep-linkable", () => {
  assert.deepEqual(read("/agents"), { view: "agents" });
  assert.deepEqual(read("/agents?tab=all"), { view: "agents" });
  assert.equal(routePath(read("/agents?tab=all")), "/agents");
  for (const tab of ["teams", "templates", "runtime"]) {
    assert.deepEqual(read(`/agents?tab=${tab}`), { view: "agents", agentsTab: tab });
    assert.equal(routePath(agentsHubRoute(tab)), `/agents?tab=${tab}`);
  }
  assert.deepEqual(read("/agents?tab=runtime&section=advanced"), {
    view: "agents",
    agentsTab: "runtime",
    agentsSection: "advanced",
  });
  // The section belongs to Runtime only; unknown tabs open All agents.
  assert.deepEqual(read("/agents?tab=teams&section=advanced"), {
    view: "agents",
    agentsTab: "teams",
  });
  assert.deepEqual(read("/agents?tab=bogus"), { view: "agents" });
  // Only Runtime (the former agent service settings) honours returnTo.
  assert.equal(read("/agents?tab=teams&returnTo=%2Fsettings").returnTo, undefined);
  assert.equal(read("/agents?tab=runtime&returnTo=%2Fsettings").returnTo, "/settings");
});

test("Zugänge categories, items and wizard steps have their own addresses", () => {
  assert.deepEqual(read("/connections"), { view: "connections" });
  for (const section of [
    "models",
    "services",
    "mcp-servers",
    "ssh",
    "secrets",
    "github",
  ]) {
    const route = read(`/connections?section=${section}&item=x-1`);
    assert.deepEqual(route, { view: "connections", section, item: "x-1" });
    assert.equal(routePath(route), `/connections?section=${section}&item=x-1`);
    assert.deepEqual(connectionsRoute(section, "x-1"), route);
  }
  assert.equal(read("/connections?section=ssh&item=new&step=package").step, undefined);
  assert.equal(read("/connections?section=ssh&item=..%2Fx").item, undefined);
  assert.equal(read("/connections?section=bogus").section, undefined);
});

test("Coding › CLIs & Erweiterungen tabs and profile extensions", () => {
  assert.deepEqual(read("/coding/clis"), { view: "coding", codingTab: "install" });
  assert.equal(routePath(read("/coding/clis?tab=install")), "/coding/clis");
  assert.deepEqual(read("/coding/clis?tab=accounts&item=a-1"), {
    view: "coding",
    codingTab: "accounts",
    item: "a-1",
  });
  assert.deepEqual(read("/coding/clis?tab=mcp"), codingRoute("mcp"));
  assert.deepEqual(read("/coding/clis?tab=extensions"), codingRoute("extensions"));
  assert.equal(routePath(codingRoute("extensions")), "/coding/clis/extensions");
  for (const tab of ["plugins", "marketplaces", "subagents"]) {
    const route = read(`/coding/clis/extensions/local-codex?tab=${tab}`);
    assert.deepEqual(route, {
      view: "coding",
      codingTab: "extensions",
      profileId: "local-codex",
      extensionTab: tab,
    });
    assert.equal(routePath(route), `/coding/clis/extensions/local-codex?tab=${tab}`);
  }
  assert.equal(read("/coding/clis/extensions/p1?tab=bogus").extensionTab, "skills");
  assert.equal(read("/coding/clis/extensions/a%2Fb").view, "missing");
  assert.equal(read("/coding/clis/other").view, "missing");
  assert.equal(read("/coding/clis?tab=bogus").codingTab, "install");
});

test("the server serves the app document for every new area address", () => {
  for (const path of [
    "/connections",
    "/coding/clis",
    "/coding/clis/extensions",
    "/coding/clis/extensions/local-codex",
  ])
    assert.ok(appDocumentPath.test(path), path);
  assert.equal(appDocumentPath.test("/coding/clis/extensions/a/b"), false);
});

test("new areas render today's pages until they have their own", () => {
  const screen = (path) => screenRoute(read(path));
  assert.deepEqual(screen("/connections"), { view: "accounts" });
  assert.deepEqual(screen("/connections?section=models&item=c1"), {
    view: "accounts",
    section: "models",
    item: "c1",
  });
  for (const section of ["ssh", "secrets", "github"]) {
    const page = screen(`/connections?section=${section}&returnTo=%2Fagents`);
    assert.equal(page.view, "settings");
    assert.equal(page.settingsSection, section);
    assert.equal(page.returnTo, "/agents");
  }
  const mcp = screen("/coding/clis?tab=mcp&authorization=auth_one&cli=claude&page=2");
  assert.equal(mcp.settingsSection, "mcp");
  assert.equal(mcp.mcpAuthorization, "auth_one");
  assert.equal(mcp.mcpCli, "claude");
  assert.equal(mcp.mcpPage, 2);
  assert.deepEqual(screen("/coding/clis?tab=accounts&item=a1"), {
    view: "accounts",
    section: "cli",
    item: "a1",
  });
  assert.deepEqual(screen("/coding/clis/extensions/p1?tab=subagents"), {
    view: "extensions",
    profileId: "p1",
    extensionTab: "agents",
  });
  assert.deepEqual(screen("/coding/clis"), { view: "workspace", sessionId: "" });
  assert.equal(screen("/agents?tab=runtime").settingsSection, "assistants");
  assert.equal(
    screen("/agents?tab=runtime&section=advanced").settingsSection,
    "assistants-advanced",
  );
  assert.equal(screen("/agents?tab=templates").extensionTab, "agents");
  assert.deepEqual(screen("/agents?tab=teams"), { view: "agents" });
  // Agent pages and other areas are left as they are.
  const agent = read("/agents/home/settings?tab=access");
  assert.equal(screenRoute(agent), agent);
  const files = read("/files");
  assert.equal(screenRoute(files), files);
  // Guards compare old and new routes as the same page.
  assert.deepEqual(screenOf({ view: "accounts", section: "models" }), {
    view: "accounts",
    section: "models",
  });
  assert.equal(screenOf({ view: "settings", settingsSection: "ssh" }).view, "settings");
  assert.equal(screenOf(null), null);
});
