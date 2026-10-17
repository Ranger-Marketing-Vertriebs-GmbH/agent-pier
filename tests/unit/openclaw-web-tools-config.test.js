import test from "node:test";
import assert from "node:assert/strict";
import {
  compileOpenClawConfig,
  runtimeEnvironment,
} from "../../server/features/assistants/runtime-config.js";
import { agentEntry } from "../../server/features/assistants/openclaw-config/agent-entry.js";
import {
  webToolsAvailability,
  webToolsSections,
  webToolsSignature,
  webToolsSnapshot,
} from "../../server/features/assistants/openclaw-config/web-tools.js";
import { usedCapabilities } from "../../server/features/assistants/native-capabilities.js";

const port = 20000;
const paths = { workspaces: "/data/workspaces", logs: "/data/logs" };
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const plugins = {
  duckduckgo: {
    id: "duckduckgo",
    directory: "/rt/app/node_modules/@openclaw/duckduckgo-plugin",
  },
  perplexity: {
    id: "perplexity",
    directory: "/rt/app/node_modules/@openclaw/perplexity-plugin",
  },
  brave: { id: "brave", directory: "/rt/app/node_modules/@openclaw/brave-plugin" },
};
const allCapabilities = {
  memory: true,
  reminders: true,
  webSearch: true,
  webFetch: true,
  browser: true,
  documents: true,
};
const personal = {
  id: "a1",
  runtimeAgentId: "ap-a1",
  capabilities: allCapabilities,
};
// A temporary team member: its own capabilities never apply.
const member = {
  id: "m1",
  runtimeAgentId: "ap-m1",
  teamMemberId: "t1",
  lifetime: "temporary",
  capabilities: allCapabilities,
};
// A temporary member of `personal` as the store resolves it: its lead's capabilities.
const follower = {
  id: "m2",
  runtimeAgentId: "ap-m2",
  teamMemberId: "t2",
  lifetime: "task",
  parentAssistantId: "a1",
  inherited: { capabilities: allCapabilities, skills: [], shell: "off", ssh: false },
};
const plain = {
  id: "a2",
  runtimeAgentId: "ap-a2",
  capabilities: { memory: true, reminders: true },
};
const webTools = (extra = {}) => ({
  search: { provider: "duckduckgo", requiresPlugin: true },
  browser: { available: true, name: "Chrome", executablePath: chrome },
  searchPlugins: plugins,
  ...extra,
});

function compile(profiles, tools, browser = { enabled: false }) {
  const existing = {
    agents: {
      defaults: {},
      entries: Object.fromEntries(
        profiles.map((p) => [p.runtimeAgentId, { id: p.runtimeAgentId }]),
      ),
    },
    browser,
  };
  return compileOpenClawConfig({
    existing,
    paths,
    port,
    token: "gateway-token",
    teams: {
      directory: "/private/plugin",
      connection: { url: "http://127.0.0.1:1235", token: "bridge" },
      hostMaxConcurrent: 4,
      native: { token: "hook" },
      profiles,
    },
    ...(tools === undefined ? {} : { webTools: tools }),
  });
}
const nativeAllow = [
  "session_status",
  "agentpier_team_propose",
  "agentpier_team_status",
  "agentpier_team_stop",
  "agentpier_team_members",
  "agentpier_team_ask",
  "agentpier_team_delegate",
  "agentpier_team_cancel",
  "agentpier_team_archive",
  "agentpier_team_grant",
  "agentpier_team_member_update",
  "agentpier_team_promote",
  "memory_search",
  "memory_get",
  "read",
  "write",
  "edit",
  "agentpier_reminder",
  "agentpier_routine",
  "agentpier_workspace",
  "agentpier_ssh",
  "agentpier_share_file",
];
const agentAllow = (config, id) => config.agents.entries[id].tools.allow;

