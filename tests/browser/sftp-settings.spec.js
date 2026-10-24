import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { setupAssistantSettings as setup } from "../helpers/assistant-settings-browser.js";
import { settingsPath } from "../helpers/agent-settings-page.js";
import { catalog, opnsense } from "./assistant-ssh-fixture.js";
import { fixture } from "./ssh-fixture.js";
import { openAccess, showAccesses } from "./ssh-settings-helpers.js";

const sftpHost = (state, extra = {}) => ({
  ...state.access,
  id: "sftp-one",
  name: "Files box",
  host: "files.example.test",
  username: "uploader",
  type: "sftp",
  auth: "password",
  keyId: null,
  keyName: null,
  publicKey: null,
  remoteRoot: "/srv/files",
  hasPassword: true,
  ...extra,
});

async function english(page) {
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
}

async function fillHost(page) {
  await page.getByLabel("Name", { exact: true }).fill("Files box");
  await page.getByLabel("Host", { exact: true }).fill("files.example.test");
  await page.getByLabel("Username", { exact: true }).fill("uploader");
}

test("adds a password SFTP host", async ({ page }) => {
  const state = await fixture(page);
  await english(page);
  await page.goto(baseURL + "/settings/ssh");
  await page.getByRole("button", { name: "Add access", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: "SFTP", exact: true }).check();
  await expect(dialog.getByRole("radiogroup", { name: "Sign-in" })).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "SSH key" })).toHaveCount(0);
  await fillHost(page);
  await dialog.locator("input[type=password]").fill("fixture-secret");
  await dialog.getByLabel("Allowed remote folder").fill("/srv/files");
  await dialog.getByRole("button", { name: "Fetch host key" }).click();
  const save = dialog.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeDisabled();
  await page.screenshot({ path: ".cache/sftp-settings-form-en.png" });
  await dialog.getByRole("checkbox").check();
  await expect(save).toBeEnabled();
  await save.click();
  const post = state.calls.find(
    (call) => call.method === "POST" && call.path === "/api/ssh-accesses",
  );
  expect(post.body).toMatchObject({
    type: "sftp",
    auth: "password",
    password: "fixture-secret",
    remoteRoot: "/srv/files",
    username: "uploader",
    hostKey: state.access.hostKey,
  });
  expect(post.body.keyId).toBeUndefined();
  const row = page.getByRole("button", { name: "Files box", exact: true });
  await expect(row).toContainText("SFTP");
  await expect(row).toContainText("/srv/files");
  await row.click();
  await page.screenshot({ path: ".cache/sftp-settings-list-en.png" });
});

test("SSH hosts keep the plain SSH request", async ({ page }) => {
  const state = await fixture(page);
  await english(page);
  await page.goto(baseURL + "/settings/ssh");
  await page.getByRole("button", { name: "Add access", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await fillHost(page);
  await dialog.getByRole("button", { name: "Fetch host key" }).click();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  const post = state.calls.find(
    (call) => call.method === "POST" && call.path === "/api/ssh-accesses",
  );
  expect(Object.keys(post.body).sort()).toEqual(
    ["hostKey", "host", "keyId", "name", "port", "projectId", "username"].sort(),
  );
});

test("edit form never shows the saved password", async ({ page }) => {
  const state = await fixture(page);
  state.accesses = [sftpHost(state)];
  await english(page);
  await page.goto(baseURL + "/settings/ssh");
  await openAccess(page, "Files box");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("radio", { name: "SSH", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("radio", { name: "SFTP", exact: true })).toBeChecked();
  const password = dialog.locator("input[type=password]");
  await expect(password).toHaveValue("");
  await expect(password).toHaveAttribute("type", "password");
  await expect(password).not.toHaveAttribute("required", "");
  await expect(
    dialog.getByText("Saved. Enter a new password to replace it."),
  ).toBeVisible();
  await dialog.getByLabel("Allowed remote folder").fill("");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  const patch = state.calls.find((call) => call.method === "PATCH");
  expect(patch.body).toMatchObject({ auth: "password", remoteRoot: "" });
  expect(patch.body).not.toHaveProperty("password");
  expect(patch.body).not.toHaveProperty("type");
});

test("key sign-in offers saved keys", async ({ page }) => {
  const state = await fixture(page);
  await english(page);
  await page.goto(baseURL + "/settings/ssh");
  await page.getByRole("button", { name: "Add access", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: "SFTP", exact: true }).check();
  await dialog.getByRole("radio", { name: "Key", exact: true }).check();
  await expect(dialog.locator("input[type=password]")).toHaveCount(0);
  await expect(dialog.getByRole("combobox", { name: "SSH key" })).toHaveValue("key-one");
  await fillHost(page);
  await dialog.getByRole("button", { name: "Fetch host key" }).click();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  const post = state.calls.find(
    (call) => call.method === "POST" && call.path === "/api/ssh-accesses",
  );
  expect(post.body).toMatchObject({ type: "sftp", auth: "key", keyId: "key-one" });
  expect(post.body).not.toHaveProperty("password");
});

test("test connection reports success", async ({ page }) => {
  const state = await fixture(page);
  state.accesses = [sftpHost(state)];
  await english(page);
  await page.goto(baseURL + "/settings/ssh");
  await showAccesses(page);
  await page.getByRole("button", { name: "Files box", exact: true }).click();
  const card = page.getByRole("article");
  await expect(card).toContainText("/srv/files");
  await expect(card.getByRole("button", { name: "Copy public key" })).toHaveCount(0);
  await card.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect(card.getByText("Connection successful")).toBeVisible();
  expect(
    state.calls.filter((call) => call.path === "/api/ssh-accesses/sftp-one/test"),
  ).toHaveLength(1);
});

test("Work tab shows SFTP mode texts", async ({ page }) => {
  const sftp = {
    ...opnsense,
    id: "44444444-4444-4444-8444-444444444444",
    name: "files-box",
    host: "files.invalid",
    username: "uploader",
    type: "sftp",
  };
  await setup(page, { catalog: catalog([{ ...opnsense, type: "ssh" }, sftp]) });
  await page.goto(baseURL + settingsPath("work", "ssh"));
  await page.getByLabel("files-box", { exact: true }).check();
  const modes = page.getByRole("group", { name: "Mode" });
  await expect(modes.getByText("Reading runs, every change asks.")).toBeVisible();
  await expect(
    modes.getByText("Changes run without asking, deletes always ask."),
  ).toBeVisible();
  await expect(modes.getByText(/in routines\. Deletes always ask/)).toBeVisible();
  await expect(modes.getByText("You confirm every command.")).toHaveCount(0);
  await page.getByLabel("opnsense", { exact: true }).check();
  await expect(page.getByText("You confirm every command.")).toBeVisible();
});
