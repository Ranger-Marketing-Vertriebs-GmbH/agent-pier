import { emptyAgency } from "./extensions.js";

// Isolated API for the Extensions page: two CLI profiles, one skill, one plugin with
// a custom marketplace, and an /accounts/usage answer that a test can hold back or
// fail (`failUsage`: "error" answers 500, "empty" answers `{}`).
export async function extensionsPageFixture(
  page,
  { shared = false, holdUsage = false, holdPluginWrites = false, failUsage = null } = {},
) {
  const writes = [];
  let releaseUsage = () => {};
  let releaseWrites = () => {};
  const usageReady = holdUsage
    ? new Promise((resolve) => (releaseUsage = resolve))
    : Promise.resolve();
  const writesReady = holdPluginWrites
    ? new Promise((resolve) => (releaseWrites = resolve))
    : Promise.resolve();
  const accounts = [
    { id: "local-codex", name: "Codex Lokal", tool: "codex", kind: "local" },
    { id: "managed-claude", name: "Claude Arbeit", tool: "claude", kind: "managed" },
  ];
  const skills = {
    installPath: "/fixture/.agents/skills",
    note: "Benutzer · von Codex und kompatiblen CLIs geteilt. Angezeigt werden bekannte Benutzer- und Profilordner; projekt- und pluginabhängige Skills sind nicht vollständig erfasst. Entfernen ist nur für hier installierte Skills möglich.",
    scopeKey: "sharedUserSkillScope",
    items: [
      {
        id: "review",
        name: "project-review",
        description: "Prüft Änderungen und dokumentiert Ergebnisse.",
        path: "/fixture/.agents/skills/project-review",
        scope: "Benutzer · von Codex und kompatiblen CLIs geteilt",
        scopeKey: "sharedUserSkillScope",
        removable: true,
      },
    ],
  };
  const plugins = {
    available: true,
    busy: false,
    reason: null,
    note: "Änderungen gelten für neue Sessions.",
    capabilities: { marketplaces: true, enable: true, update: true, install: true },
    installed: [
      {
        id: "superpowers@official",
        name: "superpowers",
        description: "Skills für Coding-Agenten",
        version: "4.1.0",
        enabled: true,
        scope: "user",
        marketplace: "official",
        path: "/fixture/.claude/plugins/superpowers",
        removable: true,
      },
    ],
    marketplaces: [{ name: "official", source: "example/claude-plugins" }],
    catalog: [
      {
        id: "superpowers@official",
        name: "superpowers",
        marketplace: "official",
        installed: true,
      },
    ],
  };
  const usage = {
    agentsEnabled: false,
    connections: {},
    chatgpt: {},
    webSearch: null,
    speech: null,
    cliAccounts: {},
    mcpServers: {
      github: {
        agents: [],
        sessions: 0,
        pipelineProfiles: [],
        clis: [
          { tool: "claude", route: null },
          { tool: "codex", route: null },
        ],
      },
      files: {
        agents: [],
        sessions: 0,
        pipelineProfiles: [],
        clis: [{ tool: "claude", route: null }],
      },
    },
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const codex = url.pathname.includes("codex");
    if (request.method() !== "GET")
      writes.push({
        path: url.pathname,
        method: request.method(),
        body: request.postDataJSON(),
      });
    if (url.pathname === "/api/state")
      return route.fulfill({
        json: {
          accounts,
          sharedCliExtensions: shared,
          tools: accounts.map((a) => ({ id: a.tool, name: a.tool, installed: true })),
          sessions: [],
          home: "/fixture",
        },
      });
    if (url.pathname === "/api/accounts/usage") {
      await usageReady;
      if (failUsage === "error")
        return route.fulfill({ status: 500, json: { error: "usage unavailable" } });
      return route.fulfill({ json: failUsage === "empty" ? {} : usage });
    }
    if (url.pathname.endsWith("/extensions"))
      return route.fulfill({
        json: {
          mcp: {
            path: codex
              ? "/fixture/.codex/config.toml"
              : "/fixture/.claude/settings.json",
            servers: [],
            note: "",
          },
          skills,
        },
      });
    if (url.pathname.endsWith("/plugins")) {
      if (request.method() === "POST") {
        await writesReady;
        const body = request.postDataJSON();
        if (body.action === "disable") plugins.installed[0].enabled = false;
        if (body.action === "enable") plugins.installed[0].enabled = true;
        if (body.action === "remove") plugins.installed = [];
        return route.fulfill({ json: { ok: true } });
      }
      return route.fulfill({ json: { ...plugins, tool: codex ? "codex" : "claude" } });
    }
    if (url.pathname.endsWith("/agency")) return route.fulfill({ json: emptyAgency() });
    return route.fulfill({ json: {} });
  });
  return { writes, releaseUsage, releaseWrites, plugins, usage };
}
