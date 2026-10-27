import test from "node:test";
import assert from "node:assert/strict";
import {
  attentionItems,
  systemAttention,
} from "../../web/features/dashboard/attention.js";

const status = (diskLow) => ({
  disk: { freePercent: 4 },
  warning: { diskLow, thresholdPercent: 10 },
});

test("system items come from the menu hint sources, the status and the tools", () => {
  const items = systemAttention({
    serviceError: true,
    status: status(true),
    legacyTmux: [{ id: "old", name: "Old" }],
    hints: {
      agents: { kind: "agentsStopped" },
      connections: { kind: "problems", count: 2 },
      settings: { kind: "appUpdate" },
    },
    tools: [
      { id: "claude", installed: true, versionStatus: "update-required" },
      { id: "codex", installed: true, versionStatus: "ok" },
      { id: "opencode", installed: false, versionStatus: "update-required" },
    ],
    utilities: [{ id: "chromium", installed: true, updateAvailable: true }],
    ready: true,
    appVersion: "2.6.0",
  });
  assert.deepEqual(
    items.map((item) => item.id),
    [
      "service",
      "disk",
      "agents",
      "cli:claude",
      "browser:chromium",
      "connections",
      "app",
      "legacy-tmux",
    ],
  );
  assert.equal(items[1].freePercent, 4);
  assert.equal(items[5].count, 2);
  assert.equal(items[6].version, "2.6.0");
});

test("nothing pending yields no system item; tools wait until the state is ready", () => {
  assert.deepEqual(systemAttention({}), []);
  assert.deepEqual(
    systemAttention({
      status: status(false),
      hints: { agents: { kind: "agentsUpdate" }, settings: null },
      tools: [{ id: "claude", installed: true, versionStatus: "update-required" }],
      ready: false,
    }),
    [],
  );
});

test("inbox items come first in the inbox's order; the total stays unknown until known", () => {
  const inbox = [
    { type: "gate", id: "g1" },
    { type: "approval", id: "a1" },
  ];
  const system = [{ id: "disk", kind: "diskLow" }];
  const { items, total } = attentionItems({ inbox, system });
  assert.deepEqual(
    items.map((item) => item.id),
    ["inbox:gate:g1", "inbox:approval:a1", "disk"],
  );
  assert.equal(total, 3);
  assert.equal(attentionItems({ inbox: null, system: [] }).total, null);
  assert.equal(attentionItems({ inbox: [], system: [] }).total, 0);
  assert.equal(attentionItems({ inbox: null, system }).total, 1);
});
