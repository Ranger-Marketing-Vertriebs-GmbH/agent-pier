import test from "node:test";
import assert from "node:assert/strict";

// OpenClaw's tool search (directory mode, runtime-config.js) defers every tool
// schema behind its directory except the core file tools, `message` and tools
// marked `catalogMode: "direct-only"`. A member's report is the only way its result
// reaches its lead, so it stays visible; every other team tool is found through
// the directory.
const direct = ["agentpier_team_report"];

test("only the member report is a direct-only team tool", async () => {
  const { default: plugin } =
    await import("../../server/features/assistants/team-plugin/index.js");
  const tools = [];
  plugin.register({
    registrationMode: "cli-metadata",
    registerTool: (tool) => tools.push(tool),
  });
  const created = tools
    .map((tool) => tool.create({ agentId: "a", sessionKey: "s" }))
    .filter(Boolean);
  assert.ok(created.length > direct.length);
  const marked = created
    .filter((tool) => tool.catalogMode !== undefined)
    .map((tool) => [tool.name, tool.catalogMode]);
  assert.deepEqual(
    marked,
    direct.map((name) => [name, "direct-only"]),
  );
});
