import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage } from "../../web/lib/i18n/index.js";
import {
  accountItemTitle,
  itemRoute,
  resolveAccountItem,
  sectionLabel,
} from "../../web/features/accounts/accounts-items.js";

const data = {
  agentsEnabled: true,
  connections: [{ id: "c1", name: "Router" }],
  chatgpt: [{ id: `openclaw:${"a".repeat(64)}`, name: "Personal" }],
  mcpServers: [{ id: "s1", name: "docs" }],
  accounts: [
    { id: "managed-1", name: "Work", tool: "codex" },
    { id: "local-shell", name: "Shell", tool: "shell" },
  ],
};
const at = (section, item, extra = data) =>
  resolveAccountItem({ view: "accounts", section, item }, extra);

test("the hub shows no entry without section and item", () => {
  assert.equal(resolveAccountItem({ view: "accounts" }, data), null);
  assert.equal(resolveAccountItem({ view: "accounts", section: "models" }, data), null);
});

test("entries resolve by section and item", () => {
  assert.equal(at("models", "c1").kind, "connection");
  assert.equal(at("models", "c1").record.name, "Router");
  assert.equal(at("models", "new").kind, "connection-new");
  assert.equal(at("models", "chatgpt").kind, "chatgpt-login");
  assert.equal(at("models", data.chatgpt[0].id).kind, "chatgpt");
  assert.equal(at("services", "speech").kind, "speech");
  assert.equal(at("services", "web-search").kind, "web-search");
  assert.equal(at("mcp-servers", "s1").kind, "mcp-server");
  assert.equal(at("mcp-servers", "new").kind, "mcp-new");
  assert.equal(at("mcp-servers", "cli-finds").kind, "mcp-finds");
  // Native CLI accounts moved to Coding › Accounts (coding/accounts/cli-accounts.js).
  assert.equal(at("cli", "managed-1"), null);
});

test("unknown or hidden entries are missing, unloaded ones loading", () => {
  assert.equal(at("models", "gone").kind, "missing");
  assert.equal(at("services", "other").kind, "missing");
  assert.equal(at("mcp-servers", "s1", { ...data, mcpServers: null }).kind, "loading");
  assert.equal(at("models", "c1", { ...data, connections: null }).kind, "loading");
  const off = { ...data, agentsEnabled: false };
  assert.equal(at("services", "speech", off).kind, "missing");
  assert.equal(at("models", "chatgpt", off).kind, "missing");
  assert.equal(at("models", data.chatgpt[0].id, off).kind, "missing");
  const pending = { ...data, agentsEnabled: null };
  assert.equal(at("services", "speech", pending).kind, "loading");
  assert.equal(at("mcp-servers", "s1", pending).kind, "mcp-server");
});

test("a list that failed to load resolves to an error with its source", () => {
  const failed = {
    ...data,
    mcpServers: null,
    chatgpt: null,
    errors: { mcpServers: "MCP down", chatgpt: "" },
  };
  assert.deepEqual(at("mcp-servers", "s1", failed).record, {
    error: "MCP down",
    source: "mcpServers",
  });
  assert.equal(at("mcp-servers", "s1", failed).kind, "error");
  // No error yet: still loading.
  assert.equal(at("models", data.chatgpt[0].id, failed).kind, "loading");
  const chatgptDown = { ...failed, errors: { chatgpt: "Agents down" } };
  assert.equal(at("models", data.chatgpt[0].id, chatgptDown).kind, "error");
  assert.equal(at("models", data.chatgpt[0].id, chatgptDown).record.source, "chatgpt");
  // A loaded list wins over an older error.
  assert.equal(
    at("mcp-servers", "s1", { ...data, errors: failed.errors }).kind,
    "mcp-server",
  );
});

test("routes and titles", () => {
  assert.deepEqual(itemRoute(), { view: "accounts" });
  assert.deepEqual(itemRoute("cli"), { view: "accounts", section: "cli" });
  assert.deepEqual(itemRoute("cli", "new"), {
    view: "accounts",
    section: "cli",
    item: "new",
  });
  assert.deepEqual(itemRoute(undefined, "x"), { view: "accounts" });
  setLanguage("en");
  assert.equal(sectionLabel("mcp-servers"), "MCP servers");
  assert.equal(accountItemTitle(at("models", "c1")), "Router");
  assert.equal(accountItemTitle(at("services", "web-search")), "Web search");
  assert.equal(accountItemTitle(at("models", "chatgpt")), "ChatGPT for agents");
  setLanguage("de");
});
