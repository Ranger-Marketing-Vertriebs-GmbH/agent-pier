import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultLaunchAccess,
  preferredLaunchAccess,
  rememberLaunchChoice,
  rememberedLaunchAccess,
  rememberedLaunchTool,
  rememberLaunchFolder,
  rememberedLaunchFolder,
  profileLaunchAccess,
  rememberedLaunchModel,
} from "../../web/features/sessions/launch-preferences.js";

const key = "agentpier.launch-preferences";

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (name) => (data.has(name) ? data.get(name) : null),
    setItem: (name, value) => data.set(name, String(value)),
    data,
  };
}
function withStorage(storage, run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get: () => {
      if (storage instanceof Error) throw storage;
      return storage;
    },
  });
  try {
    return run();
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  }
}

const tools = ["codex", "claude", "shell"].map((id) => ({ id, installed: true }));
const state = {
  accounts: [
    { id: "codex-a", tool: "codex", name: "A" },
    { id: "claude-a", tool: "claude", name: "A" },
    { id: "claude-b", tool: "claude", name: "B" },
    { id: "claude-internal", tool: "claude", name: "Internal", internal: true },
    { id: "shell", tool: "shell", name: "Shell" },
  ],
  providerConnections: [
    { id: "open", tools: ["claude", "codex"], launchable: true },
    { id: "nokey", tools: ["claude"], launchable: false },
  ],
  defaultAccountIds: { claude: "claude-a" },
};

test("a successful launch remembers the CLI and the access per CLI", () => {
  const storage = memoryStorage();
  withStorage(storage, () => {
    rememberLaunchChoice("claude", "claude-b");
    rememberLaunchChoice("codex", "provider:open");
    assert.equal(rememberedLaunchTool(tools), "codex");
    assert.equal(rememberedLaunchAccess(state, "claude"), "claude-b");
    assert.equal(rememberedLaunchAccess(state, "codex"), "provider:open");
  });
  assert.deepEqual(JSON.parse(storage.data.get(key)), {
    tool: "codex",
    access: { claude: "claude-b", codex: "provider:open" },
    picked: {},
  });
});

test("remembering a choice leaves the stored launch modes untouched", () => {
  const modes = JSON.stringify({ claude: "bypass" });
  const storage = memoryStorage({ "agentpier.launch-modes": modes });
  withStorage(storage, () => rememberLaunchChoice("claude", "claude-b"));
  assert.equal(storage.data.get("agentpier.launch-modes"), modes);
});

test("an uninstalled or unknown remembered CLI is ignored", () => {
  const storage = memoryStorage({ [key]: JSON.stringify({ tool: "opencode" }) });
  withStorage(storage, () => {
    assert.equal(rememberedLaunchTool(tools), null);
    assert.equal(
      rememberedLaunchTool([{ id: "opencode", installed: false }, ...tools]),
      null,
    );
  });
});

test("the remembered access wins over the configured default account", () => {
  const storage = memoryStorage({
    [key]: JSON.stringify({ tool: "claude", access: { claude: "claude-b" } }),
  });
  withStorage(storage, () => {
    assert.deepEqual(preferredLaunchAccess(state, "claude"), {
      accessId: "claude-b",
      remembered: true,
      picked: false,
    });
  });
});

test("a stale remembered access falls back to the default account order", () => {
  for (const stale of [
    "deleted",
    "claude-internal",
    "codex-a",
    "provider:nokey",
    "provider:gone",
    "provider:",
    42,
    null,
  ]) {
    const storage = memoryStorage({
      [key]: JSON.stringify({ access: { claude: stale } }),
    });
    withStorage(storage, () => {
      assert.equal(rememberedLaunchAccess(state, "claude"), null, String(stale));
      assert.deepEqual(preferredLaunchAccess(state, "claude"), {
        accessId: "claude-a",
        remembered: false,
        picked: false,
      });
    });
  }
});

