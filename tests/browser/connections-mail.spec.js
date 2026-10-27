import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { connectionsFixture } from "./connections-fixture.js";

// Connections › Email accounts: the list with its count, the Gmail preset with its
// app-password hint, the connection test, the plaintext consent and a saved account
// that never shows its password.

const accountId = "6c1f5a0e-0000-4000-8000-000000000001";
const password = "abcd efgh ijkl mnop";

const savedAccount = (extra = {}) => ({
  id: accountId,
  name: "Support",
  address: "support@example.com",
  displayName: "Support team",
  preset: "generic",
  imap: { host: "imap.example.com", port: 993, security: "tls", username: "support" },
  smtp: { host: "smtp.example.com", port: 465, security: "tls", username: "support" },
  allowPlaintext: false,
  saveSent: true,
  createdAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:00.000Z",
  lastTest: null,
  hasPassword: true,
  ...extra,
});

async function mailFixture(page, { accounts = [] } = {}) {
  const state = await connectionsFixture(page, { hosts: 2 });
  state.mail = accounts;
  state.mailCalls = [];
  await page.route("**/api/mail/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = request.postData() ? request.postDataJSON() : null;
    state.mailCalls.push({ path, method, body });
    if (path === "/api/mail/test" || path.endsWith("/test"))
      return route.fulfill({
        json: { imap: { ok: true }, smtp: { ok: false, code: "MAIL_AUTH_FAILED" } },
      });
    if (method === "POST") {
      const { password: _password, ...fields } = body;
      const created = savedAccount({ ...fields, id: accountId });
      state.mail = [...state.mail, created];
      return route.fulfill({ status: 201, json: created });
    }
    return route.fulfill({ json: { accounts: state.mail, presets: {} } });
  });
  await page.route("**/api/connections/problems", (route) =>
    route.fulfill({
      json: {
        agentsEnabled: true,
        models: null,
        services: null,
        mcp: null,
        ssh: { total: 2, problems: [], warnings: [], unknown: [] },
        secrets: null,
        github: null,
        mail: { total: state.mail.length, problems: [], warnings: [], unknown: [] },
      },
    }),
  );
  return state;
}

test("Email accounts are a category with their count", async ({ page }) => {
  await mailFixture(page, { accounts: [savedAccount()] });
  await page.goto(baseURL + "/connections?section=ssh");
  const link = page
    .getByRole("navigation", { name: "Categories" })
    .getByRole("link", { name: /^Email accounts/ });
  await expect(link).toContainText("1");
  await link.click();
  await expect(page).toHaveURL(/section=mail$/);
  await expect(page.getByRole("heading", { name: "Email accounts" })).toBeVisible();
  await expect(page.getByText("support@example.com")).toBeVisible();
});

test("an empty category adds a Gmail account with its hint and a connection test", async ({
  page,
}) => {
  const state = await mailFixture(page);
  await page.goto(baseURL + "/connections?section=mail");
  await expect(
    page.getByRole("heading", { name: "No email accounts yet" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add email account" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add email account" });
  await dialog.getByRole("radio", { name: "Gmail" }).check();
  await expect(dialog.getByLabel("IMAP server")).toHaveValue("imap.gmail.com");
  await expect(dialog.getByLabel("SMTP server")).toHaveValue("smtp.gmail.com");
  await expect(dialog).toContainText("Gmail needs an app password");
  await dialog.getByLabel("Name", { exact: true }).fill("Inbox");
  await dialog.getByLabel("Email address").fill("me@gmail.com");
  await dialog.getByLabel("App password").fill(password);
  await dialog.getByRole("button", { name: "Test connection" }).click();
  await expect(dialog).toContainText("IMAP: signed in");
  await expect(dialog).toContainText("Sign-in refused: check username and app password.");
  const tested = state.mailCalls.find((call) => call.path === "/api/mail/test");
  expect(tested.body).toMatchObject({
    preset: "gmail",
    address: "me@gmail.com",
    password,
    imap: { host: "imap.gmail.com", port: 993, security: "tls" },
    smtp: { host: "smtp.gmail.com", port: 465, security: "tls" },
    saveSent: false,
  });
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const created = state.mailCalls.find(
    (call) => call.method === "POST" && call.path === "/api/mail/accounts",
  );
  expect(created.body.password).toBe(password);
  await expect(page.getByText(password)).toHaveCount(0);
});

test("an unencrypted server can be saved only with the owner's consent", async ({
  page,
}) => {
  await mailFixture(page);
  await page.goto(baseURL + "/connections?section=mail");
  await page.getByRole("button", { name: "Add email account" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add email account" });
  await dialog.getByLabel("Name", { exact: true }).fill("Lab");
  await dialog.getByLabel("Email address").fill("lab@example.com");
  await dialog.getByLabel("Password").fill("secret");
  await dialog.getByLabel("IMAP server").fill("mail.lab.example");
  await dialog.getByLabel("SMTP server").fill("mail.lab.example");
  await dialog
    .getByRole("radiogroup", { name: "IMAP security" })
    .getByRole("radio", { name: "None" })
    .check();
  const save = dialog.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeDisabled();
  await expect(dialog).toContainText(
    "Unencrypted: the password and every mail travel readable through the network.",
  );
  await dialog.getByRole("switch", { name: "Allow unencrypted connection" }).check();
  await expect(save).toBeEnabled();
});

test("a saved account shows its servers and used by, never its password", async ({
  page,
}) => {
  await mailFixture(page, {
    accounts: [
      savedAccount({
        lastTest: { at: new Date().toISOString(), imap: "ok", smtp: "ok" },
      }),
    ],
  });
  await page.goto(baseURL + `/connections?section=mail&item=${accountId}`);
  await expect(page.getByRole("heading", { level: 1, name: "Support" })).toBeVisible();
  await expect(page.getByText("imap.example.com:993")).toBeVisible();
  await expect(page.getByRole("region", { name: /^Used by/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /In the activity log/ })).toHaveAttribute(
    "href",
    `/settings/audit?resourceId=${accountId}`,
  );
  await expect(page.locator("input[type=password]")).toHaveCount(0);
  // Editing a server asks for the password again.
  await page.getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit email account" });
  await expect(dialog.getByLabel("Password")).toHaveValue("");
  await dialog.getByLabel("IMAP server").fill("imap.other.example");
  await expect(dialog).toContainText("Enter the password again");
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
});
