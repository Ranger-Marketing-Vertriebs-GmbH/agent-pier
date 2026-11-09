import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hermesGuard } from "../../server/features/assistants/hermes-tool-guard.js";
import {
  chatFilesRefusal,
  homeRefusal,
} from "../../server/features/assistants/hermes-home-guard.js";
import { attachHermesFleet } from "../../server/features/assistants/runtimes/runtime-for.js";
import { HermesFleet } from "../../server/features/assistants/runtimes/hermes/hermes-fleet.js";
import { hermesPaths } from "../../server/features/assistants/runtimes/hermes/hermes-paths.js";
import { secretsRefusal } from "../../server/features/assistants/team-plugin/secrets-guard.js";
import { pdfRefusals } from "../../server/features/assistants/team-plugin/tool-guard.js";

// A Hermes agent keeps each chat's uploads in <assistants>/chat-files/<agent>/<chat>/
// (chat-file-folders.js). On an agent shared with users a turn reads only its work
// folder and its own chat's folder (hermes-home-guard.js); every agent's file calls
// into the chat folders stay in its own; and a search over the secrets folder asks
// as a read of the secrets does.

function setup(t, { shared = true } = {}) {
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chat-guard-")));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const supervisor = {};
  attachHermesFleet(supervisor, new HermesFleet({ dataDir }));
  const agent = {
    id: "m1",
    runtime: "hermes",
    runtimeAgentId: "ap-m1",
    ...(shared && { userAccess: { mode: "shared", members: [] } }),
  };
  const paths = hermesPaths(dataDir);
  const workspace = path.join(paths.agentWorkspaces, "m1");
  fs.mkdirSync(workspace, { recursive: true });
  const chats = path.join(dataDir, "assistants", "chat-files");
  const file = (agentId, chat, name) => {
    fs.mkdirSync(path.join(chats, agentId, chat), { recursive: true });
    fs.writeFileSync(path.join(chats, agentId, chat, name), "%PDF-1.4\n");
    return path.join(chats, agentId, chat, name);
  };
  const bridge = {
    assistants: {
      runtime: supervisor,
      attachments: { config: { workspaces: paths.agentWorkspaces } },
      pdfPolicy: { reader: () => ({ allow: true, reader: "own" }) },
    },
    agentOf: (id) => (id === "ap-m1" ? agent : null),
    attachmentPolicy: () => ({ allow: true }),
    toolPolicy: () => ({ allow: true }),
    callingChat: () => ({ conversation: { id: "chat-a", assistantId: "m1" } }),
  };
  const guard = (toolName, args, extra = {}) =>
    hermesGuard(bridge, {
      agentId: "ap-m1",
      sessionKey: "agent:ap-m1:hermes:s1",
      toolName,
      args,
      ...extra,
    });
  return { bridge, guard, workspace, chats, file, dataDir };
}
const allowed = { allow: true };
const home = { allow: false, message: homeRefusal };
const other = { allow: false, message: chatFilesRefusal };

