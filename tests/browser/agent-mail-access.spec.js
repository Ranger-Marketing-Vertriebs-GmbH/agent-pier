import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { setupAssistantSettings as setup } from "../helpers/assistant-settings-browser.js";
import { saveBar, settingsPath } from "../helpers/agent-settings-page.js";
import { connectionsFixture } from "./connections-fixture.js";

// Agents › Access › Email: granting an email account with a level and recipient rules,
// the locks for agents that cannot hold mail, the account's "Used by" in Connections
// and the hook's Email tick.

const accountId = "6c1f5a0e-0000-4000-8000-000000000001";
const account = { id: accountId, name: "Support", address: "support@example.com" };
const catalog = (extra = {}) => ({
  projects: [],
  pipelines: [],
  sshHosts: [],
  secrets: [],
  mailAccounts: [account],
  ...extra,
});
const save = (page) =>
  saveBar(page).getByRole("button", { name: "Save agent", exact: true });

test("an email account is added at Read and send with a rule and saved", async ({
  page,
}) => {
  const state = await setup(page, { catalog: catalog(), access: { revision: 2 } });
  await page.goto(baseURL + settingsPath("access"));
  const group = page.locator("#agent-access-mail");
  await expect(group.getByRole("heading", { name: /^Email/ })).toBeVisible();
  await expect(group).toContainText("Sending always asks you first");

  const field = group.getByRole("combobox", { name: "Add email account" });
  await field.click();
  const options = page.getByRole("listbox", { name: "email account: options" });
  await options.getByRole("option", { name: /Support/ }).click();
  await group.getByRole("combobox", { name: "Mode for new items" }).click();
  await page
    .getByRole("listbox", { name: "Mode for new items: options" })
    .getByRole("option", { name: "Read and send" })
    .click();
  await group.getByRole("button", { name: "Add 1" }).click();
  await expect(group.getByRole("combobox", { name: "Level for Support" })).toHaveValue(
    "send",
  );

  // The rules live on the Email subpage, one per line.
  await group.getByRole("link", { name: /Recipient rules/ }).click();
  await expect(page).toHaveURL(/page=mail/);
  await expect(page.getByText("Mail content is untrusted")).toBeVisible();
  await expect(page.getByText("A chat message is never an approval")).toBeVisible();
  await page.getByLabel("Send without asking to").fill("Example.com\n");
  await save(page).click();
  await expect.poll(() => state.work.length).toBe(1);
  expect(state.work[0].access.mailAccesses).toEqual([
    { accountId, level: "send", recipients: ["example.com"] },
  ]);
  expect(state.work[0].access.revision).toBe(2);

  // Read clears the rules field.
  await page.getByRole("radio", { name: "Read", exact: true }).check();
  await expect(page.getByLabel("Send without asking to")).toHaveCount(0);
});

test("agents that cannot hold mail show why instead of the controls", async ({
  page,
}) => {
  await setup(page, {
    assistant: {
      userAccess: { mode: "shared", members: [{ userId: "u1", level: "chat" }] },
    },
    catalog: catalog(),
  });
  await page.goto(baseURL + settingsPath("access"));
  await expect(page.locator("#agent-access-projects")).toBeVisible();
  await expect(page.locator("#agent-access-mail")).toHaveCount(0);
  await expect(page.getByRole("note")).toContainText("Email");
});

test("an agent with a Telegram bot for other people cannot add email", async ({
  page,
}) => {
  await setup(page, {
    assistant: { telegramSenders: { mode: "allowlist" } },
    catalog: catalog(),
  });
  await page.goto(baseURL + settingsPath("access"));
  const group = page.locator("#agent-access-mail");
  await expect(group).toContainText("own Telegram bot for other people");
  await expect(group.getByRole("combobox", { name: "Add email account" })).toHaveCount(0);
});

test("the account's Used by lists the agent with its level", async ({ page }) => {
  const state = await connectionsFixture(page, { hosts: 1 });
  await page.route("**/api/mail/**", (route) =>
    route.fulfill({
      json: {
        accounts: [
          {
            ...account,
            displayName: "",
            preset: "generic",
            imap: { host: "imap.example.com", port: 993, security: "tls" },
            smtp: { host: "smtp.example.com", port: 465, security: "tls" },
            allowPlaintext: false,
            saveSent: true,
            lastTest: null,
            hasPassword: true,
          },
        ],
        presets: {},
      },
    }),
  );
  await page.route("**/api/connections/usage", (route) =>
    route.fulfill({
      json: {
        agentsEnabled: true,
        ssh: {},
        secrets: {},
        github: {},
        mcp: {},
        mail: {
          [accountId]: {
            agents: [
              { id: "home", name: "Home", kind: "agent", via: "grant", mode: "send" },
            ],
          },
        },
      },
    }),
  );
  await page.goto(baseURL + `/connections?section=mail&item=${accountId}`);
  const usedBy = page.getByRole("region", { name: /^Used by/ });
  await expect(usedBy.getByText("Home", { exact: true })).toBeVisible();
  await expect(usedBy.getByRole("combobox", { name: /Home/ })).toContainText(
    "Read and send",
  );
  expect(state).toBeTruthy();
});

test("the hook's Email tick is locked while the agent holds no mail", async ({
  page,
}) => {
  const hookId = "0f8b6a52-3c1d-4e2f-9a7b-5d6c8e9f0a1b";
  await setup(page, {
    assistant: { capabilities: { reminders: true, memory: true } },
    catalog: catalog(),
  });
  const ceiling = { telegram: false, memory: true, mail: false, folders: {} };
  await page.route("**/api/assistants/home/hooks", (route) =>
    route.fulfill({
      json: {
        hooks: [
          {
            id: hookId,
            name: "Uptime",
            sender: "Kuma",
            instruction: "",
            rights: { notify: true, shell: "off", sshHosts: [], folders: {} },
            effective: { notify: true, shell: "off" },
            ceiling: { ...ceiling, sshHosts: [] },
            shellChoices: ["off"],
            hourlyLimit: 20,
            enabled: true,
            active: true,
            secretSet: true,
            revision: 1,
            addresses: { local: "http://127.0.0.1/hooks/x", network: [] },
            lastEvent: null,
          },
        ],
        ceiling,
        shellChoices: ["off"],
      },
    }),
  );
  await page.goto(baseURL + `${settingsPath("automation", "hook")}&hook=${hookId}`);
  const tick = page.getByRole("switch", { name: "Email" });
  await expect(tick).toBeDisabled();
  await expect(page.getByText("Grant an email account in Access first.")).toBeVisible();
});