test("no agent with web tools leaves tools and browser exactly as before", () => {
  const before = compile([plain, member]);
  const after = compile([plain, member], webTools());
  assert.equal(JSON.stringify(after), JSON.stringify(before));
  assert.deepEqual(after.browser, { enabled: false });
  assert.equal(after.tools.web, undefined);
  assert.deepEqual(after.tools.allow, nativeAllow);
  assert.deepEqual(after.plugins.allow, ["agentpier-teams", "openai", "memory-core"]);
  assert.deepEqual(after.plugins.load, { paths: ["/private/plugin"] });
  assert.deepEqual(Object.keys(after.plugins.entries), [
    "agentpier-teams",
    "memory-core",
  ]);
  assert.ok(!agentAllow(after, "ap-a2").some((t) => /web_|browser|pdf/.test(t)));
  assert.deepEqual(usedCapabilities([plain, member]), new Set(["memory", "reminders"]));
});

test("an agent with web fetch adds the tool globally with a private-network block", () => {
  const config = compile(
    [{ ...personal, capabilities: { webFetch: true } }, plain],
    webTools(),
  );
  assert.deepEqual(config.tools.allow, [...nativeAllow, "web_fetch"]);
  assert.deepEqual(config.tools.web, {
    fetch: { ssrfPolicy: { dangerouslyAllowPrivateNetwork: false } },
  });
  assert.deepEqual(config.browser, { enabled: false });
  assert.deepEqual(config.plugins.allow, ["agentpier-teams", "openai", "memory-core"]);
  assert.ok(agentAllow(config, "ap-a1").includes("web_fetch"));
  assert.ok(!agentAllow(config, "ap-a2").includes("web_fetch"));
});

test("web search uses the configured provider and its key", () => {
  const profiles = [{ ...personal, capabilities: { webSearch: true } }];
  const duck = compile(profiles, webTools());
  assert.deepEqual(duck.tools.web, { search: { provider: "duckduckgo" } });
  assert.deepEqual(duck.tools.allow, [...nativeAllow, "web_search"]);
  assert.deepEqual(duck.plugins.allow, [
    "agentpier-teams",
    "openai",
    "memory-core",
    "duckduckgo",
  ]);
  assert.deepEqual(duck.plugins.load.paths, [
    "/private/plugin",
    plugins.duckduckgo.directory,
  ]);
  assert.equal(duck.plugins.entries.duckduckgo, undefined);
  assert.ok(agentAllow(duck, "ap-a1").includes("web_search"));

  const brave = compile(
    profiles,
    webTools({ search: { provider: "brave", key: "BSA-fixture", requiresPlugin: true } }),
  );
  assert.deepEqual(brave.tools.web, { search: { provider: "brave" } });
  assert.deepEqual(brave.plugins.allow, [
    "agentpier-teams",
    "openai",
    "memory-core",
    "brave",
  ]);
  assert.deepEqual(brave.plugins.load.paths, [
    "/private/plugin",
    plugins.brave.directory,
  ]);
  assert.deepEqual(brave.plugins.entries.brave, {
    config: { webSearch: { apiKey: "BSA-fixture" } },
  });
  // The team plugin and memory entries stay intact.
  assert.equal(brave.plugins.entries["agentpier-teams"].enabled, true);
  assert.equal(brave.plugins.entries["memory-core"].enabled, true);

  const perplexity = compile(
    profiles,
    webTools({
      search: { provider: "perplexity", key: "sk-or-fixture", requiresPlugin: true },
    }),
  );
  assert.deepEqual(perplexity.tools.web, { search: { provider: "perplexity" } });
  assert.deepEqual(perplexity.plugins.entries.perplexity, {
    config: { webSearch: { apiKey: "sk-or-fixture" } },
  });
  assert.deepEqual(perplexity.plugins.load.paths, [
    "/private/plugin",
    plugins.perplexity.directory,
  ]);
});

