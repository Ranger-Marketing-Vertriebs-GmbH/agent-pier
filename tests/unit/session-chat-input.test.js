import test from "node:test";
import assert from "node:assert/strict";
import * as chat from "../../server/features/sessions/session-chat-input.js";

test("chat text normalizes line endings and preserves Unicode, tabs and file paths", () => {
  assert.equal(
    chat.normalizeChatText("A\r\nB\rC\tD /tmp/ä file.js"),
    "A\nB\nC\tD /tmp/ä file.js",
  );
});

test("chat text rejects terminal controls and validates its size before any write", () => {
  for (const text of [
    "a\x1b[201~",
    "a\x03",
    "a\x9b",
    "a\0",
    "a\x7f",
    "a\x85",
    "",
    1,
    "a".repeat(32001),
  ])
    assert.throws(() => chat.normalizeChatText(text), { status: 400 });
  assert.equal(chat.normalizeChatText("a".repeat(32000)).length, 32000);
});

function transport(failCommand) {
  const events = [];
  return {
    events,
    target: () => "=session",
    tmux: async (args, options) => {
      events.push({ args, input: options?.input });
      if (args[0] === failCommand) throw Error("Transport failed");
      return "";
    },
  };
}

test("direct multiline input preserves data and journals intents before external writes", async () => {
  const manager = transport();
  await chat.writeChatTuiInput(
    manager,
    { id: "one", tool: "claude" },
    "ä\n/tmp/a b\tEnd",
    {
      onPhase: async (phase) => manager.events.push(phase),
    },
  );
  assert.deepEqual(
    manager.events.map((event) => (typeof event === "string" ? event : event.args[0])),
    [
      "paste-intent",
      "load-buffer",
      "paste-buffer",
      "pasted",
      "submit-intent",
      "send-keys",
      "submitted",
    ],
  );
  assert.equal(manager.events[1].input, "ä\n/tmp/a b\tEnd");
  assert.deepEqual(manager.events[2].args.slice(0, 4), [
    "paste-buffer",
    "-d",
    "-p",
    "-r",
  ]);
  assert.equal(manager.events[1].args[2], manager.events[2].args[5]);
  assert.equal(manager.events[5].args.at(-1), "Enter");
});

test("slash commands use literal input while multiline slash mentions use paste", async () => {
  for (const [text, command] of [
    ["/clear", "send-keys"],
    ["/clear\nexplain", "load-buffer"],
  ]) {
    const manager = transport();
    await chat.writeChatTuiInput(manager, { id: "one", tool: "claude" }, text);
    assert.equal(manager.events[0].args[0], command);
    if (command === "send-keys")
      assert.deepEqual(manager.events[0].args.slice(-2), ["--", "/clear"]);
  }
});

test("paste errors clean up the buffer and never submit or retry", async () => {
  const manager = transport("paste-buffer");
  await assert.rejects(
    chat.writeChatTuiInput(manager, { id: "one", tool: "claude" }, "hello", {
      onPhase: async (phase) => manager.events.push(phase),
    }),
    /Transport failed/,
  );
  assert.deepEqual(
    manager.events.map((event) => (typeof event === "string" ? event : event.args[0])),
    ["paste-intent", "load-buffer", "paste-buffer", "delete-buffer"],
  );
});

test("failed journal writes prevent the following external side effect", async () => {
  const manager = transport();
  await assert.rejects(
    chat.writeChatTuiInput(manager, { id: "one", tool: "claude" }, "hello", {
      onPhase: async (phase) => {
        if (phase === "submit-intent") throw Error("Disk failed");
      },
    }),
    /Disk failed/,
  );
  assert.deepEqual(
    manager.events.map((event) => event.args[0]),
    ["load-buffer", "paste-buffer"],
  );
});

