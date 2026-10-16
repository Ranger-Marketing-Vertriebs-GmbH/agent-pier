import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import plugin, {
  toolTimeouts,
} from "../../server/features/assistants/team-plugin/index.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";

function registered() {
  const tools = new Map();
  plugin.register({
    pluginConfig: { url: "http://bridge.invalid", token: "test" },
    registerTool: (factory, options) => tools.set(options.name, factory),
    on() {},
  });
  return tools;
}

test("agentpier_ssh is registered with its schema and a 245 s call budget", () => {
  const factory = registered().get("agentpier_ssh");
  assert.ok(factory);
  const tool = factory.create({
    agentId: "ap-x",
    sessionKey: "agent:ap-x:main",
    assertInvocationCurrent() {},
  });
  assert.equal(tool.name, "agentpier_ssh");
  assert.deepEqual(tool.parameters.required, ["action"]);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(tool.parameters.properties.action.enum, ["hosts", "execute"]);
  assert.equal(tool.parameters.properties.command.maxLength, 16384);
  assert.equal(tool.parameters.properties.timeoutSeconds.maximum, 120);
  assert.match(tool.description, /untrusted external data/);
  assert.equal(toolTimeouts.ssh, 245000);
  assert.ok(toolTimeouts.ssh > 110000 + 120000);
});

test("the plugin sends an SSH call through prepare and invoke", async (t) => {
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    bodies.push([new URL(url).pathname, JSON.parse(init.body)]);
    return {
      ok: true,
      json: async () => (bodies.length === 1 ? { ticket: "t1" } : { hosts: [] }),
    };
  });
  const tool = registered()
    .get("agentpier_ssh")
    .create({ agentId: "ap-x", sessionKey: "s", assertInvocationCurrent() {} });
  const result = await tool.execute("call-1", { action: "hosts" });
  assert.deepEqual(bodies, [
    [
      "/prepare",
      { agentId: "ap-x", sessionKey: "s", toolCallId: "call-1", action: "ssh" },
    ],
    ["/invoke", { ticket: "t1", action: "ssh", input: { action: "hosts" } }],
  ]);
  assert.deepEqual(JSON.parse(result.content[0].text), { hosts: [] });
});

test("the manifest and the installed plugin carry the SSH tool", (t) => {
  const manifest = JSON.parse(
    fs.readFileSync(
      new URL(
        "../../server/features/assistants/team-plugin/openclaw.plugin.json",
        import.meta.url,
      ),
    ),
  );
  assert.ok(manifest.contracts.tools.includes("agentpier_ssh"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "team-plugin-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { directory } = provisionTeamPlugin({
    paths: { root },
    runtimeVersion: runtimeManifest.version,
  });
  assert.ok(fs.existsSync(path.join(directory, "ssh-tool.js")));
});
