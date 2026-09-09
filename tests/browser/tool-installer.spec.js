import { navigateTo } from "../helpers/navigation.js";
import { test, expect } from "@playwright/test";

import { baseURL as base } from "../helpers/browser.js";
async function fixture(page) {
  const state = {
    tools: [
      { id: "codex", name: "Codex", installed: false },
      { id: "claude", name: "Claude Code", installed: true },
      { id: "opencode", name: "OpenCode", installed: false },
    ],
    accounts: [
      { id: "local-codex", name: "Codex lokal", tool: "codex", kind: "local" },
      { id: "local-claude", name: "Claude lokal", tool: "claude", kind: "local" },
    ],
    sessions: [],
    home: "/home/server",
    remoteUrl: null,
  };
  const jobs = ["codex", "opencode", "claude"].map((tool) => ({
    tool,
    name: tool === "codex" ? "Codex" : "OpenCode",
    packageName: tool === "codex" ? "@openai/codex" : "opencode-ai",
    status: "idle",
    available: true,
    updateAvailable: true,
    updateCommand: `${tool} ${tool === "opencode" ? "upgrade --method curl" : "update"}`,
    migrate: tool === "claude",
    reason: null,
    destination: `/home/server/.local/share/agentpier/clis/${tool}`,
    version: null,
    message: "Bereit zur Installation.",
    startedAt: null,
    finishedAt: null,
  }));
  state.utilities = [{ id: "gh", name: "GitHub CLI", installed: false, utility: true }];
  jobs.push({
    tool: "gh",
    name: "GitHub CLI",
    packageName: "cli/cli",
    installer: "github-release",
    utility: true,
    status: "idle",
    available: true,
    destination: "/home/server/.local/share/agentpier/clis/gh",
  });
  const controls = {
    state,
    jobs,
    starts: [],
    failStart: false,
    holdStart: false,
    releaseStart: null,
    busy: false,
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/state") return route.fulfill({ json: state });
    if (path === "/api/ssh-accesses") return route.fulfill({ json: { accesses: [] } });
    if (path === "/api/repositories")
      return route.fulfill({ json: { credentials: [], projects: [] } });
    if (path === "/api/tool-installations")
      return route.fulfill({
        json: {
          installations: structuredClone(jobs),
          busy: controls.busy || jobs.some((job) => job.status === "running"),
        },
      });
    if (/^\/api\/tools\/[^/]+\/(install|update)$/.test(path)) {
      const tool = path.split("/")[3];
      controls.starts.push({ tool, body: route.request().postDataJSON() });
      if (controls.holdStart)
        await new Promise((resolve) => {
          controls.releaseStart = resolve;
        });
      if (controls.failStart)
        return route.fulfill({
          status: 409,
          json: { error: "Der Paketdienst ist gerade nicht erreichbar." },
        });
      const job = jobs.find((item) => item.tool === tool);
      Object.assign(job, {
        operation: path.endsWith("/update") ? "update" : "install",
        status: "running",
        message: "Paket wird installiert …",
        startedAt: "2026-09-06T12:00:00Z",
      });
      return route.fulfill({ status: 202, json: job });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto(base);
  return controls;
}
const card = (page, name) =>
  page
    .locator(".tool-card")
    .filter({ has: page.getByRole("heading", { name, exact: true }) });

test("installed CLI previews native migration and updates without launching a session", async ({
  page,
}) => {
  const controls = await fixture(page);
  await card(page, "Claude Code")
    .getByRole("button", { name: "CLI aktualisieren", exact: true })
    .click();
  const modal = page.getByRole("dialog", {
    name: "Claude Code aktualisieren",
    exact: true,
  });
  await expect(modal).toContainText("claude update");
  await expect(modal).toContainText("npm");
  await modal.screenshot({ path: "docs/screenshots/cli-update.png" });
  expect(controls.starts).toEqual([]);
  await modal
    .getByRole("button", { name: "Umstellen & aktualisieren", exact: true })
    .click();
  expect(controls.jobs.find((job) => job.tool === "claude").operation).toBe("update");
  await modal.getByRole("button", { name: "Dialog schließen", exact: true }).click();
  await card(page, "Claude Code")
    .getByRole("button", { name: "CLI aktualisieren", exact: true })
    .click();
  const job = controls.jobs.find((item) => item.tool === "claude");
  Object.assign(job, {
    status: "succeeded",
    version: "2.3.4",
    finishedAt: "2026-09-09",
    migrate: false,
  });
  await expect(modal).toContainText("2.3.4");
  await expect(
    modal.getByRole("button", { name: "Jetzt aktualisieren", exact: true }),
  ).toBeEnabled();
  expect(controls.state.sessions).toEqual([]);
});

test("rejected update does not reuse an earlier successful installation as update success", async ({
  page,
}) => {
  const controls = await fixture(page);
  Object.assign(
    controls.jobs.find((job) => job.tool === "claude"),
    { status: "succeeded", version: "1.0.0", migrate: false },
  );
  controls.failStart = true;
  await card(page, "Claude Code")
    .getByRole("button", { name: "CLI aktualisieren", exact: true })
    .click();
  const modal = page.getByRole("dialog", {
    name: "Claude Code aktualisieren",
    exact: true,
  });
  await modal.getByRole("button", { name: "Jetzt aktualisieren", exact: true }).click();
  await expect(modal).toContainText("Der Paketdienst ist gerade nicht erreichbar.");
  await expect(
    modal.getByRole("button", { name: "Jetzt aktualisieren", exact: true }),
  ).toBeEnabled();
  await expect(modal.locator("strong")).not.toContainText("CLI aktualisiert");
});

test("missing CLI installation is previewed before any package installation starts", async ({
  page,
}) => {
  const controls = await fixture(page);
  await card(page, "Codex")
    .getByRole("button", { name: "CLI installieren", exact: true })
    .click();
  const modal = page.getByRole("dialog", { name: "Codex installieren", exact: true });
  await expect(modal).toContainText("@openai/codex");
  await expect(modal).toContainText("/home/server/.local/share/agentpier/clis/codex");
  await expect(modal).toContainText("Server");
  expect(controls.starts).toEqual([]);
  await modal.getByRole("button", { name: "Dialog schließen", exact: true }).click();
  await card(page, "Claude Code")
    .getByRole("button", { name: "Sitzung starten", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Neue Sitzung", exact: true }),
  ).toBeVisible();
  expect(controls.starts).toEqual([]);
});

test("GitHub CLI installs as a utility and opens GitHub credentials without a session or account", async ({
  page,
}) => {
  const controls = await fixture(page);
  await card(page, "GitHub CLI")
    .getByRole("button", { name: "CLI installieren", exact: true })
    .click();
  const modal = page.getByRole("dialog", {
    name: "GitHub CLI installieren",
    exact: true,
  });
  await expect(modal).toContainText("Offizielles GitHub-Release");
  await expect(modal).toContainText("cli/cli");
  await expect(modal).not.toContainText("npm-Paket");
  await modal.screenshot({ path: "/tmp/agentpier-gh-installer-desktop.png" });
  expect(controls.starts).toEqual([]);
  await modal.getByRole("button", { name: "Jetzt installieren", exact: true }).click();
  await expect(modal.getByRole("status")).toContainText("Paket wird installiert");
  Object.assign(
    controls.jobs.find((job) => job.tool === "gh"),
    {
      status: "succeeded",
      version: "gh version 2.80.0",
      finishedAt: "2026-09-06T12:02:00Z",
    },
  );
  controls.state.utilities[0].installed = true;
  await expect(
    modal.getByRole("button", { name: "Sitzung starten", exact: true }),
  ).toHaveCount(0);
  await modal.getByRole("button", { name: "GitHub-Zugänge", exact: true }).click();
  await expect(page).toHaveURL(/\/repositories$/);
  await expect(page.getByRole("heading", { name: "Deine Repositories" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(controls.state.sessions).toEqual([]);
  await page.getByRole("button", { name: "Übersicht", exact: true }).click();
  await card(page, "GitHub CLI")
    .getByRole("button", { name: "GitHub-Zugänge", exact: true })
    .click();
  await expect(page).toHaveURL(/\/repositories$/);
  await navigateTo(page, "Konten");
  await page.getByRole("button", { name: "Konto hinzufügen", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Tool", exact: true })).toBeVisible();
  await expect(
    page
      .getByRole("combobox", { name: "Tool", exact: true })
      .locator('option[value="gh"]'),
  ).toHaveCount(0);
  expect(controls.starts).toEqual([{ tool: "gh", body: {} }]);
});

test("an installed utility does not enable session creation when no session tool is available", async ({
  page,
}) => {
  const controls = await fixture(page);
  for (const tool of controls.state.tools) tool.installed = false;
  controls.state.utilities[0].installed = true;
  await page.reload();
  await expect(
    card(page, "GitHub CLI").getByRole("button", { name: "GitHub-Zugänge", exact: true }),
  ).toBeEnabled();
  await expect(
    page.locator(".sidebar").getByRole("button", { name: "Neue Sitzung", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("Tools verfügbar", { exact: true }).locator(".."),
  ).toContainText(/1\s*\/\s*4/);
});

test("installation failures can retry and pending requests cannot start duplicates", async ({
  page,
}) => {
  const controls = await fixture(page);
  controls.failStart = true;
  await card(page, "Codex")
    .getByRole("button", { name: "CLI installieren", exact: true })
    .click();
  await page.getByRole("button", { name: "Jetzt installieren", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Paketdienst");
  controls.failStart = false;
  controls.holdStart = true;
  const retry = page.getByRole("button", { name: "Jetzt installieren", exact: true });
  await retry.click();
  const pending = page.getByRole("button", {
    name: "Installation startet …",
    exact: true,
  });
  await expect(pending).toBeDisabled();
  await pending.dispatchEvent("click");
  expect(controls.starts).toHaveLength(2);
  await expect.poll(() => Boolean(controls.releaseStart)).toBe(true);
  controls.releaseStart();
  await expect(page.getByRole("status")).toContainText("Paket wird installiert");
  Object.assign(controls.jobs[0], {
    status: "failed",
    message: "Installation fehlgeschlagen: Netzwerk unterbrochen.",
    finishedAt: "2026-09-06T12:01:00Z",
  });
  await expect(
    page.getByRole("button", { name: "Erneut installieren", exact: true }),
  ).toBeEnabled();
});

test("closing and reopening an installation restores its job and success enables session launch", async ({
  page,
}) => {
  const controls = await fixture(page);
  await card(page, "Codex")
    .getByRole("button", { name: "CLI installieren", exact: true })
    .click();
  await page.getByRole("button", { name: "Jetzt installieren", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Paket wird installiert");
  await page.getByRole("button", { name: "Dialog schließen", exact: true }).click();
  await card(page, "Codex")
    .getByRole("button", { name: "CLI installieren", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Paket wird installiert");
  expect(controls.starts).toHaveLength(1);
  Object.assign(controls.jobs[0], {
    status: "succeeded",
    version: "codex-cli 0.153.4",
    message: "Codex ist einsatzbereit.",
    finishedAt: "2026-09-06T12:02:00Z",
  });
  controls.state.tools[0].installed = true;
  await page
    .getByRole("dialog", { name: "Codex installieren", exact: true })
    .getByRole("button", { name: "Sitzung starten", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Neue Sitzung", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Zugang", { exact: true })).toHaveValue("local-codex");
  expect(controls.starts).toHaveLength(1);
});

test("mobile unavailable install explains the reason and keeps its destination readable", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  try {
    const page = await context.newPage();
    const controls = await fixture(page);
    Object.assign(controls.jobs[1], {
      available: false,
      reason: "Auf diesem Server fehlt npm.",
      destination: "/home/server/" + "sehr-langes-verzeichnis/".repeat(7) + "opencode",
    });
    await card(page, "OpenCode")
      .getByRole("button", { name: "CLI installieren", exact: true })
      .tap();
    const modal = page.getByRole("dialog", {
      name: "OpenCode installieren",
      exact: true,
    });
    await expect(modal).toContainText("Auf diesem Server fehlt npm.");
    await expect(
      modal.getByRole("button", { name: "Jetzt installieren", exact: true }),
    ).toBeDisabled();
    expect(await modal.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    expect(controls.starts).toEqual([]);
  } finally {
    await context.close();
  }
});