test("submit-only writes no text and a failed Enter is never retried", async () => {
  const manager = transport("send-keys");
  await assert.rejects(
    chat.writeChatTuiInput(manager, { id: "one", tool: "claude" }, "hello", {
      submitOnly: true,
      onPhase: async (phase) => manager.events.push(phase),
    }),
    /Transport failed/,
  );
  assert.deepEqual(
    manager.events.map((event) => (typeof event === "string" ? event : event.args[0])),
    ["submit-intent", "send-keys"],
  );
});

const codexScreen = (line) =>
  `Previous output says approve this request\n\n${line}\n\n  probe default · /tmp/project\n`;
const codexPane = { cursorX: 2, cursorY: 2, width: 120, height: 35 };

test("Codex readiness uses the cursor composer and styled placeholder, never transcript words", () => {
  assert.deepEqual(
    chat.inspectChatComposer(
      "codex",
      codexScreen("\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m"),
      codexPane,
    ),
    { state: "empty", text: "" },
  );
  assert.deepEqual(
    chat.inspectChatComposer(
      "codex",
      codexScreen("\x1b[1m›\x1b[0m Ask Codex to do anything"),
      { ...codexPane, cursorX: 26 },
    ),
    { state: "text", text: "Ask Codex to do anything" },
  );
  assert.equal(
    chat.inspectChatComposer("codex", codexScreen("› stale transcript"), {
      ...codexPane,
      cursorY: 0,
    }).state,
    "unknown",
  );
});

test("Codex cropped or wrapped composers cannot prove a complete recovery match", () => {
  for (const raw of [
    "› first row\n  wrapped row\n\n  probe default · /tmp/project",
    "› [Pasted Content 1000 chars]\n\n  probe default · /tmp/project",
  ])
    assert.equal(
      chat.inspectChatComposer("codex", raw, { ...codexPane, cursorY: 0, cursorX: 11 })
        .state,
      "unknown",
    );
  assert.equal(
    chat.inspectChatComposer("unknown", "anything", codexPane).state,
    "unknown",
  );
});

test("Claude empty composer requires both borders and its actual cursor position", () => {
  const raw = `Response\n${"─".repeat(120)}\n\x1b[39m❯ \x1b[7m \x1b[0m\n${"─".repeat(120)}\n  ⏸ manual mode on · ? for shortcuts · ← for agents\n`;
  assert.deepEqual(chat.inspectChatComposer("claude", raw, codexPane), {
    state: "empty",
    text: "",
  });
  assert.equal(
    chat.inspectChatComposer("claude", raw, { ...codexPane, cursorX: 3 }).state,
    "unknown",
  );
  assert.equal(
    chat.inspectChatComposer("claude", raw.replace("─".repeat(120), "Allow?"), codexPane)
      .state,
    "unknown",
  );
});

import { SessionOperations } from "../../server/features/sessions/session-operations.js";

function sessionManager() {
  const manager = transport();
  const operations = new SessionOperations(() => Promise.resolve());
  manager.replacing = new Set();
  manager.serial = (operation, id) => operations.run(operation, id);
  manager.session = { id: "one", tool: "codex", accountId: "account", status: "running" };
  manager.current = async () => ({ ...manager.session });
  manager.screen = codexScreen("\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m");
  manager.paneId = "%1";
  manager.cursorX = 2;
  const original = manager.tmux;
  manager.tmux = async (args, options) => {
    if (args[0] === "display-message")
      return `${manager.paneId}|${process.pid}|1|${manager.cursorX}|2|120|35|0\n${manager.screen}`;
    return original(args, options);
  };
  return manager;
}

test("chat transaction exposes generation and blocks stale pane writes", async () => {
  const manager = sessionManager();
  await chat.withChatInput(manager, "one", async (tx) => {
    assert.equal(tx.composer.state, "empty");
    assert.match(tx.generation, /^[a-f0-9]{64}$/);
    manager.paneId = "%2";
    await assert.rejects(tx.write("hello"), { status: 409 });
  });
  assert.deepEqual(manager.events, []);
});

