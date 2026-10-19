import test from "node:test";
import { contractTimeout } from "../helpers/contract-timeout.js";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { AssistantService } from "../../server/features/assistants/assistant-service.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { decide, shellGateway, silent } from "../helpers/assistant-shell-gateway.js";

// Shell level changes and allowlist deletes through AssistantService against a
// real Gateway: every level applies live, without a restart (docs/assistant-shell-
// qualification.md (c)), and a deleted entry asks again. Commands touch only the
// test's own temporary directory.
const installed = process.env.AGENTPIER_SHELL_CONTRACT_RUNTIME;
const options = {
  skip: !installed && "set AGENTPIER_SHELL_CONTRACT_RUNTIME",
  timeout: contractTimeout(300000),
};

test(
  "levels change live and a deleted allowlist entry asks again",
  options,
  async (t) => {
    const gw = await shellGateway(t, installed, { prefix: "shell-changes-" });
    const at = (name) => path.join(gw.dataDir, name);
    await gw.configure({ tools: { allow: ["session_status"], exec: { mode: "deny" } } });
    const store = new AssistantStore({ dataDir: path.join(gw.dataDir, "store") });
    const models = {
      resolve: async () => ({ modelRef: "fixture/fixture-model", release() {} }),
      listCapabilities: () => [],
    };
    const config = new AssistantConfig({
      client: { call: (...args) => gw.client.call(...args) },
      store,
      models,
      workspaces: gw.runtime.paths.workspaces,
    });
    Object.assign(config, {
      nativeReady: () => true,
      writeGuard: () => false,
      webToolsAvailable: () => ({}),
      shellPathPrepend: () => [],
      mcpTools: () => [],
    });
    // The supervisor stays the fixture's; the service sees it through a facade.
    const runtime = Object.assign(new EventEmitter(), {
      get client() {
        return gw.client;
      },
      status: () => gw.runtime.status(),
      close: async () => {},
    });
    const service = new AssistantService({ store, models, runtime, config });
    t.after(() => service.close());
    const agent = store.createAssistant({
      name: "Shell",
      instructions: "",
      model: { connectionId: "c", modelId: "m" },
    });
    await config.apply(agent.id);
    const generation = gw.runtime.generation;
    const level = (shell, extra = {}) =>
      service.update(
        agent.id,
        { shell, ...extra },
        store.getAssistant(agent.id).revision,
      );
    const run = (label, command) => gw.send(label, command, agent.runtimeAgentId);
    const approver = await gw.approver();

    const approval = await level("approval", { confirmShell: true });
    assert.equal(approval.pending, undefined);
    const asked = await decide(
      gw,
      approver,
      await run("ask", `touch ${at("a")}`),
      "allow-always",
    );
    assert.ok(asked.request, "approval asks");
    assert.equal(fs.existsSync(at("a")), true);
    // The exec action AgentPier keeps for the request (exec-approvals.js): it
    // links OpenClaw's path entry and its companion through the command text.
    const { command, cwd } = asked.request.request;
    service.workflows = {
      store: {
        list: () => [
          {
            payload: { action: "exec", command, cwd },
            result: { decision: "allow-always" },
            createdAt: "2026-10-11T00:00:00.000Z",
          },
        ],
      },
      close: async () => {},
    };
    const { entries } = await service.allowlist.list(agent.id);
    t.diagnostic(`entries=${JSON.stringify(entries)}`);
    assert.equal(entries.length, 1, "the companion folds into its path entry");
    const [entry] = entries;
    assert.equal(entry.source, "openclaw");
    assert.equal(entry.kind, "program");
    assert.equal(entry.command, command);
    assert.equal(entry.companions.length, 1);
    fs.rmSync(at("a"));
    await silent(gw, approver, await run("again", `touch ${at("a")}`));
    assert.equal(fs.existsSync(at("a")), true, "the allowlisted command runs unasked");
    const removed = await service.allowlist.remove(agent.id, entry.id);
    assert.deepEqual(removed.companions, entry.companions);
    assert.deepEqual(removed.entries, [], "the companion went with it");
    fs.rmSync(at("a"));
    const reasked = await decide(
      gw,
      approver,
      await run("deleted", `touch ${at("a")}`),
      "deny",
    );
    assert.ok(reasked.request, "a deleted entry asks again");
    assert.equal(fs.existsSync(at("a")), false);

    await level("full", { confirmShell: true, confirmFull: true });
    await silent(gw, approver, await run("full", `touch ${at("f")}`));
    assert.equal(fs.existsSync(at("f")), true, "full runs without asking");

    const off = await level("off");
    assert.equal(off.pending, undefined);
    const { offered } = await gw.settle(await run("off", `touch ${at("o")}`));
    assert.equal(offered.includes("exec"), false);
    assert.equal(fs.existsSync(at("o")), false);
    const { config: live } = await gw.client.call("config.get", {});
    assert.equal(live.tools.allow.includes("exec"), false);
    assert.equal(gw.runtime.generation, generation, "no restart");
    assert.equal(gw.runtime.status().availability, "ready");
  },
);
