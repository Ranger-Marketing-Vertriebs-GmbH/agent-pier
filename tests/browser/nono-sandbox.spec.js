import { test, expect } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";

// These tests assert the presentation of a sandbox profile picker, not a
// successful sandboxed launch. GET /api/sandbox-profiles is mocked in every one
// of them: the disposable server answers it from whatever nono the host happens
// to have, so an unmocked test asserts one thing on a developer machine with
// nono installed and another on a machine without it.

async function unavailableSandbox(page) {
  await page.route("**/api/sandbox-profiles", (route) =>
    route.fulfill({ json: { available: false, profiles: [] } }),
  );
}

async function launchFixture(page) {
  await unavailableSandbox(page);
  await page.route("**/api/state", (route) =>
    route.fulfill({
      json: {
        tools: [{ id: "codex", installed: true, name: "Codex" }],
        accounts: [{ id: "local-codex", tool: "codex", name: "Codex", kind: "local" }],
        sessions: [],
        home: "/home/test",
        remoteUrl: null,
      },
    }),
  );
  await page.goto(base);
  await page.getByRole("button", { name: "Neue Sitzung", exact: true }).click();
}

test("the launch dialog shows a disabled sandbox-profile selector defaulting to no sandbox", async ({
  page,
}) => {
  await launchFixture(page);
  const dialog = page.getByRole("dialog");
  // The dialog holds more than one fieldset (the SSH access catalog has its
  // own), so the sandbox group is addressed by its accessible name.
  await expect(dialog.getByRole("group", { name: "Sandbox" })).toBeVisible();
  const select = dialog.getByLabel("Sandbox-Profil", { exact: true });
  await expect(select).toBeVisible();
  await expect(select).toBeDisabled();
  await expect(select).toHaveValue("");
  await expect(select.locator('option[value=""]')).toHaveText("Keine Sandbox");
  await expect(
    dialog.getByText("nono ist auf diesem Rechner nicht installiert.", {
      exact: true,
    }),
  ).toBeVisible();
});

test("the sandbox-profile selector is absent for a login launch", async ({ page }) => {
  await unavailableSandbox(page);
  await page.route("**/api/state", (route) =>
    route.fulfill({
      json: {
        tools: [{ id: "codex", installed: true, name: "Codex" }],
        accounts: [
          {
            id: "managed-codex",
            tool: "codex",
            name: "Managed Codex",
            kind: "managed",
            hasSecret: false,
          },
        ],
        sessions: [],
        home: "/home/test",
        remoteUrl: null,
      },
    }),
  );
  await page.route("**/api/accounts/*/auth-status", (route) =>
    route.fulfill({ json: { state: "unauthenticated", checkedAt: Date.now() } }),
  );
  await page.goto(base + "/accounts");
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Codex anmelden" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Sandbox-Profil")).toHaveCount(0);
  await expect(dialog.getByRole("group", { name: "Sandbox" })).toHaveCount(0);
});

test("the sandbox-profile selector is reachable for a shell launch", async ({ page }) => {
  await unavailableSandbox(page);
  await page.route("**/api/state", (route) =>
    route.fulfill({
      json: {
        tools: [{ id: "shell", installed: true, name: "Shell" }],
        accounts: [{ id: "local-shell", tool: "shell", name: "Shell", kind: "local" }],
        sessions: [],
        home: "/home/test",
        remoteUrl: null,
      },
    }),
  );
  await page.goto(base);
  await page.getByRole("button", { name: "Neue Sitzung", exact: true }).click();
  const dialog = page.getByRole("dialog");
  // Keep the tool selector available while hiding coding-only access fields.
  await expect(dialog.getByLabel("CLI", { exact: true })).toHaveValue("shell");
  await expect(dialog.getByLabel("Zugang", { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("Sandbox-Profil", { exact: true })).toBeVisible();
});

test("selecting a task profile disables the sandbox-profile selector with an explanation", async ({
  page,
}) => {
  await page.route("**/api/state", (route) =>
    route.fulfill({
      json: {
        tools: [{ id: "codex", installed: true, name: "Codex" }],
        accounts: [{ id: "local-codex", tool: "codex", name: "Codex", kind: "local" }],
        sessions: [],
        home: "/home/test",
        remoteUrl: null,
      },
    }),
  );
  // Mocked available/enabled here (unlike the other tests) specifically so the
  // task-profile explanation can be observed instead of always being masked by
  // the real "nono not installed" one.
  await page.route("**/api/sandbox-profiles", (route) =>
    route.fulfill({ json: { available: true, profiles: ["default"] } }),
  );
  await page.route("**/api/pipeline-profiles", (route) =>
    route.fulfill({
      json: {
        profiles: [
          {
            id: "profile-one",
            name: "Planer",
            enabled: true,
            config: {
              accountId: "local-codex",
              cliTool: "codex",
              models: { available: [""], default: "" },
              prompts: { params: [] },
              permissions: { mode: "never" },
            },
          },
        ],
      },
    }),
  );
  await page.goto(base);
  await page.getByRole("button", { name: "Neue Sitzung", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const select = dialog.getByLabel("Sandbox-Profil", { exact: true });
  await expect(select).toBeEnabled();
  // Choosing a sandbox profile before the task profile must not survive the
  // switch: the picker disables and the choice itself is discarded, not just
  // hidden, so a later request never carries a sandbox profile the operator
  // can no longer see or change.
  await select.selectOption("default");
  await expect(select).toHaveValue("default");
  await dialog.getByLabel("Aufgabenprofil", { exact: true }).selectOption("profile-one");
  await expect(select).toBeDisabled();
  await expect(select).toHaveValue("");
  await expect(
    dialog.getByText(
      "Das Sandbox-Profil ist bei Starts mit Aufgabenprofil nicht verfügbar.",
      { exact: true },
    ),
  ).toBeVisible();
  await dialog.getByLabel("Aufgabenprofil", { exact: true }).selectOption("");
  await expect(select).toBeEnabled();
  await expect(select).toHaveValue("");
});

test("the sidebar shows the sandbox-profile badge only for a sandboxed session", async ({
  page,
}) => {
  // The real disposable server never produces a sandboxed session (no nono
  // binary), so /api/state is mocked here to seed one directly, the same
  // justification as the task-profile test above.
  await page.route("**/api/state", (route) =>
    route.fulfill({
      json: {
        tools: [{ id: "codex", installed: true, name: "Codex" }],
        accounts: [{ id: "local-codex", tool: "codex", name: "Codex", kind: "local" }],
        sessions: [
          {
            id: "sandboxed",
            name: "Sandboxed Session",
            tool: "codex",
            accountId: "local-codex",
            cwd: "/work/sandboxed",
            status: "running",
            sandbox: { profile: "default" },
          },
          {
            // No `sandbox` key at all: the public record omits it entirely for
            // an unsandboxed session, it is never set to null.
            id: "plain",
            name: "Plain Session",
            tool: "codex",
            accountId: "local-codex",
            cwd: "/work/plain",
            status: "running",
          },
        ],
        home: "/work",
        remoteUrl: null,
      },
    }),
  );
  await page.goto(base);
  const row = (name) =>
    page.locator(".session-item").filter({ has: page.getByText(name, { exact: true }) });
  await expect(row("Sandboxed Session")).toContainText("Sandbox · default");
  await expect(row("Plain Session")).not.toContainText("Sandbox");
});