test("chat transaction permits inspection of an occupied draft but refuses full paste", async () => {
  const manager = sessionManager();
  manager.screen = codexScreen("\x1b[1m›\x1b[0m existing draft");
  manager.cursorX = 16;
  await chat.withChatInput(manager, "one", async (tx) => {
    assert.equal(tx.composer.state, "text");
    await assert.rejects(tx.write("hello"), { status: 409 });
    await assert.rejects(tx.write("wrong", { submitOnly: true }), { status: 409 });
    await tx.write("existing draft", { submitOnly: true });
    await assert.rejects(tx.write("existing draft", { submitOnly: true }), {
      status: 409,
    });
  });
  assert.deepEqual(
    manager.events.map((event) => event.args[0]),
    ["send-keys"],
  );
});

test("replacement, reload, stopped and headless guards prevent chat inspection and writes", async () => {
  for (const patch of [
    { reload: { state: "reloading" } },
    { status: "stopped" },
    { pipeline: { headless: true } },
    { purpose: "login" },
    { tool: "shell" },
  ]) {
    const manager = sessionManager();
    Object.assign(manager.session, patch);
    await assert.rejects(
      chat.withChatInput(manager, "one", () => assert.fail("Guard bypass")),
      { status: 409 },
    );
    assert.deepEqual(manager.events, []);
  }
  const manager = sessionManager();
  manager.replacing.add("one");
  await assert.rejects(
    chat.withChatInput(manager, "one", () => assert.fail("Replacement bypass")),
    { status: 409 },
  );
});

test("chat inspection and writes retain the per-session lock until the operation ends", async () => {
  const manager = sessionManager();
  const order = [];
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const first = chat.withChatInput(manager, "one", async () => {
    order.push("inspect");
    await hold;
    order.push("finish");
  });
  const next = manager.serial(() => order.push("next"), "one");
  try {
    await manager.serial(() => order.push("other"), "two");
    assert.ok(!order.includes("next"));
  } finally {
    release();
    await Promise.all([first, next]);
  }
  assert.ok(order.indexOf("next") > order.indexOf("finish"));
});

import { readFile } from "node:fs/promises";

for (const tool of ["codex", "claude", "opencode"]) {
  test(`${tool}: captured native idle screen identifies only its empty composer`, async () => {
    const { raw, pane } = JSON.parse(
      await readFile(
        new URL(`../fixtures/tui-input/${tool}-idle.json`, import.meta.url),
        "utf8",
      ),
    );
    assert.deepEqual(chat.inspectChatComposer(tool, raw, pane), {
      state: "empty",
      text: "",
    });
    assert.equal(
      chat.inspectChatComposer(tool, raw, { ...pane, cursorY: 0 }).state,
      "unknown",
    );
  });
}

test("Codex dim placeholders may vary while trailing spaces cannot prove exact draft text", () => {
  assert.deepEqual(
    chat.inspectChatComposer(
      "codex",
      codexScreen("\x1b[1m›\x1b[0m \x1b[2mFind a bug in this project\x1b[0m"),
      codexPane,
    ),
    { state: "empty", text: "" },
  );
  assert.equal(
    chat.inspectChatComposer("codex", codexScreen("\x1b[1m›\x1b[0m draft"), codexPane)
      .state,
    "unknown",
  );
});

