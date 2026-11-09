import test from "node:test";
import assert from "node:assert/strict";
import { placeholderViews } from "../../server/features/assistants/mcp-placeholder-view.js";
import { agentServerName } from "../../server/features/assistants/runtimes/openclaw/openclaw-config/mcp-servers.js";

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

test("a Hermes agent's placeholders resolve in its own work folder", () => {
  const hermes = { id: "a4", name: "Herm", runtimeAgentId: "ap-a4", runtime: "hermes" };
  const own = (profile) =>
    profile.id === "a4" ? { workspace: "/h/workspaces/a4", ready: true } : null;
  const [view] = placeholderViews([server], {
    profiles: [hermes],
    bindings: { a4: ["s1"] },
    workspaces: "/w",
    running: { servers: [] },
    ownRuntime: own,
  });
  assert.deepEqual(view.agentFolders, [
    {
      id: "a4",
      name: "Herm",
      // Each Hermes home keeps the server's stored name.
      entry: "voice",
      status: "active",
      values: [
        { field: "args", index: 1, value: "--out=/h/workspaces/a4/out" },
        // Its chat uploads' folders (chat-file-folders.js).
        { field: "env", name: "BASE", value: "/h/chat-files/a4" },
      ],
    },
  ]);
  const [stopped] = placeholderViews([server], {
    profiles: [hermes],
    bindings: { a4: ["s1"] },
    ownRuntime: () => ({ workspace: "/h/workspaces/a4", ready: false }),
  });
  assert.equal(stopped.agentFolders[0].status, "pending");
  const [unknown] = placeholderViews([server], {
    profiles: [hermes],
    bindings: { a4: ["s1"] },
    ownRuntime: () => ({ workspace: null, ready: false }),
  });
  assert.equal(unknown.agentFolders[0].status, "unavailable");
  // A shared agent's chats each read only their own folder: no agent.attachments.
  const [shared] = placeholderViews([server], {
    profiles: [hermes],
    bindings: { a4: ["s1"] },
    ownRuntime: () => ({ workspace: "/h/workspaces/a4", ready: true, shared: true }),
  });
  assert.equal(shared.agentFolders[0].status, "unavailable");
  assert.deepEqual(shared.agentFolders[0].values, []);
});
