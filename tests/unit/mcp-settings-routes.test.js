import test from "node:test";
import assert from "node:assert/strict";
import { readRoute, routePath } from "../../web/app/routes.js";
const read = (path) => readRoute(new URL(path, "http://localhost"));
test("MCP consent, setup tab and grant pagination survive deep links", () => {
  const path = "/coding/clis?tab=mcp&authorization=auth_one&cli=opencode&page=2";
  const route = read(path);
  assert.equal(route.view, "coding");
  assert.equal(route.codingTab, "mcp");
  assert.equal(route.mcpAuthorization, "auth_one");
  assert.equal(route.mcpCli, "opencode");
  assert.equal(route.mcpPage, 2);
  assert.equal(routePath(route), path);
  // The server's consent address (/settings/mcp?authorization=…) keeps working.
  assert.deepEqual(
    read("/settings/mcp?authorization=auth_one&cli=opencode&page=2"),
    route,
  );
});
test("MCP routes bound untrusted query values", () => {
  for (const base of ["/settings/mcp?", "/coding/clis?tab=mcp&"]) {
    const route = read(`${base}authorization=a%2Fb&cli=bad&page=-4`);
    assert.equal(route.mcpAuthorization, "", base);
    assert.equal(route.mcpCli, "codex", base);
    assert.equal(route.mcpPage, 1, base);
  }
});
