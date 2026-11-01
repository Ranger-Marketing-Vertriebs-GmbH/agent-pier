import test from "node:test";
import assert from "node:assert/strict";
import { desiredAgent } from "../../server/features/assistants/agent-desired-state.js";
import { mcpEntries } from "../../server/features/assistants/runtimes/hermes/hermes-config/mcp.js";
import { compileHome } from "../../server/features/assistants/runtimes/hermes/hermes-config/home.js";
import { mergeEnv } from "../../server/features/assistants/runtimes/hermes/hermes-config/home-merge.js";

const profile = { id: "a1", name: "A1", runtimeAgentId: "ap-a1", revision: 1 };
const bound = (ids, extra = {}) => desiredAgent({ ...profile, ...extra }, { mcp: ids });
const stdio = (id, extra = {}) => ({
  id,
  name: id,
  transport: "stdio",
  command: "/usr/bin/tool",
  args: [],
  ...extra,
});
const secrets = (env = {}, headers = {}) => ({ env, headers });

test("a server Hermes cannot be given safely is skipped by name", () => {
  const mcp = {
    servers: [
      stdio("relative", { command: "tool" }),
      stdio("quoted"),
      stdio("pending", { packageStatus: "installing" }),
      stdio("outside", { args: ["{agent.workspace}/x"] }),
      stdio("fine"),
      { id: "nosecret", name: "nosecret", transport: "http", url: "https://n.test" },
    ],
    secrets: {
      relative: secrets(),
      quoted: secrets({ TOKEN: "it's" }),
      pending: secrets(),
      outside: secrets(),
      fine: secrets({ TOKEN: "t" }),
    },
    // The folder check refuses the placeholder's path.
    pathCheck: () => false,
  };
  const agent = bound(mcp.servers.map((s) => s.id));
  const out = mcpEntries(agent, mcp, { workspace: "/work/ap-a1" });
  assert.deepEqual(Object.keys(out.servers), ["fine"]);
  assert.deepEqual(out.skipped, ["relative", "quoted", "pending", "outside", "nosecret"]);
  assert.deepEqual(out.servers.fine.env, {
    TOKEN: "${AUXILIARY_AGENTPIER_MCP1_E1_API_KEY}",
  });
  assert.deepEqual(out.env, { AUXILIARY_AGENTPIER_MCP1_E1_API_KEY: "t" });
  // Without a work folder a placeholder cannot resolve.
  const placeholder = {
    servers: [stdio("p", { args: ["{agent.workspace}"] })],
    secrets: { p: secrets() },
  };
  assert.deepEqual(mcpEntries(bound(["p"]), placeholder).skipped, ["p"]);
  // An archived agent gets none.
  const archived = bound(["fine"], { archivedAt: "2026-11-01T00:00:00.000Z" });
  assert.deepEqual(mcpEntries(archived, mcp).servers, {});
});

test("the home owns its MCP secrets in .env and drops those of removed servers", () => {
  const before = "OTHER=1\nAUXILIARY_AGENTPIER_MCP2_E1_API_KEY='old'\n";
  assert.equal(
    mergeEnv(before, ["AUXILIARY_AGENTPIER_MCP*"], {
      AUXILIARY_AGENTPIER_MCP1_E1_API_KEY: "new",
    }),
    "OTHER=1\nAUXILIARY_AGENTPIER_MCP1_E1_API_KEY='new'\n",
  );
  const mcp = { servers: [stdio("fine")], secrets: { fine: secrets({ T: "x" }) } };
  const home = compileHome(bound(["fine"]), { mcp, existing: { ".env": before } });
  assert.equal(home.files[".env"], "OTHER=1\nAUXILIARY_AGENTPIER_MCP1_E1_API_KEY='x'\n");
  assert.match(home.files["config.yaml"], /mcp_servers:\n {2}fine:/);
  assert.ok(!home.files["config.yaml"].includes("'x'"));
  // No server left: the section and its secrets go.
  const none = compileHome(bound([]), {
    mcp,
    existing: { ".env": before, "config.yaml": "mcp_servers:\n  stale: {}\n" },
  });
  assert.equal(none.files[".env"], "OTHER=1\n");
  assert.ok(!none.files["config.yaml"].includes("mcp_servers"));
  // Without the store's inputs both stay as Hermes has them.
  const kept = compileHome(bound(["fine"]), {
    existing: { "config.yaml": "mcp_servers:\n  stale: {}\n" },
  });
  assert.equal(kept.files[".env"], undefined);
  assert.match(kept.files["config.yaml"], /stale/);
  assert.ok(kept.unsupported.includes("mcp"));
});
