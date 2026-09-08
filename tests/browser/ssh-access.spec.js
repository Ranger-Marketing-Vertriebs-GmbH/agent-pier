import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fixture } from "./ssh-fixture.js";
test("mobile SSH creation requires independently confirmed fingerprint and retains failed draft", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page);
  await page.goto(baseURL + "/settings/ssh");
  await page
    .getByRole("button", { name: "Serverzugang hinzufügen", exact: true })
    .click();
  await page.getByLabel("Name", { exact: true }).fill("Build server");
  await page.getByLabel("Host", { exact: true }).fill("build.example.test");
  await page.getByLabel("Benutzername", { exact: true }).fill("deploy");
  const save = page.getByRole("button", { name: "Speichern", exact: true });
  await expect(save).toBeDisabled();
  await page.getByRole("button", { name: "Hostschlüssel abrufen", exact: true }).click();
  await expect(page.getByText("SHA256:verified-host", { exact: true })).toBeVisible();
  await expect(save).toBeDisabled();
  await page.screenshot({ path: ".cache/ssh-host-confirm-mobile.png" });
  await page
    .getByLabel("Ich habe den Fingerabdruck unabhängig beim Serverbetreiber geprüft.")
    .check();
  state.fail = true;
  await save.click();
  await expect(page.getByRole("alert")).toContainText("Fixture conflict");
  await expect(page.getByLabel("Host", { exact: true })).toHaveValue(
    "build.example.test",
  );
  state.fail = false;
  await save.click();
  await expect(
    page.locator(".ssh-hosts").getByText("ssh-ed25519 public-fixture", { exact: true }),
  ).toBeVisible();
  expect(state.calls.filter((call) => call.path.endsWith("/test"))).toHaveLength(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.screenshot({ path: ".cache/ssh-settings-mobile.png", fullPage: true });
});
test("existing session assignment exposes copy command without sending agent input and revoke retains failed draft", async ({
  page,
}) => {
  const state = await fixture(page);
  state.accesses = [state.access];
  await page.goto(baseURL + "/sessions/fixture-session");
  await page.getByRole("button", { name: "Serverzugänge", exact: true }).click();
  await page.getByRole("checkbox", { name: /Build server/ }).check();
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await page.getByRole("button", { name: "Befehl kopieren", exact: true }).click();
  expect(await page.evaluate(() => window.copiedText)).toContain("ssh.mjs");
  await expect(page.getByText("-- uname -a", { exact: true })).toBeVisible();
  expect(state.base.calls.filter((call) => call.method !== "GET")).toEqual([]);
  expect(await page.evaluate(() => window.sshTerminalInputs)).toEqual([]);
  await page.screenshot({ path: ".cache/ssh-session-desktop.png" });
  await page.getByRole("checkbox", { name: /Build server/ }).uncheck();
  state.fail = true;
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /Build server/ })).not.toBeChecked();
  state.fail = false;
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Befehl kopieren", exact: true }),
  ).toHaveCount(0);
  expect(state.assignedIds).toEqual([]);
});

test("endpoint edits invalidate confirmation and deletion requires confirmation", async ({
  page,
}) => {
  const state = await fixture(page);
  state.accesses = [state.access];
  await page.goto(baseURL + "/settings/ssh");
  await page
    .locator(".ssh-hosts")
    .getByRole("button", { name: "Bearbeiten", exact: true })
    .click();
  const save = page.getByRole("button", { name: "Speichern", exact: true });
  await expect(save).toBeEnabled();
  await page.getByLabel("Host", { exact: true }).fill("new.example.test");
  await expect(save).toBeDisabled();
  await expect(page.getByText("SHA256:verified-host", { exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "Hostschlüssel abrufen", exact: true }).click();
  await expect(save).toBeDisabled();
  await page
    .getByLabel("Ich habe den Fingerabdruck unabhängig beim Serverbetreiber geprüft.")
    .check();
  await save.click();
  expect(state.calls.find((call) => call.method === "PATCH").body.host).toBe(
    "new.example.test",
  );
  await page.getByRole("button", { name: "Verbindung testen", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Verbindung erfolgreich");
  await page
    .locator(".ssh-hosts")
    .getByRole("button", { name: "Löschen", exact: true })
    .click();
  expect(state.calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
  state.fail = true;
  await page.getByRole("button", { name: "Löschen bestätigen", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  state.fail = false;
  await page.getByRole("button", { name: "Löschen bestätigen", exact: true }).click();
  await expect(page.getByText("Noch keine Serverzugänge vorhanden.")).toBeVisible();
});

test("English management supports explicit key import and manual copying fallback", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.addInitScript(() => {
    localStorage.setItem("agentpier-language", "en");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw Error("denied");
        },
      },
    });
  });
  await page.goto(baseURL + "/settings/ssh");
  await expect(
    page.getByRole("heading", { name: "Server accesses", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add SSH key", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Imported key");
  await page
    .getByRole("combobox", { name: "SSH key", exact: true })
    .selectOption("import");
  await page
    .getByLabel("Unencrypted private SSH key", { exact: true })
    .fill("fixture-only-not-a-real-key");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect(
    state.calls.find((call) => call.method === "POST" && call.path === "/api/ssh-keys")
      .body.privateKey,
  ).toBe("fixture-only-not-a-real-key");
  await page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Imported key", exact: true }) })
    .getByRole("button", { name: "Copy public key", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Select and copy the text manually",
  );
  await expect(
    page.getByText("fixture-only-not-a-real-key", { exact: true }),
  ).toHaveCount(0);
});

test("launch selections are submitted and retained when launch fails", async ({
  page,
}) => {
  const state = await fixture(page);
  state.accesses = [state.access];
  const launches = [];
  await page.route("**/api/sessions", (route) => {
    launches.push(route.request().postDataJSON());
    return route.fulfill({ status: 409, json: { error: "Launch rejected" } });
  });
  await page.goto(baseURL);
  await page.getByRole("button", { name: "Neue Sitzung", exact: true }).click();
  await page.getByRole("checkbox", { name: /Build server/ }).check();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Sitzung starten", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Launch rejected");
  expect(launches[0].sshAccessIds).toEqual(["ssh-one"]);
  await expect(page.getByRole("checkbox", { name: /Build server/ })).toBeChecked();
  expect(state.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
});

test("creation waits for the initial list so a delayed response cannot erase the new public key", async ({
  page,
}) => {
  const state = await fixture(page);
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/api/ssh-accesses", async (route) => {
    await pending;
    return route.fulfill({ json: { accesses: [] } });
  });
  await page.goto(baseURL + "/settings/ssh");
  const add = page.getByRole("button", { name: "Serverzugang hinzufügen", exact: true });
  try {
    await expect(add).toBeDisabled();
    expect(state.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  } finally {
    release();
  }
  await expect(add).toBeEnabled();
});
