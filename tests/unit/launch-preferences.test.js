import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultLaunchAccess,
  preferredLaunchAccess,
  rememberLaunchChoice,
  rememberedLaunchAccess,
  rememberedLaunchTool,
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
    assert.deepEqual(JSON.parse(storage.data.get(key)), { tool: "claude", access: {} });
  });
});
