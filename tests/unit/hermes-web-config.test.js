import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileHome } from "../../server/features/assistants/runtimes/hermes/hermes-config/home.js";
import { readHermesConfig } from "../../server/features/assistants/runtimes/hermes/hermes-config/home-merge.js";
import {
  braveKeyEnv,
  ddgsInstalled,
  perplexityKeyEnv,
  webHome,
} from "../../server/features/assistants/runtimes/hermes/hermes-config/web.js";
import { desiredAgent } from "../../server/features/assistants/agent-desired-state.js";
import { WebToolsChanges } from "../../server/features/assistants/web-tools-changes.js";

const agent = (capabilities, extra = {}) =>
  desiredAgent({
    id: "a1",
    runtimeAgentId: "ap-a1",
    revision: 1,
    capabilities,
    ...extra,
  });
const both = { webSearch: true, webFetch: true };
const home = (capabilities, web, existing) =>
  compileHome(agent(capabilities), { web, existing });
const config = (built) => readHermesConfig(built.files["config.yaml"]);
const env = (built) => built.files[".env"] || "";

test("the owner's provider becomes the Hermes search backend, fetch is AgentPier's", () => {
  const brave = home(both, { search: { provider: "brave", key: "bk" }, ddgs: false });
  assert.deepEqual(
    [config(brave).web.search_backend, config(brave).web.extract_backend],
    ["brave-free", "agentpier-fetch"],
  );
  assert.match(env(brave), new RegExp(`^${braveKeyEnv}='bk'$`, "m"));
  assert.ok(config(brave).plugins.enabled.includes("agentpier-web"));
  assert.deepEqual(JSON.parse(brave.files["plugins/agentpier-web/web.json"]), {
    fetch: true,
  });
  assert.equal(brave.unsupported.includes("webSearch"), false);
  // Perplexity through the owner's OpenRouter key: AgentPier's own backend, with
  // a key Hermes strips from child processes (AUXILIARY_*).
  const perplexity = home(both, {
    search: { provider: "perplexity", key: "sk-or" },
    ddgs: false,
  });
  assert.equal(config(perplexity).web.search_backend, "agentpier-perplexity");
  assert.match(env(perplexity), new RegExp(`^${perplexityKeyEnv}='sk-or'$`, "m"));
  assert.doesNotMatch(env(perplexity), new RegExp(braveKeyEnv));
  // DuckDuckGo needs the ddgs package of the installation.
  const ddgs = home(both, { search: { provider: "duckduckgo" }, ddgs: true });
  assert.equal(config(ddgs).web.search_backend, "ddgs");
  assert.equal(config(ddgs).agent.disabled_toolsets.includes("search"), false);
});

test("a search Hermes cannot serve is named and its tool withheld", () => {
  for (const web of [
    { search: { provider: "duckduckgo" }, ddgs: false },
    { search: { provider: "brave", unavailable: true }, ddgs: true },
    { search: { provider: "brave", key: "it's" }, ddgs: true },
  ]) {
    const built = home(both, web);
    assert.equal(config(built).web.search_backend, undefined);
    // `search` holds web_search alone: web_extract (fetch) stays.
    assert.ok(config(built).agent.disabled_toolsets.includes("search"));
    assert.equal(config(built).agent.disabled_toolsets.includes("web"), false);
    assert.ok(built.unsupported.includes("webSearch"));
  }
});

test("fetch only, search only and neither", () => {
  const fetchOnly = home({ webFetch: true }, { search: { provider: "brave", key: "k" } });
  assert.ok(config(fetchOnly).agent.disabled_toolsets.includes("search"));
  assert.equal(config(fetchOnly).web.search_backend, undefined);
  assert.equal(env(fetchOnly), "");
  assert.equal(fetchOnly.unsupported.includes("webSearch"), false);
  // Search without fetch: Hermes offers web_extract with web_search, so AgentPier's
  // fetch backend stays pinned and refuses every page (web.json).
  const searchOnly = home(
    { webSearch: true },
    { search: { provider: "brave", key: "k" } },
  );
  assert.equal(config(searchOnly).web.extract_backend, "agentpier-fetch");
  assert.deepEqual(JSON.parse(searchOnly.files["plugins/agentpier-web/web.json"]), {
    fetch: false,
  });
  // Neither: no plugin, its folder goes, and a key written before is removed.
  const before = home(both, { search: { provider: "brave", key: "k" } });
  const none = compileHome(agent({}), {
    web: { search: { provider: "brave", key: "k" } },
    existing: { ".env": before.files[".env"] },
  });
  assert.equal(webHome(agent({}), {}), null);
  assert.ok(none.remove.includes("plugins/agentpier-web"));
  assert.equal(config(none).web.extract_backend, undefined);
  assert.doesNotMatch(env(none), new RegExp(braveKeyEnv));
});

test("without the web settings the search backend and its key stay as they are", () => {
  const before = home(both, { search: { provider: "brave", key: "k" } });
  const bare = compileHome(agent(both), {
    existing: {
      "config.yaml": before.files["config.yaml"],
      ".env": before.files[".env"],
    },
  });
  assert.equal(config(bare).web.search_backend, "brave-free");
  // No .env name is owned then: the writer leaves the file, key and all, in place.
  assert.equal(bare.files[".env"], undefined);
  assert.equal(bare.env.owned.includes(braveKeyEnv), false);
  assert.equal(config(bare).agent.disabled_toolsets.includes("search"), false);
  assert.equal(bare.unsupported.includes("webSearch"), false);
});

test("ddgs counts as installed only with its package in the environment", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-ddgs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const site = path.join(root, "venv", "lib", "python3.14", "site-packages");
  fs.mkdirSync(site, { recursive: true });
  assert.equal(ddgsInstalled({ directory: root }), false);
  fs.mkdirSync(path.join(site, "ddgs"));
  assert.equal(ddgsInstalled({ directory: root }), true);
  assert.equal(ddgsInstalled(null), false);
});

test("a saved search applies the Hermes agents that search", async () => {
  const applied = [];
  const profiles = [
    { id: "h1", runtimeAgentId: "ap-h1", runtime: "hermes", capabilities: both },
    { id: "h2", runtimeAgentId: "ap-h2", runtime: "hermes", capabilities: {} },
    {
      id: "h3",
      runtimeAgentId: "ap-h3",
      runtime: "hermes",
      capabilities: both,
      archivedAt: "x",
    },
    { id: "o1", runtimeAgentId: "ap-o1", capabilities: both },
  ];
  const changes = new WebToolsChanges({
    assistants: {
      runtime: {},
      store: { listAssistants: () => profiles },
      config: { apply: async (id) => applied.push(id) },
    },
    webSearch: {
      preview: () => ({ provider: "brave", key: "k" }),
      save: () => ({ saved: true }),
      resolve: () => ({ provider: "brave", key: "k" }),
    },
  });
  // OpenClaw does not run: no Gateway restart, only the Hermes agent's apply.
  assert.deepEqual(await changes.saveSearch({}), { saved: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(applied, ["h1"]);
});
