import test from "node:test";
import assert from "node:assert/strict";
import { defaultExtensionTab } from "../../web/features/extensions/routes.js";
import {
  cliServerCount,
  primaryAction,
  resolveWorkspaceTab,
  workspaceTabs,
} from "../../web/features/extensions/workspace-model.js";
import {
  pluginActionKinds,
  pluginKey,
  pluginStatus,
} from "../../web/features/plugins/plugin-state.js";

test("workspace tabs list marketplaces only when supported and subagents only when shared", () => {
  assert.deepEqual(
    workspaceTabs({ shared: false, marketplaces: false }).map((tab) => tab.id),
    ["skills", "plugins"],
  );
  assert.deepEqual(
    workspaceTabs({
      shared: true,
      marketplaces: true,
      counts: { skills: 2, plugins: 0, marketplaces: 1 },
    }),
    [
      { id: "skills", count: 2 },
      { id: "plugins", count: 0 },
      { id: "marketplaces", count: 1 },
      { id: "subagents", count: undefined },
    ],
  );
});

test("unknown or unsupported tabs fall back; marketplaces waits for capabilities", () => {
  const ids = ["skills", "plugins"];
  assert.deepEqual(resolveWorkspaceTab("plugins", ids, true), {
    tab: "plugins",
    pending: false,
  });
  assert.deepEqual(resolveWorkspaceTab("subagents", ids, true), {
    tab: defaultExtensionTab,
    pending: false,
  });
  assert.deepEqual(resolveWorkspaceTab("bogus", ids, false), {
    tab: defaultExtensionTab,
    pending: false,
  });
  assert.deepEqual(resolveWorkspaceTab("marketplaces", ids, null), {
    tab: "marketplaces",
    pending: true,
  });
  assert.deepEqual(resolveWorkspaceTab("marketplaces", ids, false), {
    tab: defaultExtensionTab,
    pending: false,
  });
});

test("each tab has one primary action with today's enablement rules", () => {
  const ready = {
    tool: "claude",
    catalogSupported: true,
    extensionsReady: true,
    pluginsReady: true,
    pluginInstall: true,
  };
  assert.deepEqual(primaryAction({ ...ready, tab: "skills" }), {
    kind: "skill",
    disabled: false,
  });
  assert.deepEqual(primaryAction({ ...ready, tab: "skills", extensionsReady: false }), {
    kind: "skill",
    disabled: true,
  });
  assert.deepEqual(primaryAction({ ...ready, tab: "plugins" }), {
    kind: "discover",
    disabled: false,
  });
  assert.deepEqual(primaryAction({ ...ready, tab: "plugins", catalogSupported: false }), {
    kind: "discover",
    disabled: true,
  });
  const openCode = {
    ...ready,
    tab: "plugins",
    tool: "opencode",
    catalogSupported: false,
  };
  assert.deepEqual(primaryAction(openCode), { kind: "npm", disabled: false });
  assert.deepEqual(primaryAction({ ...openCode, pluginInstall: false }), {
    kind: "npm",
    disabled: true,
  });
  assert.deepEqual(primaryAction({ ...openCode, pluginsReady: false }), {
    kind: "npm",
    disabled: true,
  });
  assert.deepEqual(
    primaryAction({ ...ready, tab: "marketplaces", pluginsReady: false }),
    {
      kind: "market",
      disabled: true,
    },
  );
  assert.deepEqual(primaryAction({ ...ready, tab: "subagents" }), {
    kind: "catalog",
    disabled: false,
  });
});

const usage = (clis) => ({ agents: [], sessions: 0, pipelineProfiles: [], clis });

test("the MCP count is unknown until usage arrives and never invented", () => {
  assert.equal(cliServerCount(null, "codex"), null);
  assert.equal(cliServerCount({}, "codex"), null);
  assert.equal(cliServerCount({ mcpServers: null }, "codex"), null);
  assert.equal(cliServerCount({ mcpServers: [] }, "codex"), null);
  assert.equal(cliServerCount({ mcpServers: {} }, "codex"), 0);
  const servers = {
    github: usage([
      { tool: "claude", route: null },
      { tool: "codex", route: null },
    ]),
    files: usage([{ tool: "claude", route: null }]),
    broken: { agents: [] },
  };
  assert.equal(cliServerCount({ mcpServers: servers }, "codex"), 1);
  assert.equal(cliServerCount({ mcpServers: servers }, "claude"), 2);
  assert.equal(cliServerCount({ mcpServers: servers }, "opencode"), 0);
});

test("plugin status and actions follow the plugin and the CLI's capabilities", () => {
  assert.equal(pluginStatus({ enabled: true }), "enabled");
  assert.equal(pluginStatus({ enabled: false }), "disabled");
  assert.equal(pluginStatus({}), "unknown");
  assert.deepEqual(
    pluginActionKinds({ removable: true }, { enable: true, update: true }),
    ["toggle", "update", "remove"],
  );
  assert.deepEqual(pluginActionKinds({}, {}), ["remove"]);
  assert.deepEqual(pluginActionKinds({}), ["remove"]);
  assert.deepEqual(pluginActionKinds({ removable: false }, { enable: true }), []);
  // One plugin id installed in two scopes stays two distinct entries.
  const user = { id: "demo@m", scope: "user", path: "/u/demo" };
  const project = { id: "demo@m", scope: "project", path: "/p/demo" };
  assert.notEqual(pluginKey(user), pluginKey(project));
  assert.equal(pluginKey(user), pluginKey({ ...user, enabled: false }));
  assert.equal(pluginKey({ id: "x" }), pluginKey({ id: "x" }));
});

test("skills is the extensions default tab", () => {
  assert.equal(defaultExtensionTab, "skills");
});