test("an unavailable provider keeps web_search out of every tool list", () => {
  const unavailable = compile(
    [personal],
    webTools({ search: { provider: "brave", requiresPlugin: true, unavailable: true } }),
  );
  // The plugin of a runtime installed before the plugins were bundled is missing.
  const noPlugins = compile([personal], webTools({ searchPlugins: {} }));
  const missing = compile(
    [personal],
    webTools({ searchPlugins: { brave: plugins.brave, perplexity: plugins.perplexity } }),
  );
  for (const config of [unavailable, noPlugins, missing]) {
    assert.ok(!config.tools.allow.includes("web_search"));
    assert.ok(!agentAllow(config, "ap-a1").includes("web_search"));
    assert.equal(config.tools.web.search, undefined);
    assert.deepEqual(config.tools.web.fetch, {
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
    });
    assert.ok(!config.plugins.allow.some((id) => Object.hasOwn(plugins, id)));
    assert.deepEqual(config.plugins.load.paths, ["/private/plugin"]);
    // The other capabilities still apply.
    assert.ok(config.tools.allow.includes("web_fetch"));
    assert.ok(config.tools.allow.includes("browser"));
  }
  assert.deepEqual(webToolsAvailability(webTools({ searchPlugins: {} })), {
    browser: true,
    webSearch: false,
  });
});

test("the browser block uses only the isolated profile without JavaScript evaluation", () => {
  const config = compile([{ ...personal, capabilities: { browser: true } }], webTools());
  assert.deepEqual(config.browser, {
    enabled: true,
    defaultProfile: "openclaw",
    evaluateEnabled: false,
    allowSystemProfileImport: false,
    headless: true,
    executablePath: chrome,
    extraArgs: ["--use-mock-keychain"],
    profiles: {
      user: { driver: "openclaw", cdpPort: port + 12 },
      chrome: { driver: "openclaw", cdpPort: port + 13 },
      "member-1": { driver: "openclaw", cdpPort: port + 14, headless: true },
      "member-2": { driver: "openclaw", cdpPort: port + 15, headless: true },
      "member-3": { driver: "openclaw", cdpPort: port + 16, headless: true },
      "agent-a1": { driver: "openclaw", cdpPort: port + 20, headless: true },
    },
  });
  // The default policy blocks private targets; an explicit false breaks navigation.
  assert.equal(config.browser.ssrfPolicy, undefined);
  for (const profile of Object.values(config.browser.profiles))
    assert.equal(profile.driver, "openclaw");
  assert.deepEqual(config.tools.allow, [...nativeAllow, "browser"]);
  assert.deepEqual(config.plugins.allow, [
    "agentpier-teams",
    "openai",
    "memory-core",
    "browser",
  ]);
  assert.equal(config.tools.web, undefined);
  // The agent gets the browser once the tool guard reported (write-guard-reapply.js).
  assert.ok(!agentAllow(config, "ap-a1").includes("browser"));
});

test("a missing browser withholds the tool even when an agent has the capability", () => {
  const config = compile(
    [{ ...personal, capabilities: { browser: true, documents: true } }],
    webTools({ browser: { available: false } }),
  );
  assert.ok(!config.tools.allow.includes("browser"));
  assert.ok(!agentAllow(config, "ap-a1").includes("browser"));
  assert.deepEqual(config.browser, { enabled: false });
  assert.deepEqual(config.plugins.allow, ["agentpier-teams", "openai", "memory-core"]);
  // Documents need no detection.
  assert.deepEqual(config.tools.allow, [...nativeAllow, "view_image"]);
  // Without any web tools input nothing is detected either.
  const unknown = compile([{ ...personal, capabilities: { browser: true } }]);
  assert.deepEqual(unknown.browser, { enabled: false });
  assert.ok(!agentAllow(unknown, "ap-a1").includes("browser"));
});

test("a temporary team member's own capabilities give it no web tools", () => {
  const config = compile([member], webTools());
  assert.deepEqual(config.tools.allow, nativeAllow);
  assert.deepEqual(config.browser, { enabled: false });
  assert.equal(config.tools.web, undefined);
  assert.deepEqual(agentAllow(config, "ap-m1"), [
    "session_status",
    "agentpier_workspace",
    "agentpier_share_file",
  ]);
  assert.deepEqual(webToolsSections({ profiles: [member], webTools: webTools(), port }), {
    tools: [],
    web: undefined,
    browser: undefined,
    plugins: { allow: [], paths: [], entries: {} },
  });
});

