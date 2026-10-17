import { fulfillDormantAssistantRequest } from "../helpers/assistant-browser-fixture.js";
import { openNewSession } from "../helpers/navigation.js";
import { test, expect } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";

test.use({ locale: "en-GB" });

async function fixture(page, configure = () => {}) {
  const tools = [
    {
      id: "codex",
      name: "Codex",
      installed: true,
      path: "/bin/codex",
      version: null,
      minimumVersion: "0.153.4",
      versionStatus: "unknown",
    },
    {
      id: "claude",
      name: "Claude Code",
      installed: true,
      path: "/bin/claude",
      version: "2.1.100",
      minimumVersion: "2.1.263",
      versionStatus: "update-required",
      managedInstall: true,
    },
    {
      id: "opencode",
      name: "OpenCode",
      installed: true,
      path: "/bin/opencode",
      version: "1.18.35",
      minimumVersion: "1.18.29",
      versionStatus: "ok",
    },
  ];
  configure(tools);
  const state = {
    tools,
    utilities: [],
    accounts: tools.map(({ id, name }) => ({
      id: `local-${id}`,
      tool: id,
      name,
      kind: "local",
      hasSecret: false,
      createdAt: null,
    })),
    sessions: [],
    home: "/home/test",
    remoteUrl: null,
  };
  const job = {
    tool: "claude",
    name: "Claude Code",
    status: "idle",
    available: true,
    updateAvailable: true,
    updateCommand: "claude update",
    migrate: false,
    version: null,
    message: "",
    installedVersion: "2.1.100",
    minimumVersion: "2.1.263",
    versionStatus: "update-required",
  };
  const calls = { launches: [], updates: 0 };
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.route("**/api/**", async (route) => {
    if (await fulfillDormantAssistantRequest(route)) return;
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/state") return route.fulfill({ json: state });
    if (path === "/api/sessions" && request.method() === "POST") {
      calls.launches.push(request.postDataJSON());
      return route.fulfill({
        status: 409,
        json: {
          code: "CLI_UPDATE_REQUIRED",
          updateRequired: { tool: "claude", found: "2.1.100", required: "2.1.263" },
          error:
            "Claude Code ist in Version 2.1.100 installiert, AgentPier benötigt aber 2.1.263 oder neuer. Bitte das CLI aktualisieren und die Sitzung erneut starten.",
          messageKey: "tools.cliUpdateRequired",
          messageArgs: ["Claude Code", "2.1.100", "2.1.263"],
        },
      });
    }
    if (path === "/api/tool-installations")
      return route.fulfill({
        json: { installations: [structuredClone(job)], busy: job.status === "running" },
      });
    if (path === "/api/tools/claude/update" && request.method() === "POST") {
      calls.updates++;
      Object.assign(job, {
        operation: "update",
        status: "succeeded",
        version: "2.1.296 (Claude Code)",
        installedVersion: "2.1.296",
        versionStatus: "ok",
        finishedAt: "2026-10-17T12:00:00Z",
      });
      Object.assign(tools[1], { version: "2.1.296", versionStatus: "ok" });
      return route.fulfill({ status: 202, json: job });
    }
    if (path === "/api/ssh-accesses") return route.fulfill({ json: { accesses: [] } });
    return route.fulfill({ json: {} });
  });
  await page.goto(base);
  return calls;
}
const card = (page, name) =>
  page
    .locator(".tool-card")
    .filter({ has: page.getByRole("heading", { name, exact: true }) });

test("dashboard shows each CLI's version and which one is below its minimum", async ({
  page,
}) => {
  await fixture(page);
  const claude = card(page, "Claude Code");
  await expect(claude.locator(".tool-state")).toHaveText("Update required");
  await expect(claude.locator(".tool-version")).toHaveText(
    "Version 2.1.100 · Requires 2.1.263 or later",
  );
  await expect(card(page, "OpenCode").locator(".tool-version")).toHaveText(
    "Version 1.18.35",
  );
  await expect(card(page, "OpenCode").locator(".tool-state")).toHaveText("Ready");
  await expect(card(page, "Codex").locator(".tool-version")).toHaveText(
    "Version unknown",
  );
});

test("an outdated CLI's launch is refused and the dialog offers its update", async ({
  page,
}) => {
  const calls = await fixture(page);
  await openNewSession(page);
  const dialog = page.getByRole("dialog");
  // An unreadable version only warns.
  await page.getByLabel("CLI", { exact: true }).selectOption("codex");
  await expect(dialog.locator(".cli-version-notice")).toContainText(
    "could not read the Codex version",
  );
  await expect(dialog.getByRole("button", { name: "Update Codex" })).toHaveCount(0);
  await page.getByLabel("CLI", { exact: true }).selectOption("claude");
  const notice = dialog.locator(".cli-version-notice.update-required");
  await expect(notice).toContainText(
    "Claude Code 2.1.100 is older than the minimum version 2.1.263",
  );
  await dialog.getByRole("button", { name: "Start session", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Claude Code version 2.1.100 is installed, but AgentPier needs 2.1.263 or later. Update the CLI, then start the session again.",
  );
  expect(calls.launches).toHaveLength(1);
  await notice.getByRole("button", { name: "Update Claude Code", exact: true }).click();
  const update = page.getByRole("dialog", { name: "Update Claude Code", exact: true });
  await expect(update).toContainText("claude update");
  await expect(update).toContainText("Installed: 2.1.100 · Requires 2.1.263 or later");
  await update.getByRole("button", { name: "Update now", exact: true }).click();
  await expect(update.getByRole("status").first()).toContainText("CLI updated");
  expect(calls.updates).toBe(1);
  await expect(update).toContainText("Installed: 2.1.296");
});

test("an outdated CLI that AgentPier did not install only warns and points to its package manager", async ({
  page,
}) => {
  await fixture(page, (tools) =>
    Object.assign(tools[2], {
      version: "1.0.0",
      versionStatus: "update-required",
      managedInstall: false,
    }),
  );
  await expect(card(page, "OpenCode").locator(".tool-state")).toHaveText(
    "Update required",
  );
  await openNewSession(page);
  const dialog = page.getByRole("dialog");
  await page.getByLabel("CLI", { exact: true }).selectOption("opencode");
  await expect(dialog.locator(".cli-version-notice")).toContainText(
    "update it with the package manager that installed it",
  );
  await expect(dialog.getByRole("button", { name: "Update OpenCode" })).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Start session", exact: true }),
  ).toBeEnabled();
});
