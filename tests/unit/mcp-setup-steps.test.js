import assert from "node:assert/strict";
import test from "node:test";
import { setupPlan, setupSteps } from "../../web/features/mcp/setup.js";

const endpoint = "https://h/mcp";
const command = (id, value, label) => ({
  id,
  value,
  kind: "command",
  ...(label ? { label } : {}),
});

test("setup steps match the former per-CLI literals", () => {
  assert.deepEqual(setupSteps("claude", endpoint), [
    command(
      "add",
      "claude mcp add --transport http --scope user agentpier 'https://h/mcp'",
    ),
    command("login", "/mcp"),
    command("check", "claude mcp get agentpier\nclaude mcp list"),
    command("remove", "claude mcp remove --scope user agentpier"),
  ]);
  assert.deepEqual(setupSteps("codex", endpoint), [
    command("add", "codex mcp add agentpier --url 'https://h/mcp'"),
    command(
      "login",
      "codex mcp login agentpier --oauth-client-registration dcr",
      "retryLogin",
    ),
    command("check", "codex mcp get agentpier\ncodex mcp list"),
    command("remove", "codex mcp logout agentpier\ncodex mcp remove agentpier"),
  ]);
  const config = JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      mcp: { agentpier: { type: "remote", url: endpoint, enabled: true } },
    },
    null,
    2,
  );
  assert.deepEqual(setupSteps("opencode", endpoint), [
    { id: "add", value: config, kind: "config" },
    command("login", "opencode mcp auth agentpier"),
    command("check", "opencode mcp list\nopencode mcp debug agentpier"),
    command("remove", "opencode mcp logout agentpier"),
  ]);
  assert.equal(setupPlan("opencode", endpoint).removeNote, "opencodeRemove");
  assert.equal(setupPlan("codex", endpoint).removeNote, undefined);
});

test("quotes a single quote in the endpoint for the shell", () => {
  assert.match(setupSteps("codex", "https://h/a'b")[0].value, /'https:\/\/h\/a'\\''b'$/);
});

test("an unknown CLI throws instead of getting Codex commands", () => {
  assert.throws(() => setupSteps("gemini", endpoint), TypeError);
});