test("two concurrent writes inside one chat transaction cannot paste twice", async () => {
  const manager = sessionManager();
  await chat.withChatInput(manager, "one", async (tx) => {
    const results = await Promise.allSettled([tx.write("hello"), tx.write("hello")]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  });
  assert.equal(
    manager.events.filter((event) => event.args[0] === "paste-buffer").length,
    1,
  );
});

test("ended chat transactions cannot be used as an unlocked terminal writer", async () => {
  const manager = sessionManager();
  let saved;
  await chat.withChatInput(manager, "one", (tx) => {
    saved = tx;
  });
  await assert.rejects(saved.write("hello"), { status: 409 });
  assert.deepEqual(manager.events, []);
});

for (const tool of ["codex", "opencode"]) {
  for (const state of ["busy", "busy-queued", "draft"]) {
    test(`${tool}: native ${state} composer is inspected without waiting for task completion`, async () => {
      const { raw, pane } = JSON.parse(
        await readFile(
          new URL(`../fixtures/tui-input/${tool}-${state}-native.json`, import.meta.url),
          "utf8",
        ),
      );
      assert.deepEqual(
        chat.inspectChatComposer(tool, raw, pane),
        state === "draft"
          ? { state: "text", text: "SYNTHETIC draft ünicode" }
          : { state: "empty", text: "" },
      );
    });
  }
}

test("a replacement beginning during intent persistence prevents terminal bytes", async () => {
  const manager = sessionManager();
  await chat.withChatInput(manager, "one", async (tx) => {
    await assert.rejects(
      tx.write("hello", {
        onPhase: async (phase) => {
          if (phase === "paste-intent") manager.replacing.add("one");
        },
      }),
      { status: 409 },
    );
  });
  assert.deepEqual(manager.events, []);
});

test("generation changes after paste prevent submitting into a replacement process", async () => {
  const manager = sessionManager();
  await chat.withChatInput(manager, "one", async (tx) => {
    await assert.rejects(
      tx.write("hello", {
        onPhase: async (phase) => {
          if (phase === "submit-intent") manager.paneId = "%2";
        },
      }),
      { status: 409 },
    );
  });
  assert.deepEqual(
    manager.events.map((event) => event.args[0]),
    ["load-buffer", "paste-buffer"],
  );
});

for (const state of ["idle", "busy", "busy-queued", "draft"]) {
  test(`Claude native ${state} composer distinguishes queued placeholder from real text`, async () => {
    const { raw, pane } = JSON.parse(
      await readFile(
        new URL(`../fixtures/tui-input/claude-${state}-native.json`, import.meta.url),
        "utf8",
      ),
    );
    assert.deepEqual(
      chat.inspectChatComposer("claude", raw, pane),
      state === "draft"
        ? { state: "text", text: "SYNTHETIC draft ünicode" }
        : { state: "empty", text: "" },
    );
  });
}

import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pidStart } from "../../vendor/agentbus/core/proc.js";

test("native conversation changes invalidate recovery even when the pane stays alive", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentpier-chat-generation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = sessionManager();
  manager.directory = path.join(root, "sessions");
  manager.session.nativeBinding = { enabled: true };
  const directory = path.join(root, "native-sessions");
  await mkdir(directory);
  const launch = {
    id: "one",
    accountId: "account",
    tool: "codex",
    token: "synthetic-private-token",
  };
  const receipt = {
    ...launch,
    pid: process.pid,
    pidStart: pidStart(process.pid),
    providerSessionId: "native-one",
  };
  await writeFile(path.join(directory, "one.launch.json"), JSON.stringify(launch));
  const receiptFile = path.join(directory, "one.receipt.json");
  await writeFile(receiptFile, JSON.stringify(receipt));
  await chat.withChatInput(manager, "one", async (tx) => {
    await writeFile(
      receiptFile,
      JSON.stringify({ ...receipt, providerSessionId: "native-two" }),
    );
    await assert.rejects(tx.write("hello"), { status: 409 });
  });
  assert.deepEqual(manager.events, []);
  await writeFile(receiptFile, JSON.stringify({ ...receipt, pidStart: "stale-process" }));
  await assert.rejects(
    chat.withChatInput(manager, "one", () =>
      assert.fail("Stale native process accepted"),
    ),
    { status: 409 },
  );
});