test("a temporary member uses its lead's web tools without widening the global sections", () => {
  const tools = webTools();
  const config = compile([personal, follower], tools);
  assert.deepEqual(
    agentAllow(config, "ap-m2"),
    agentAllow(config, "ap-a1").filter(
      (tool) =>
        !tool.startsWith("agentpier_team_") &&
        !["write", "edit", "agentpier_routine"].includes(tool),
    ),
  );
  assert.deepEqual(
    webToolsSections({ profiles: [personal, follower], webTools: tools, port }),
    webToolsSections({ profiles: [personal], webTools: tools, port }),
  );
  assert.deepEqual([...usedCapabilities([follower])], []);
});

test("the search key appears only in the provider's plugin entry", () => {
  const key = "BSA-secret-fixture-7f3a";
  const tools = webTools({ search: { provider: "brave", key, requiresPlugin: true } });
  const config = compile([personal], tools);
  const copy = structuredClone(config);
  delete copy.plugins.entries.brave.config.webSearch.apiKey;
  assert.ok(!JSON.stringify(copy).includes(key));
  assert.equal(config.plugins.entries.brave.config.webSearch.apiKey, key);
  const env = runtimeEnvironment(
    { home: "/h", tmp: "/t", state: "/s", config: "/c" },
    "/node/bin/node",
    { BRAVE_API_KEY: key, PATH: "/usr/bin" },
  );
  assert.ok(!JSON.stringify(env).includes(key));
  // The per-agent entry never carries it.
  const entry = agentEntry({ id: "ap-a1" }, personal, {
    teamsReady: true,
    nativeReady: true,
    guardProven: true,
    available: webToolsAvailability(tools),
  });
  assert.ok(!JSON.stringify(entry).includes(key));
});

test("a start and a live apply grant the same web tools", () => {
  const tools = webTools({ browser: { available: false } });
  const config = compile([personal], tools);
  const live = agentEntry({ id: "ap-a1" }, personal, {
    teamsReady: true,
    nativeReady: true,
    guardProven: false,
    available: webToolsAvailability(tools),
  });
  assert.deepEqual(agentAllow(config, "ap-a1"), live.tools.allow);
  assert.ok(live.tools.allow.includes("web_search"));
  assert.ok(!live.tools.allow.includes("browser"));
});

test("a stale browser block from an earlier start never survives", () => {
  const stale = {
    enabled: true,
    executablePath: "/old/chrome",
    cdpUrl: "http://127.0.0.1:9222",
    profiles: { user: { driver: "existing-session" } },
  };
  // The capability was switched off: the hardened block replaces it outright.
  assert.deepEqual(compile([plain], webTools(), stale).browser, { enabled: false });
  // Still on: only the verified block remains, without the stale keys.
  const active = compile([personal], webTools(), stale).browser;
  assert.deepEqual(
    active,
    webToolsSections({ profiles: [personal], webTools: webTools(), port }).browser,
  );
  assert.equal("cdpUrl" in active, false);
});

test("the running state signs the global sections without keeping the key", () => {
  const brave = (key) =>
    webTools({ search: { provider: "brave", key, requiresPlugin: true } });
  const snapshot = webToolsSnapshot({ profiles: [personal], webTools: brave("k-one") });
  assert.equal(JSON.stringify(snapshot).includes("k-one"), false);
  assert.deepEqual(snapshot.availability, { browser: true, webSearch: true });
  assert.deepEqual(snapshot.searchPlugins, plugins);
  const sign = (profiles, tools) => webToolsSignature({ profiles, webTools: tools });
  assert.equal(sign([personal], brave("k-one")), snapshot.signature);
  // A new key, provider or browser, or an agent with new tools, changes it.
  assert.notEqual(sign([personal], brave("k-two")), snapshot.signature);
  assert.notEqual(sign([personal], webTools()), snapshot.signature);
  assert.notEqual(
    sign([personal], { ...brave("k-one"), browser: { available: false } }),
    snapshot.signature,
  );
  assert.notEqual(sign([plain], brave("k-one")), snapshot.signature);
  // Agents without web tools and temporary members leave it as it is.
  assert.equal(sign([personal, plain, member], brave("k-one")), snapshot.signature);
  // A lead's temporary member follows the lead and leaves it as well.
  assert.equal(sign([personal, follower], brave("k-one")), snapshot.signature);
});