test("without memory the default, first account and first launchable connection apply", () => {
  withStorage(memoryStorage(), () => {
    assert.equal(defaultLaunchAccess(state, "claude"), "claude-a");
    assert.equal(
      defaultLaunchAccess({ ...state, defaultAccountIds: {} }, "codex"),
      "codex-a",
    );
    assert.equal(
      defaultLaunchAccess({ ...state, accounts: [] }, "claude"),
      "provider:open",
    );
    assert.equal(defaultLaunchAccess({ accounts: [] }, "claude"), "");
  });
});

test("garbage or prototype keys in storage never select anything", () => {
  for (const raw of [
    "{",
    "[]",
    "null",
    '"claude"',
    JSON.stringify({ tool: ["claude"], access: "claude-b" }),
    JSON.stringify({ tool: "__proto__", access: { __proto__: "claude-b" } }),
    JSON.stringify({ access: { toString: "claude-b" } }),
  ]) {
    withStorage(memoryStorage({ [key]: raw }), () => {
      assert.equal(rememberedLaunchTool(tools), null, raw);
      assert.equal(rememberedLaunchAccess(state, "claude"), null, raw);
      assert.equal(rememberedLaunchAccess(state, "toString"), null, raw);
    });
  }
});

test("garbage in storage is replaced by the next successful launch", () => {
  const storage = memoryStorage({ [key]: "[1,2]" });
  withStorage(storage, () => rememberLaunchChoice("claude", "claude-b"));
  assert.deepEqual(JSON.parse(storage.data.get(key)), {
    tool: "claude",
    access: { claude: "claude-b" },
    picked: {},
  });
});

test("blocked storage neither crashes reading nor writing", () => {
  const blocked = {
    getItem() {
      throw new Error("SecurityError");
    },
    setItem() {
      throw new Error("QuotaExceededError");
    },
  };
  for (const storage of [blocked, new Error("no storage")]) {
    withStorage(storage, () => {
      assert.equal(rememberedLaunchTool(tools), null);
      assert.equal(rememberedLaunchAccess(state, "claude"), null);
      assert.doesNotThrow(() => rememberLaunchChoice("claude", "claude-b"));
      assert.equal(preferredLaunchAccess(state, "claude").accessId, "claude-a");
    });
  }
});

test("an empty tool or access is not remembered", () => {
  const storage = memoryStorage();
  withStorage(storage, () => {
    rememberLaunchChoice("", "claude-b");
    assert.equal(storage.data.has(key), false);
    rememberLaunchChoice("claude", "");
    assert.deepEqual(JSON.parse(storage.data.get(key)), {
      tool: "claude",
      access: {},
      picked: {},
    });
  });
});

// The server lists the host's own CLI login first as "<CLI> · Lokal" (kind "local").
const withLocal = {
  accounts: [
    { id: "local-claude", tool: "claude", name: "Claude Code · Lokal", kind: "local" },
    { id: "local-codex", tool: "codex", name: "Codex · Lokal", kind: "local" },
    { id: "legacy", tool: "claude", name: "Legacy", kind: "managed", provider: "x" },
    { id: "work", tool: "claude", name: "Work", kind: "managed" },
  ],
  providerConnections: [{ id: "open", tools: ["claude", "codex"], launchable: true }],
  defaultAccountIds: {},
};

test("a managed account is preferred over the host's local login", () => {
  withStorage(memoryStorage(), () => {
    assert.equal(defaultLaunchAccess(withLocal, "claude"), "work");
    // Only the local login exists for Codex: it still beats a paid connection.
    assert.equal(defaultLaunchAccess(withLocal, "codex"), "local-codex");
    // A configured default stays in charge, even when it is the local login.
    assert.equal(
      defaultLaunchAccess(
        { ...withLocal, defaultAccountIds: { claude: "local-claude" } },
        "claude",
      ),
      "local-claude",
    );
  });
});