test("first native input needs a valid launch but cannot authorize recovery without a receipt", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentpier-chat-missing-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = sessionManager();
  manager.directory = path.join(root, "sessions");
  manager.session.nativeBinding = { enabled: true };
  manager.session.cwd = root;
  const directory = path.join(root, "native-sessions");
  await mkdir(directory);
  const identity = {
    id: "one",
    accountId: "account",
    tool: "codex",
    cwd: await realpath(root),
    token: "synthetic",
    pid: process.pid,
    pidStart: pidStart(process.pid),
    providerSessionId: "native-one",
  };
  const launchFile = path.join(directory, "one.launch.json");
  const receiptFile = path.join(directory, "one.receipt.json");
  await assert.rejects(
    chat.withChatInput(manager, "one", () => assert.fail("Missing launch accepted")),
    { status: 409 },
  );
  await writeFile(launchFile, JSON.stringify(identity));
  await chat.withChatInput(manager, "one", async (tx) => {
    assert.equal(tx.recoveryGeneration, null);
    assert.match(tx.generation, /^[a-f0-9]{64}$/);
    await tx.write("first prompt");
  });
  assert.deepEqual(
    manager.events.map((event) => event.args[0]),
    ["load-buffer", "paste-buffer", "send-keys"],
  );
  await writeFile(receiptFile, JSON.stringify(identity));
  await chat.withChatInput(manager, "one", (tx) =>
    assert.equal(tx.recoveryGeneration, tx.generation),
  );
  await writeFile(launchFile, JSON.stringify({ ...identity, token: "" }));
  await assert.rejects(
    chat.withChatInput(manager, "one", () => assert.fail("Invalid launch accepted")),
    { status: 409 },
  );
});

test("Codex slash submit-only recovery lets the native literal paste burst settle without retyping", async () => {
  const manager = transport();
  const started = performance.now();
  await chat.writeChatTuiInput(manager, { id: "one", tool: "codex" }, "/clear", {
    submitOnly: true,
  });
  assert.ok(
    performance.now() - started >= 200,
    "Enter preceded the native paste-burst separation",
  );
  assert.deepEqual(
    manager.events.map((event) => event.args),
    [["send-keys", "-t", "=session:0.0", "Enter"]],
  );
});

test("OpenCode Plan and custom agent labels retain the same scoped composer boundary", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("../fixtures/tui-input/opencode-busy-native.json", import.meta.url),
      "utf8",
    ),
  );
  for (const agent of ["Plan", "Code review"]) {
    const raw = fixture.raw.replaceAll("Build", agent);
    assert.deepEqual(chat.inspectChatComposer("opencode", raw, fixture.pane), {
      state: "empty",
      text: "",
    });
    const lines = raw.split("\n");
    lines[fixture.pane.cursorY + 2] = lines[fixture.pane.cursorY + 2].replaceAll(
      "·",
      "?",
    );
    assert.equal(
      chat.inspectChatComposer("opencode", lines.join("\n"), fixture.pane).state,
      "unknown",
    );
  }
});

test("OpenCode recovery cannot ignore a styled suffix after the original draft", async () => {
  const { raw, pane } = JSON.parse(
    await readFile(
      new URL("../fixtures/tui-input/opencode-draft-native.json", import.meta.url),
      "utf8",
    ),
  );
  const altered = raw.replace(
    "SYNTHETIC draft ünicode\x1b[38;2;255;255;255m",
    "SYNTHETIC draft ünicode\x1b[38;2;255;255;255m\x1b[38;2;100;100;100m EXTRA\x1b[38;2;255;255;255m",
  );
  assert.equal(chat.inspectChatComposer("opencode", altered, pane).state, "unknown");
});

test("captured OpenCode Plan composer remains ready", async () => {
  const { raw, pane } = JSON.parse(
    await readFile(
      new URL("../fixtures/tui-input/opencode-plan-native.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(chat.inspectChatComposer("opencode", raw, pane), {
    state: "empty",
    text: "",
  });
});
