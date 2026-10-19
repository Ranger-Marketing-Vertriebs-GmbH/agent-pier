import test from "node:test";
import assert from "node:assert/strict";
import { placeholderViews } from "../../server/features/assistants/mcp-placeholder-view.js";
import { agentServerName } from "../../server/features/assistants/openclaw-config/mcp-servers.js";

const server = {
  id: "s1",
  name: "voice",
  transport: "stdio",
  agentPlaceholders: true,
  placeholders: {
    args: [{ index: 1, template: "--out={agent.workspace}/out" }],
    cwd: null,
    env: { BASE: "{agent.attachments}" },
  },
};
const plain = { id: "s2", name: "plain", transport: "stdio" };
const a1 = { id: "a1", name: "Home", runtimeAgentId: "ap-a1" };
const a2 = { id: "a2", name: "Other", runtimeAgentId: "ap-a2" };
const archived = { id: "a3", name: "Old", runtimeAgentId: "ap-a3", archivedAt: "x" };

test("each bound agent sees its own resolved folders and whether they run", () => {
  const [view, untouched] = placeholderViews([server, plain], {
    profiles: [a1, a2, archived],
    bindings: { a1: ["s1"], a2: ["s1"], a3: ["s1"] },
    workspaces: "/w",
    running: { servers: [agentServerName(server, "a1")] },
    pathCheck: (target) => !target.startsWith("/w/a2"),
  });
  assert.equal(untouched, plain);
  assert.deepEqual(view.agentFolders, [
    {
      id: "a1",
      name: "Home",
      entry: agentServerName(server, "a1"),
      status: "active",
      values: [
        { field: "args", index: 1, value: "--out=/w/a1/out" },
        { field: "env", name: "BASE", value: "/w/a1/attachments" },
      ],
    },
    {
      id: "a2",
      name: "Other",
      entry: agentServerName(server, "a2"),
      status: "unsafe",
      values: [
        { field: "args", index: 1, value: "--out=/w/a2/out" },
        { field: "env", name: "BASE", value: "/w/a2/attachments" },
      ],
    },
  ]);
});

test("without a workspace root the agents are listed as unavailable", () => {
  const [view] = placeholderViews([server], {
    profiles: [a1],
    bindings: { a1: ["s1"] },
  });
  assert.equal(view.agentFolders[0].status, "unavailable");
  assert.deepEqual(view.agentFolders[0].values, []);
});
