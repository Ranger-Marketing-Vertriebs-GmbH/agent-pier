import test from "node:test";
import assert from "node:assert/strict";
import {
  agentServerName,
  mcpSections,
  readMcpInputs,
  withInherited,
} from "../../server/features/assistants/openclaw-config/mcp-servers.js";

const workspaces = "/data/assistants/workspaces";
const lead = { id: "lead", runtimeAgentId: "ap-lead", capabilities: {} };
const member = { id: "member", runtimeAgentId: "ap-member", capabilities: {} };
const voice = {
  id: "s-voice",
  name: "elevenlabs",
  transport: "stdio",
  command: "/opt/bin/uvx",
  args: ["elevenlabs-mcp"],
  cwd: "{agent.workspace}",
  agentPlaceholders: true,
};
const render = {
  id: "s-render",
  name: "render",
  transport: "http",
  url: "https://render.example/mcp",
};
const secrets = {
  "s-voice": { headers: {}, env: { BASE: "{agent.attachments}/voice" } },
  "s-render": { headers: {}, env: {} },
};

test("servers a member uses through its lead compile like its own, placeholders per member", () => {
  const bindings = withInherited({ lead: ["s-render", "s-voice"] }, () => ({
    member: ["s-render", "s-voice"],
  }));
  const sections = mcpSections({
    profiles: [lead, member],
    servers: [render, voice],
    bindings,
    secrets,
    workspaces,
  });
  const own = agentServerName(voice, "member");
  assert.deepEqual(sections.agentTools["ap-member"], ["render__*", `${own}__*`]);
  assert.equal(sections.servers[own].cwd, `${workspaces}/member`);
  // Without the share the member compiles nothing.
  const without = mcpSections({
    profiles: [lead, member],
    servers: [render, voice],
    bindings: withInherited({ lead: ["s-render", "s-voice"] }, () => ({})),
    secrets,
    workspaces,
  });
  assert.equal(without.agentTools["ap-member"], undefined);
  assert.equal(without.servers[own], undefined);
});

test("inherited bindings merge without duplicates and an unreadable list adds nothing", () => {
  assert.deepEqual(
    withInherited({ m: ["a"] }, () => ({ m: ["a", "b"], n: ["c"] })),
    { m: ["a", "b"], n: ["c"] },
  );
  const own = { m: ["a"] };
  assert.equal(
    withInherited(own, () => {
      throw new Error("unreadable");
    }),
    own,
  );
  assert.equal(withInherited(own, null), own);
});

test("a start reads the secrets of servers only a member uses through its lead", () => {
  const read = [];
  const store = {
    definitions: () => [render],
    bindingsByTarget: () => ({}),
    secrets: (id) => {
      read.push(id);
      return { headers: { authorization: "token" }, env: {} };
    },
  };
  const inputs = readMcpInputs(store, { inherited: () => ({ member: ["s-render"] }) });
  assert.deepEqual(inputs.bindings, { member: ["s-render"] });
  assert.deepEqual(read, ["s-render"]);
});
