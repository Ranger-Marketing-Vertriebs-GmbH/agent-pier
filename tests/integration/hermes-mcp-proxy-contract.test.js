import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { startFakeModel } from "../helpers/hermes-fake-model.js";
import {
  collectEvents,
  contractAgent,
  endsRun,
  hermesSandbox,
  hermesSkip,
  startHermes,
  strayAfterStop,
} from "../helpers/hermes-native.js";
import { agentPierMcpLogin } from "../helpers/agentpier-mcp-login.js";

// An OAuth MCP server whose login AgentPier holds, used by the pinned Hermes through
// AgentPier's MCP proxy: Hermes compiles it as a plain Streamable HTTP server with the
// proxy credential (hermes-config/mcp.js) and never runs an OAuth flow of its own.
const options = { skip: hermesSkip, timeout: contractTimeout(600000) };
const agentId = "hermes-mcp-proxy";

test(
  "Hermes contract: an AgentPier-held OAuth MCP server is callable through the proxy",
  options,
  async (t) => {
    const dirs = hermesSandbox(t);
    const model = await startFakeModel();
    t.after(() => model.close());
    const login = await agentPierMcpLogin(t, dirs.root);
    const hermes = await startHermes(t, dirs, { agentId, model });
    const { runtime, agent, sessions, events, stop } = hermes;
    const applied = await runtime.config.apply({
      desired: contractAgent(agentId, model, {}, { mcp: ["srv-1"] }),
      mcp: login.inputs,
    });
    assert.equal(applied.restarted, true);
    const home = ["config.yaml", ".env"]
      .map((name) => fs.readFileSync(path.join(agent.hermesHome, name), "utf8"))
      .join("\n");
    const tokens = login.agentpier.vault.get("srv-1").tokens;
    assert.ok(!home.includes(tokens.access_token), "no OAuth token in the home");
    assert.ok(!home.includes(tokens.refresh_token), "no refresh token in the home");
    assert.ok(home.includes("/mcp/srv-1"), "the server goes to the proxy");
    const turn = async (text, runId) => {
      const { key } = await sessions.create({
        agentId,
        label: runId,
        idempotencyKey: runId,
      });
      const run = collectEvents(events);
      const call = JSON.stringify({
        calls: [{ name: "mcp__docs__echo", arguments: { text } }],
      });
      await sessions.send({
        key,
        turn: { message: `CALL: tool_call ${call}` },
        idempotencyKey: runId,
      });
      const end = await run.until(endsRun(runId), contractTimeout(240000));
      run.unsubscribe();
      return end;
    };
    const first = await turn("through-proxy", "mcp-p1");
    assert.equal(first.kind, "finished");
    assert.match(first.payload.text, /through-proxy/);
    assert.match(login.oauth.calls.at(-1).bearer, /^at-/);
    // An expired token: AgentPier renews it once; Hermes notices nothing.
    login.oauth.expireAccessTokens();
    const second = await turn("after-renewal", "mcp-p2");
    assert.equal(second.kind, "finished");
    assert.match(second.payload.text, /after-renewal/);
    const grants = login.oauth.log.filter((e) => e.path === "/token");
    assert.deepEqual(
      grants.map((e) => e.grant),
      ["authorization_code", "refresh_token"],
    );
    // Only AgentPier ever registered a client: Hermes started no OAuth flow.
    assert.deepEqual(
      [...login.oauth.clients.values()].map((c) => c.client_name),
      ["AgentPier"],
    );
    await stop();
    assert.deepEqual(await strayAfterStop(dirs), []);
  },
);
