import test from "node:test";
import assert from "node:assert/strict";
import {
  isPlaceholder,
  looksLikeToken,
} from "../../web/features/mcp-servers/wizard/paste-placeholders.js";

test("obvious placeholders from guides are recognised", () => {
  for (const value of [
    "",
    "  ",
    "…",
    "...",
    "<your-token>",
    "<API_KEY>",
    "YOUR_API_KEY",
    "your_api_key",
    "your-api-key-here",
    "your token here",
    "xxx",
    "XXXXXXXX",
    "changeme",
    "TODO",
  ])
    assert.equal(isPlaceholder(value), true, JSON.stringify(value));
  for (const value of [
    "https://192.168.1.1",
    "false",
    "abc123",
    "x",
    "my-token",
    "todo-list",
  ])
    assert.equal(isPlaceholder(value), false, value);
  assert.equal(isPlaceholder(5), false);
});

test("token-looking values: known prefixes and long mixed strings", () => {
  for (const value of [
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "github_pat_11AAAAAAA0abcdefghij",
    "sk-proj-abcdefghijklmnop",
    "xoxb-123456789012-abcdefghijkl",
    "glpat-abcdefghijklmnop",
    "AKIA" + "ABCDEFGHIJKLMNOP",
    "d41d8cd98f00b204e9800998ecf8427e",
    "Bearer ghp_abcdefghijklmnopqrstuvwxyz0123",
  ])
    assert.equal(looksLikeToken(value), true, value);
  for (const value of [
    "--port",
    "3000",
    "/usr/local/bin/server",
    "opnsense-mcp-server",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ])
    assert.equal(looksLikeToken(value), false, value);
});
