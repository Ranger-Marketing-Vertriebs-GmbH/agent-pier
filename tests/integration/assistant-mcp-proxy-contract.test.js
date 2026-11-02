import test from "node:test";
import { contractTimeout } from "../helpers/contract-timeout.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { selectedAssistantRuntime } from "../../server/features/assistants/runtimes/openclaw/runtime-install.js";
import { patchConfig } from "../../server/features/assistants/runtimes/openclaw/live-patch.js";
import { mcpServerConfig } from "../../server/features/assistants/runtimes/openclaw/openclaw-config/mcp-servers.js";
import { createGatewaySession } from "../../server/features/assistants/runtimes/openclaw/session-create.js";
import { assistantModelServer } from "../helpers/assistant-model-server.js";
import { agentPierMcpLogin } from "../helpers/agentpier-mcp-login.js";
import { leakedFiles } from "../helpers/mcp-test-servers.js";

// An OAuth MCP server whose login AgentPier holds, used by the pinned OpenClaw through
// AgentPier's MCP proxy: the compile (mcp-inputs.js proxiedServers, then the OpenClaw
// compiler) makes it a plain Streamable HTTP server with the proxy credential as its
// header, so OpenClaw neither registers a client nor holds a token, and AgentPier
// renews the login behind it.
const installed = process.env.AGENTPIER_MCP_CONTRACT_RUNTIME;
const contractDir = process.env.AGENTPIER_ASSISTANT_CONTRACT_DIR;
const options = {
  skip:
    !(installed && contractDir) &&
    "set AGENTPIER_MCP_CONTRACT_RUNTIME and AGENTPIER_ASSISTANT_CONTRACT_DIR",
  timeout: contractTimeout(300000),
};

for (const transport of ["http", "sse"])
  test(
    `OpenClaw calls an AgentPier-held OAuth MCP server through the proxy and never logs in itself (${transport})`,
    options,
    async (t) => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-mcp-proxy-"));
      const store = new AssistantStore({ dataDir });
      const tool = { name: "none", arguments: {} };
      const model = await assistantModelServer({ tool });
      const fixture = { connectionId: "fixture", modelId: "fixture-model" };
      const agent = store.createAssistant({
        name: "Bound",
        instructions: "Use the tool.",
        model: fixture,
      });
      const runtime = new RuntimeSupervisor({
        dataDir,
        install: async () => {
          const selected = await selectedAssistantRuntime({ dataDir: contractDir });
          assert.ok(path.resolve(selected.nodePath).startsWith(installed + path.sep));
          return selected;
        },
      });
      t.after(async () => {
        try {
          await runtime.close();
          await model.close();
          store.close();
        } finally {
          fs.rmSync(dataDir, { recursive: true, force: true });
        }
      });
      const login = await agentPierMcpLogin(t, dataDir, { transport });
      await runtime.start();
      const config = new AssistantConfig({
        store,
        workspaces: runtime.paths.workspaces,
        runtime,
        hostCapacity: () => 4,
        models: {
          resolve: () => ({
            providerId: "fixture",
            modelRef: "fixture/fixture-model",
            provider: {
              baseUrl: model.url,
              api: "openai-completions",
              apiKey: "fixture-key",
              models: [
                {
                  id: "fixture-model",
                  name: "Fixture",
                  input: ["text"],
                  contextWindow: 32768,
                  maxTokens: 4096,
                },
              ],
            },
            release() {},
          }),
        },
      });
      config.nativeReady = () => true;
      config.writeGuard = () => false;
      await config.apply(agent.id);

      // The entry AgentPier's OpenClaw compile makes of the held server.
      const [server] = login.inputs.servers;
      const entry = mcpServerConfig(server, login.inputs.secrets[server.id]);
      assert.equal(entry.transport, transport === "sse" ? "sse" : "streamable-http");
      assert.match(entry.url, /\/mcp\/srv-1$/);
      assert.equal(entry.auth, undefined);
      const credential = entry.headers.Authorization;
      await patchConfig(runtime.client, (current) => {
        const own = (list) => list.filter((n) => n !== "bundle-mcp" && !n.includes("__"));
        const agentEntry = current.agents.entries[agent.runtimeAgentId];
        return {
          patch: {
            mcp: { servers: { docs: entry } },
            tools: { allow: [...own(current.tools.allow), "bundle-mcp"] },
            agents: {
              entries: {
                [agent.runtimeAgentId]: {
                  tools: { allow: [...own(agentEntry.tools.allow), "docs__*"] },
                },
              },
            },
          },
          replacePaths: [
            "tools.allow",
            `agents.entries.${agent.runtimeAgentId}.tools.allow`,
          ],
        };
      });

      async function turn(call, label) {
        Object.assign(tool, call);
        const from = model.requests.length;
        const session = await createGatewaySession(runtime.client, {
          agentId: agent.runtimeAgentId,
          label,
        });
        const sent = await runtime.client.call("sessions.send", {
          key: session.key,
          message: "Use the tool.",
          idempotencyKey: label,
        });
        const done = await runtime.client.call(
          "agent.wait",
          { runId: sent.runId, timeoutMs: 60000 },
          { timeoutMs: 65000 },
        );
        assert.equal(done.status, "ok", label);
        const requests = model.requests.slice(from);
        const offered = (requests[0]?.tools ?? []).map((d) => d.function.name);
        const result = requests
          .flatMap((r) => r.messages || [])
          .filter((m) => m.role === "tool")
          .map((m) => String(m.content))
          .at(-1);
        t.diagnostic(`${label} offered=${JSON.stringify(offered)} result=${result}`);
        return { offered, result };
      }
      const first = await turn(
        { name: "docs__echo", arguments: { text: "through-proxy" } },
        "proxy-1",
      );
      assert.ok(first.offered.includes("docs__echo"));
      assert.match(first.result, /through-proxy/);
      assert.match(login.oauth.calls.at(-1).bearer, /^at-/);

      // An expired token is renewed by AgentPier once; OpenClaw's session goes on.
      login.oauth.expireAccessTokens();
      const second = await turn(
        { name: "docs__echo", arguments: { text: "after-renewal" } },
        "proxy-2",
      );
      assert.match(second.result, /after-renewal/);
      assert.deepEqual(
        login.oauth.log.filter((e) => e.path === "/token").map((e) => e.grant),
        ["authorization_code", "refresh_token"],
      );
      // Only AgentPier registered a client; OpenClaw stored no MCP OAuth login.
      assert.deepEqual(
        [...login.oauth.clients.values()].map((c) => c.client_name),
        ["AgentPier"],
      );
      const tokens = login.agentpier.vault.get("srv-1").tokens;
      assert.deepEqual(
        leakedFiles(runtime.paths.root, [tokens.access_token, tokens.refresh_token]),
        [],
      );
      // The credential works at the proxy only; OpenClaw's config read redacts it.
      const { config: running } = await runtime.client.call("config.get", {});
      assert.ok(!JSON.stringify(running).includes(credential.replace("Bearer ", "")));
    },
  );