test("a local account remembered from a preselection gives way to a managed one", () => {
  const storage = memoryStorage({
    [key]: JSON.stringify({ tool: "claude", access: { claude: "local-claude" } }),
  });
  withStorage(storage, () => {
    assert.equal(rememberedLaunchAccess(withLocal, "claude"), null);
    assert.deepEqual(preferredLaunchAccess(withLocal, "claude"), {
      accessId: "work",
      remembered: false,
      picked: false,
    });
  });
});

test("a local account the owner picked stays remembered and picked", () => {
  const storage = memoryStorage();
  withStorage(storage, () => {
    rememberLaunchChoice("claude", "local-claude", { picked: true });
    assert.deepEqual(preferredLaunchAccess(withLocal, "claude"), {
      accessId: "local-claude",
      remembered: true,
      picked: true,
    });
    // Launching with a preselection later drops the pick again.
    rememberLaunchChoice("claude", "work");
    assert.deepEqual(JSON.parse(storage.data.get(key)).picked, {});
  });
});

test("the last launch folder is remembered next to the CLI and access", () => {
  const storage = memoryStorage();
  withStorage(storage, () => {
    assert.equal(rememberedLaunchFolder(), null);
    rememberLaunchFolder("/work/project");
    rememberLaunchChoice("claude", "work");
    assert.equal(rememberedLaunchFolder(), "/work/project");
    assert.equal(rememberedLaunchTool(tools), "claude");
    // Relative paths, empty values and garbage are never stored or read.
    rememberLaunchFolder("relative/path");
    rememberLaunchFolder("");
    rememberLaunchFolder(42);
    assert.equal(rememberedLaunchFolder(), "/work/project");
  });
  for (const raw of ['{"cwd":42}', '{"cwd":"relative"}', "[]", "{"]) {
    withStorage(memoryStorage({ [key]: raw }), () =>
      assert.equal(rememberedLaunchFolder(), null, raw),
    );
  }
  withStorage(new Error("blocked"), () => {
    assert.equal(rememberedLaunchFolder(), null);
    assert.doesNotThrow(() => rememberLaunchFolder("/work"));
  });
});

test("a task profile on the local login preselects a managed account", () => {
  const config = (accountId, extra = {}) => ({ cliTool: "claude", accountId, ...extra });
  assert.equal(profileLaunchAccess(withLocal, config("local-claude")), "work");
  assert.equal(profileLaunchAccess(withLocal, config("legacy")), "legacy");
  assert.equal(
    profileLaunchAccess(withLocal, config("work", { providerConnectionId: "open" })),
    "provider:open",
  );
  // No managed account: the profile's own local login stays.
  assert.equal(
    profileLaunchAccess(withLocal, { cliTool: "codex", accountId: "local-codex" }),
    "local-codex",
  );
  // Never a connection, which would still need a model.
  assert.equal(
    profileLaunchAccess(
      { ...withLocal, accounts: [withLocal.accounts[0]] },
      config("local-claude"),
    ),
    "local-claude",
  );
});

test("a provider connection's model is remembered per CLI and connection", () => {
  const storage = memoryStorage();
  withStorage(storage, () => {
    assert.equal(rememberedLaunchModel("claude", "provider:open"), "");
    rememberLaunchChoice("claude", "provider:open", { modelId: "gpt-test" });
    rememberLaunchChoice("codex", "provider:open", { modelId: "gpt-codex" });
    // An account launch keeps the connection's model for next time.
    rememberLaunchChoice("claude", "claude-a", { modelId: "ignored" });
    assert.equal(rememberedLaunchModel("claude", "provider:open"), "gpt-test");
    assert.equal(rememberedLaunchModel("codex", "provider:open"), "gpt-codex");
    assert.equal(rememberedLaunchModel("claude", "claude-a"), "");
    assert.equal(rememberedLaunchModel("claude", "provider:other"), "");
  });
  for (const raw of ['{"models":[]}', '{"models":{"claude provider:open":7}}', "{"])
    withStorage(memoryStorage({ [key]: raw }), () =>
      assert.equal(rememberedLaunchModel("claude", "provider:open"), "", raw),
    );
});