test("a shared agent reads its work folder and its own chat's folder only", async (t) => {
  const { guard, chats, file, dataDir } = setup(t);
  const mine = file("m1", "chat-a", "mine.pdf");
  const theirs = file("m1", "chat-b", "theirs.pdf");
  const elsewhere = file("m2", "chat-c", "x.pdf");
  for (const [tool, args] of [
    ["read_file", { path: mine }],
    ["read_file", { path: "notes.md" }],
    ["vision_analyze", { image_url: mine }],
    ["search_files", { pattern: "x" }],
    ["search_files", { path: ".", pattern: "x" }],
    ["search_files", { path: path.dirname(mine), pattern: "x" }],
  ])
    assert.deepEqual(await guard(tool, args), allowed, `${tool} ${JSON.stringify(args)}`);
  for (const [tool, args] of [
    ["read_file", { path: theirs }],
    ["read_file", { path: theirs.toUpperCase() }],
    ["read_file", { path: elsewhere }],
    ["read_file", { path: `../../chat-files/m1/chat-b/theirs.pdf` }],
    ["vision_analyze", { image_url: `file://${theirs}` }],
    // A search whose folder holds other chats' folders, or lies outside both.
    ["search_files", { path: path.join(chats, "m1"), pattern: "x" }],
    ["search_files", { path: chats, pattern: "x" }],
    ["search_files", { path: "/", pattern: "x" }],
    ["search_files", { path: dataDir, target: "files", pattern: "*" }],
    ["search_files", { path: "..", pattern: "x" }],
    // Several paths in one, as Hermes splits a path that does not exist.
    ["search_files", { path: `docs ${path.join(chats, "m1", "chat-b")}`, pattern: "x" }],
    ["search_files", { path: `docs,${chats}`, pattern: "x" }],
    // Another agent's work folder.
    [
      "read_file",
      {
        path: path.join(
          path.dirname(path.dirname(mine)),
          "..",
          "..",
          "workspaces",
          "m2",
          "a.md",
        ),
      },
    ],
    ["read_file", { path: "/etc/hosts" }],
  ])
    assert.deepEqual(await guard(tool, args), home, `${tool} ${JSON.stringify(args)}`);
  // Writes stay in its own chat's folder.
  assert.deepEqual(
    await guard("write_file", { path: path.join(path.dirname(mine), "out.md") }),
    allowed,
  );
  assert.deepEqual(
    await guard("write_file", { path: path.join(path.dirname(theirs), "x.md") }),
    other,
  );
  // PDFs and image references from its own chat's folder, never another's.
  assert.deepEqual(await guard("pdf", { pdf: mine }), { allow: true, reader: "own" });
  assert.deepEqual(await guard("pdf", { pdf: theirs }), {
    allow: false,
    message: pdfRefusals.reference,
  });
});

test("a turn with no chat of the agent reads no chat folder", async (t) => {
  const { bridge, guard, file } = setup(t);
  const mine = file("m1", "chat-a", "mine.pdf");
  bridge.callingChat = () => ({ conversation: { id: "chat-a", assistantId: "m2" } });
  assert.deepEqual(await guard("read_file", { path: mine }), home);
  bridge.callingChat = () => {
    throw new Error("unknown");
  };
  assert.deepEqual(await guard("read_file", { path: mine }), home);
});

test("an agent not shared reads every chat of its own, never another agent's", async (t) => {
  const { guard, chats, file } = setup(t, { shared: false });
  const theirs = file("m1", "chat-b", "theirs.pdf");
  const elsewhere = file("m2", "chat-c", "x.pdf");
  assert.deepEqual(await guard("read_file", { path: theirs }), allowed);
  assert.deepEqual(await guard("pdf", { pdf: theirs }), { allow: true, reader: "own" });
  assert.deepEqual(await guard("read_file", { path: "/etc/hosts" }), allowed);
  assert.deepEqual(await guard("read_file", { path: elsewhere }), other);
  assert.deepEqual(await guard("search_files", { path: chats, pattern: "x" }), other);
  assert.deepEqual(
    await guard("write_file", { path: path.join(chats, "m2", "chat-c", "y.md") }),
    other,
  );
});

test("a search over the secrets folder is a read of the secrets", async (t) => {
  const { bridge, guard, workspace } = setup(t, { shared: false });
  // Without a secrets folder there is nothing to ask about.
  assert.deepEqual(await guard("search_files", { pattern: "sk-" }), allowed);
  fs.mkdirSync(path.join(workspace, ".agentpier"));
  fs.writeFileSync(path.join(workspace, ".agentpier", "secrets.env"), "KEY=sk-1\n");
  // The owner's chats read it.
  assert.deepEqual(await guard("search_files", { pattern: "sk-" }), allowed);
  bridge.assistants.routines = {
    hooks: {
      events: { byJob: () => ({ id: "e1" }) },
      secretsRead: () => ({ allow: false }),
    },
  };
  const hook = { sessionKey: "agent:ap-m1:hermes:cron:job1:s1" };
  const refused = { allow: false, message: secretsRefusal };
  for (const search of [
    { pattern: "sk-" },
    { path: ".", pattern: "sk-" },
    { path: "./", pattern: "sk-" },
    { path: workspace, pattern: "sk-" },
    { path: path.dirname(workspace), pattern: "sk-" },
    { path: "docs .", pattern: "sk-" },
  ])
    assert.deepEqual(
      await guard("search_files", search, hook),
      refused,
      JSON.stringify(search),
    );
  // A search of a folder beside it reads no secrets.
  fs.mkdirSync(path.join(workspace, "docs"));
  assert.deepEqual(
    await guard("search_files", { path: "docs", pattern: "sk-" }, hook),
    allowed,
  );
});
