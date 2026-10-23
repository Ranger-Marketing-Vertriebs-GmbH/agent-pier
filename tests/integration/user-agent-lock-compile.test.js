import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { shellService } from "../helpers/assistant-shell-service.js";
import { compileOpenClawConfig } from "../../server/features/assistants/runtime-config.js";
import { lockedTools } from "../../server/features/users/user-agent-lock.js";
import {
  agentProfileName,
  browserProfileMap,
} from "../../server/features/assistants/openclaw-config/browser-profiles.js";
import { personalCapabilities } from "../../server/features/assistants/native-capabilities.js";

const userAccess = {
  mode: "own",
  members: [{ userId: "u1", level: "chat" }],
  released: [],
};

// Writes a body straight into the database, as a damaged or edited file could hold it.
function forge(store, id, change) {
  const body = { ...store.storedAssistant(id), ...change };
  store.db
    .prepare("UPDATE assistants SET body=? WHERE id=?")
    .run(JSON.stringify(body), id);
  return body;
}

test("a forged shell level in the database stays locked", async (t) => {
  const f = shellService(t, ["Anna's agent"]);
  const [agent] = f.agents;
  const forged = forge(f.store, agent.id, { userAccess, shell: "full", skills: [] });
  await f.config.apply(agent.id);
  const live = f.live(agent);
  assert.equal(live.tools.exec, undefined);
  assert.deepEqual(live.tools.deny, lockedTools);
  for (const tool of lockedTools) assert.ok(!live.tools.allow.includes(tool), tool);
  assert.ok(!f.client.effective().tools.allow.includes("exec"));

  const compiled = compileOpenClawConfig({
    paths: { workspaces: path.join(f.dataDir, "w"), logs: path.join(f.dataDir, "l") },
    port: 1234,
    token: "t",
    teams: {
      directory: "/plugin",
      connection: { url: "http://127.0.0.1:1", token: "bridge" },
      hostMaxConcurrent: 4,
      native: { token: "hook" },
      profiles: [forged],
      sshAgents: new Set([agent.id]),
    },
    shell: { pathPrepend: ["/owner/bin"] },
    existing: {
      agents: {
        entries: {
          [agent.runtimeAgentId]: {
            id: agent.runtimeAgentId,
            tools: { allow: ["exec"], exec: { mode: "full" } },
          },
        },
      },
    },
  });
  const entry = compiled.agents.entries[agent.runtimeAgentId];
  assert.equal(entry.tools.exec, undefined);
  assert.deepEqual(entry.tools.deny, lockedTools);
  for (const tool of lockedTools) assert.ok(!entry.tools.allow.includes(tool), tool);
  assert.ok(!compiled.tools.allow.includes("exec"));
});

test("a forged visible browser in the database stays headless", () => {
  const agent = (id, extra) => ({
    id,
    kind: "personal",
    capabilities: { browser: true },
    browserVisible: true,
    ...extra,
  });
  const profiles = [agent("owner1"), agent("user1", { userAccess })];
  for (const p of profiles) assert.ok(personalCapabilities(p).browser, p.id);
  const map = browserProfileMap({
    profiles,
    browser: { visible: { available: true } },
    port: 1000,
  });
  assert.equal(map[agentProfileName("owner1")].headless, false);
  assert.equal(map[agentProfileName("user1")].headless, true);
  // Alone, every profile but the slots kept for members of a visible lead is headless.
  const alone = browserProfileMap({
    profiles: [profiles[1]],
    browser: { visible: { available: true } },
    port: 1000,
  });
  assert.ok(
    Object.entries(alone).every(
      ([name, entry]) => entry.headless || name.startsWith("member-visible-"),
    ),
  );
});
