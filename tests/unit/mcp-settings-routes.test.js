import test from "node:test";
import assert from "node:assert/strict";
import { readRoute, routePath } from "../../web/app/routes.js";
const read = (path) => readRoute(new URL(path, "http://localhost"));
test("MCP consent, setup tab and grant pagination survive deep links", () => {
  const path = "/settings/mcp?authorization=auth_one&cli=opencode&page=2";
  const route = read(path);
  assert.equal(route.settingsSection, "mcp");
  assert.equal(route.mcpAuthorization, "auth_one");
  assert.equal(route.mcpCli, "opencode");
  assert.equal(route.mcpPage, 2);
  assert.equal(routePath(route), path);
});
test("MCP routes bound untrusted query values", () => {
  const route = read("/settings/mcp?authorization=a%2Fb&cli=bad&page=-4");
  assert.equal(route.mcpAuthorization, "");
  assert.equal(route.mcpCli, "codex");
  assert.equal(route.mcpPage, 1);
});
