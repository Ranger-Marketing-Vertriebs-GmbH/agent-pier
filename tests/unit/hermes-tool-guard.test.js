import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hermesGuard } from "../../server/features/assistants/hermes-tool-guard.js";
import { attachHermesFleet } from "../../server/features/assistants/runtimes/runtime-for.js";
import { HermesFleet } from "../../server/features/assistants/runtimes/hermes/hermes-fleet.js";
import { secretsRefusal } from "../../server/features/assistants/team-plugin/secrets-guard.js";
import {
  attachmentRefusal,
  browserRefusals,
  pdfRefusals,
  writeRefusals,
} from "../../server/features/assistants/team-plugin/tool-guard.js";

// The Hermes team plugin's guard (hermes-tool-guard.js) applies the OpenClaw tool
// guard's rules to Hermes's own tools: the browser asks AgentBrowsers, a file change
// stays in the agent's folder and is allowed only as the bridge allows the turn.
function guardBridge(t, { allow = true, browser = { allow: true } } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-guard-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const supervisor = {};
  attachHermesFleet(supervisor, new HermesFleet({ dataDir }));
  const agent = { id: "m1", runtime: "hermes", runtimeAgentId: "ap-m1" };
  const calls = [];
  const bridge = {
    assistants: { runtime: supervisor },
    agentOf: (id) => (id === "ap-m1" ? agent : null),
    toolPolicy: async (input) => {
      calls.push(["tool", input]);
      return { allow };
    },
    browserPolicy: async (input) => {
      calls.push(["browser", input]);
      return browser;
    },
    attachmentPolicy: (input) => {
      calls.push(["attachments", input]);
      return { allow: input.files.every((file) => file === "mine.png") };
    },
    callingChat: () => ({}),
  };
  const workspace = path.join(dataDir, "assistants", "workspaces", "m1");
  return { bridge, calls, workspace };
}
// A member's file change (the plugin's guardWrites) names itself as such.
const call = (toolName, args, extra = {}) => ({
  agentId: "ap-m1",
  sessionKey: "agent:ap-m1:hermes:s1",
  toolName,
  args,
  ...(["write_file", "patch"].includes(toolName) && { memberWrite: true }),
  ...extra,
});

test("a write inside the agent's folder asks the bridge for the turn", async (t) => {
  const { bridge, calls } = guardBridge(t);
  assert.deepEqual(
    await hermesGuard(bridge, call("write_file", { path: "notes.txt", content: "x" })),
    { allow: true },
  );
  assert.deepEqual(calls, [
    [
      "tool",
      {
        agentId: "ap-m1",
        sessionKey: "agent:ap-m1:hermes:s1",
        toolName: "write",
        path: "notes.txt",
      },
    ],
  ]);
  // A V4A patch names each file it changes.
  calls.length = 0;
  const patch =
    "*** Begin Patch\n*** Add File: a.md\n+x\n*** Update File: b/c.md\n@@\n-y\n+z\n*** End Patch";
  await hermesGuard(bridge, call("patch", { mode: "patch", patch }));
  assert.deepEqual(
    calls.map(([, input]) => [input.toolName, input.path]),
    [
      ["apply_patch", "a.md"],
      ["apply_patch", "b/c.md"],
    ],
  );
});

test("a write the turn may not make, or outside the folder, is refused", async (t) => {
  const refused = guardBridge(t, { allow: false });
  assert.deepEqual(
    await hermesGuard(refused.bridge, call("patch", { path: "a.md", old_string: "a" })),
    { allow: false, message: writeRefusals.owner },
  );
  const { bridge, calls, workspace } = guardBridge(t);
  for (const [args, message] of [
    [{ path: "../ap-other/x.md" }, writeRefusals.outside],
    [{ path: "/etc/hosts" }, writeRefusals.outside],
    [{ path: path.join(workspace, "..", "other", "x") }, writeRefusals.outside],
    [{ path: "AGENTS.md" }, writeRefusals.bootstrap],
    [{ path: "skills/x/SKILL.md" }, writeRefusals.bootstrap],
    [{}, writeRefusals.outside],
  ])
    assert.deepEqual(await hermesGuard(bridge, call("write_file", args)), {
      allow: false,
      message,
    });
  // Without a session no turn is known.
  assert.deepEqual(
    await hermesGuard(bridge, {
      agentId: "ap-m1",
      toolName: "write_file",
      args: { path: "a" },
      memberWrite: true,
    }),
    { allow: false, message: writeRefusals.unauthorized },
  );
  assert.deepEqual(calls, []);
  // An absolute path into its own folder is its own.
  assert.deepEqual(
    await hermesGuard(
      bridge,
      call("write_file", { path: path.join(workspace, "ok.md") }),
    ),
    { allow: true },
  );
});

