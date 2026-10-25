import test from "node:test";
import assert from "node:assert/strict";
import { readRoute, returnRoute, routePath } from "../../web/app/routes.js";

const read = (path) => readRoute(new URL(path, "http://localhost"));
const withReturn = (path, returnTo) =>
  `${path}${path.includes("?") ? "&" : "?"}${new URLSearchParams({ returnTo })}`;
const hook = "0f8b6a52-3c1d-4e2f-9a7b-5d6c8e9f0a1b";

// Handoff §4.2: every old address, the new address it lands on.
const redirects = [
  ["/settings/assistants", "/agents?tab=runtime"],
  ["/settings/assistants-advanced", "/agents?tab=runtime&section=advanced"],
  ["/settings?tab=workspace", "/settings"],
  ["/settings?tab=access", "/connections"],
  ["/settings/ssh", "/connections?section=ssh"],
  ["/settings/secrets", "/connections?section=secrets"],
  ["/settings/github", "/connections?section=github"],
  ["/settings/mcp", "/coding/clis?tab=mcp"],
  [
    "/settings/mcp?cli=claude&page=3&authorization=auth_one",
    "/coding/clis?tab=mcp&authorization=auth_one&cli=claude&page=3",
  ],
  ["/accounts?section=models", "/connections?section=models"],
  ["/accounts?section=models&item=conn-1", "/connections?section=models&item=conn-1"],
  ["/accounts?section=services&item=speech", "/connections?section=services&item=speech"],
  ["/accounts?section=mcp-servers", "/connections?section=mcp-servers"],
  [
    "/accounts?section=mcp-servers&item=new&step=package",
    "/connections?section=mcp-servers&item=new&step=package",
  ],
  [
    "/accounts?section=mcp-servers&item=s1&step=settings",
    "/connections?section=mcp-servers&item=s1&step=settings",
  ],
  ["/accounts?section=cli", "/coding/clis?tab=accounts"],
  ["/accounts?section=cli&item=acc-1", "/coding/clis?tab=accounts&item=acc-1"],
  ["/accounts", "/connections"],
  ["/extensions", "/coding/clis/extensions"],
  ["/extensions?tab=plugins", "/coding/clis/extensions?tab=plugins"],
  ["/extensions/local-codex", "/coding/clis/extensions/local-codex"],
  ["/extensions/local-codex?tab=skills", "/coding/clis/extensions/local-codex"],
  [
    "/extensions/local-codex?tab=plugins",
    "/coding/clis/extensions/local-codex?tab=plugins",
  ],
  [
    "/extensions/local-codex?tab=marketplaces",
    "/coding/clis/extensions/local-codex?tab=marketplaces",
  ],
  [
    "/extensions/local-codex?tab=agents",
    "/coding/clis/extensions/local-codex?tab=subagents",
  ],
  ["/extensions?tab=agents", "/coding/clis/extensions?tab=subagents"],
  ["/plugins", "/coding/clis/extensions?tab=plugins"],
  ["/plugins/local-claude", "/coding/clis/extensions/local-claude?tab=plugins"],
  ["/agents/home/settings?tab=profile", "/agents/home/settings?tab=identity"],
  ...["memory", "allowlist", "skills"].map((page) => [
    `/agents/home/settings?tab=capabilities&page=${page}`,
    `/agents/home/settings?tab=capabilities&page=${page}`,
  ]),
  ...["projects", "pipelines", "ssh", "github", "secrets"].map((page) => [
    `/agents/home/settings?tab=work&page=${page}`,
    `/agents/home/settings?tab=access&page=${page}`,
  ]),
  [
    "/agents/home/settings?tab=work&team=team-1",
    "/agents/home/settings?tab=team&team=team-1",
  ],
  [
    "/agents/home/settings?tab=work&page=actions",
    "/agents/home/settings?tab=overview&page=actions",
  ],
  ["/agents/home/settings?tab=work", "/agents/home/settings?tab=overview"],
  ["/agents/home/settings?tab=routines", "/agents/home/settings?tab=automation"],
  [
    `/agents/home/settings?tab=routines&page=hook&hook=${hook}`,
    `/agents/home/settings?tab=automation&page=hook&hook=${hook}`,
  ],
  ["/agents/home/settings?tab=telegram", "/agents/home/settings?tab=channels"],
  ...["telegram-activity", "telegram-connection"].map((page) => [
    `/agents/home/settings?tab=telegram&page=${page}`,
    `/agents/home/settings?tab=channels&page=${page}`,
  ]),
  ["/agents?new=1", "/agents?new=1"],
  ["/agents?new=1&user=u-1", "/agents?new=1&user=u-1"],
  [
    `/agents?new=1&template=engineering__frontend&revision=${"a".repeat(40)}`,
    `/agents?new=1&template=engineering__frontend&revision=${"a".repeat(40)}`,
  ],
];

test("every old address of handoff §4.2 lands on its new address", () => {
  for (const [old, next] of redirects) {
    const route = read(old);
    assert.notEqual(route.view, "missing", old);
    assert.equal(routePath(route), next, old);
    // The new address reads back to the same route and stays where it is.
    assert.deepEqual(read(next), route, next);
    assert.equal(routePath(read(next)), next, next);
  }
});

test("returnTo survives every redirect of a page that honours it", () => {
  const origin = "/agents/home/settings?tab=channels";
  for (const [old, next] of [
    ["/settings/assistants", "/agents?tab=runtime"],
    ["/settings/assistants-advanced", "/agents?tab=runtime&section=advanced"],
    ["/settings?tab=access", "/connections"],
    ["/settings/ssh", "/connections?section=ssh"],
    ["/settings/secrets", "/connections?section=secrets"],
    ["/settings/github", "/connections?section=github"],
    ["/settings/mcp?cli=claude", "/coding/clis?tab=mcp&cli=claude"],
    [
      "/accounts?section=services&item=speech",
      "/connections?section=services&item=speech",
    ],
    ["/accounts?section=cli&item=acc-1", "/coding/clis?tab=accounts&item=acc-1"],
    ["/accounts", "/connections"],
  ]) {
    const route = read(withReturn(old, origin));
    assert.equal(route.returnTo, origin, old);
    assert.equal(routePath(route), withReturn(next, origin), old);
    assert.equal(routePath(returnRoute(route)), origin, old);
  }
  // An old origin address is rebuilt as its new address.
  const fromOld = read(withReturn("/connections", "/agents/home/settings?tab=telegram"));
  assert.equal(fromOld.returnTo, origin);
  const nested = read(
    withReturn("/agents?tab=runtime", withReturn("/accounts?section=models", origin)),
  );
  assert.equal(nested.returnTo, withReturn("/connections?section=models", origin));
  assert.equal(returnRoute(returnRoute(nested)).agentTab, "channels");
});

test("MCP OAuth results on the old Accounts address reach Zugänge", () => {
  const route = read("/accounts?oauth=error&reason=state_mismatch&server=s1");
  assert.deepEqual(route, {
    view: "connections",
    mcpOAuth: { result: "error", serverId: "s1", reason: "state_mismatch" },
  });
  assert.equal(routePath(route), "/connections");
  const codex = read("/accounts?oauth=connected&cli=codex&account=acc-1");
  assert.equal(codex.view, "connections");
  assert.deepEqual(codex.mcpOAuth, {
    result: "connected",
    cli: "codex",
    accountId: "acc-1",
  });
});

test("pages that still build old routes get the new addresses", () => {
  for (const [route, path] of [
    [{ view: "settings", settingsSection: "assistants" }, "/agents?tab=runtime"],
    [{ view: "settings", settingsSection: "github" }, "/connections?section=github"],
    [
      { view: "settings", settingsSection: "general", settingsTab: "access" },
      "/connections",
    ],
    [{ view: "settings", settingsSection: "users" }, "/settings/users"],
    [{ view: "settings", settingsSection: "remote" }, "/settings/remote"],
    [{ view: "accounts" }, "/connections"],
    [
      { view: "accounts", section: "cli", item: "a1" },
      "/coding/clis?tab=accounts&item=a1",
    ],
    [
      { view: "extensions", profileId: "p1", extensionTab: "agents" },
      "/coding/clis/extensions/p1?tab=subagents",
    ],
    [
      { view: "agents", assistantId: "home", agentSettings: true, agentTab: "work" },
      "/agents/home/settings?tab=overview",
    ],
  ])
    assert.equal(routePath(route), path, JSON.stringify(route));
});