test("browser calls follow AgentBrowsers' answer; other tools pass", async (t) => {
  const { bridge, calls } = guardBridge(t, {
    browser: { allow: false, reason: "visibleLimit" },
  });
  assert.deepEqual(await hermesGuard(bridge, call("browser_navigate", { url: "x" })), {
    allow: false,
    message: browserRefusals.visibleLimit,
  });
  assert.deepEqual(calls, [
    [
      "browser",
      { agentId: "ap-m1", sessionKey: "agent:ap-m1:hermes:s1", action: "navigate" },
    ],
  ]);
  assert.deepEqual(await hermesGuard(bridge, call("read_file", { path: "x" })), {
    allow: true,
  });
  // An agent that is not a Hermes agent of this AgentPier gets nothing.
  assert.equal(
    (await hermesGuard(bridge, { ...call("browser_click", {}), agentId: "ap-x" })).allow,
    false,
  );
  await assert.rejects(hermesGuard(bridge, { ...call("x", {}), extra: 1 }), {
    key: "invalid",
  });
});

test("a file call naming attachments/ or the secrets folder asks as OpenClaw's guard", async (t) => {
  const { bridge, calls, workspace } = guardBridge(t);
  // An own agent's call: no member write, only the folder rules.
  const own = (toolName, args) => ({ ...call(toolName, args), memberWrite: undefined });
  const strip = ({ memberWrite: _memberWrite, ...input }) => input;
  assert.deepEqual(
    await hermesGuard(bridge, strip(own("read_file", { path: "attachments/mine.png" }))),
    { allow: true },
  );
  assert.deepEqual(
    await hermesGuard(
      bridge,
      strip(
        own("vision_analyze", { image_url: path.join(workspace, "attachments/x.png") }),
      ),
    ),
    { allow: false, message: attachmentRefusal },
  );
  assert.deepEqual(
    calls.map(([kind, input]) => [kind, input.files]),
    [
      ["attachments", ["mine.png"]],
      ["attachments", ["x.png"]],
    ],
  );
  // Without a session no chat is known: attachments stay closed.
  assert.equal(
    (
      await hermesGuard(bridge, {
        agentId: "ap-m1",
        toolName: "read_file",
        args: { path: "attachments/mine.png" },
      })
    ).allow,
    false,
  );
  // The secrets folder is readable outside a hook run without its Secrets switch.
  assert.deepEqual(
    await hermesGuard(
      bridge,
      strip(own("read_file", { path: ".agentpier/secrets.env" })),
    ),
    { allow: true },
  );
  // An own agent's write outside a folder rule is Hermes's own.
  assert.deepEqual(
    await hermesGuard(bridge, strip(own("write_file", { path: "/etc/x" }))),
    { allow: true },
  );
});

test("after a compression the guard finds the chat by its earlier segment", async (t) => {
  const { bridge, calls } = guardBridge(t);
  bridge.assistants.store = {
    listConversations: () => [
      { assistantId: "m1", runtimeSessionKey: "agent:ap-m1:hermes:s1" },
    ],
  };
  const input = {
    agentId: "ap-m1",
    sessionKey: "agent:ap-m1:hermes:s1-tip",
    segments: ["agent:ap-m1:hermes:s1"],
    toolName: "read_file",
    args: { path: "attachments/mine.png" },
  };
  assert.deepEqual(await hermesGuard(bridge, input), { allow: true });
  assert.equal(calls[0][1].sessionKey, "agent:ap-m1:hermes:s1");
  await assert.rejects(hermesGuard(bridge, { ...input, segments: "x" }), {
    key: "invalid",
  });
});

test("a pdf call reads files of the agent's own folder with the model AgentPier names", async (t) => {
  const { bridge, calls, workspace } = guardBridge(t);
  let answer = { allow: true, reader: "fallback" };
  bridge.assistants.pdfPolicy = {
    reader: async (input) => {
      calls.push(["pdf", input]);
      return answer;
    },
  };
  fs.mkdirSync(path.join(workspace, "docs"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "docs", "a.pdf"), "%PDF-1.4\n");
  const pdf = (args, extra) => ({ ...call("pdf", args), ...extra });
  assert.deepEqual(await hermesGuard(bridge, pdf({ pdf: "docs/a.pdf" })), {
    allow: true,
    reader: "fallback",
  });
  assert.deepEqual(calls, [
    ["pdf", { agentId: "ap-m1", sessionKey: "agent:ap-m1:hermes:s1" }],
  ]);
  assert.deepEqual(
    await hermesGuard(
      bridge,
      pdf({ pdfs: [path.join(workspace, "docs/a.pdf"), "docs/new.pdf"] }),
    ),
    { allow: true, reader: "fallback" },
  );
  // Never a web address, a path outside its folder, or a link out of it.
  fs.symlinkSync("/etc", path.join(workspace, "out"));
  for (const args of [
    { pdf: "https://example.com/a.pdf" },
    { pdf: "file:///etc/a.pdf" },
    { pdf: "../m2/a.pdf" },
    { pdf: "/etc/a.pdf" },
    { pdf: "out/hosts" },
    { pdfs: "docs/a.pdf" },
    { pdfs: Array.from({ length: 11 }, () => "docs/a.pdf") },
    {},
  ])
    assert.deepEqual(await hermesGuard(bridge, pdf(args)), {
      allow: false,
      message: pdfRefusals.reference,
    });
  // Attachments only from the calling chat, as for read_file.
  calls.length = 0;
  assert.deepEqual(await hermesGuard(bridge, pdf({ pdf: "attachments/other.pdf" })), {
    allow: false,
    message: attachmentRefusal,
  });
  assert.deepEqual(calls, [
    [
      "attachments",
      { agentId: "ap-m1", sessionKey: "agent:ap-m1:hermes:s1", files: ["other.pdf"] },
    ],
  ]);
  // A link inside its folder that points at an attachment counts as that attachment.
  fs.mkdirSync(path.join(workspace, "attachments"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "attachments", "other.pdf"), "%PDF-1.4\n");
  fs.symlinkSync(
    path.join(workspace, "attachments", "other.pdf"),
    path.join(workspace, "docs/l.pdf"),
  );
  assert.deepEqual(await hermesGuard(bridge, pdf({ pdf: "docs/l.pdf" })), {
    allow: false,
    message: attachmentRefusal,
  });
  // A hook run without the hook's Secrets switch reads no secrets, also as a PDF.
  bridge.assistants.routines = {
    hooks: {
      events: { byJob: () => ({ id: "e1" }) },
      secretsRead: () => ({ allow: false }),
    },
  };
  const hook = { sessionKey: "agent:ap-m1:hermes:cron:job1:s1" };
  assert.deepEqual(await hermesGuard(bridge, pdf({ pdf: ".agentpier/x.pdf" }, hook)), {
    allow: false,
    message: secretsRefusal,
  });
  delete bridge.assistants.routines;
  // The fallback's identity reaches the tool, which compares it with its own.
  answer = { allow: true, reader: "fallback", fallback: "c1\nm1" };
  assert.deepEqual(await hermesGuard(bridge, pdf({ pdf: "docs/a.pdf" })), {
    allow: true,
    reader: "fallback",
    fallback: "c1\nm1",
  });
  // The policy's refusals reach the model as OpenClaw's pdf hook words them.
  answer = { allow: false, reason: "notGranted" };
  assert.deepEqual(await hermesGuard(bridge, pdf({ pdf: "docs/a.pdf" })), {
    allow: false,
    message: pdfRefusals.notGranted,
  });
  answer = null;
  assert.deepEqual(await hermesGuard(bridge, pdf({ pdf: "docs/a.pdf" })), {
    allow: false,
    message: pdfRefusals.unavailable,
  });
});
