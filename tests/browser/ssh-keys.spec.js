import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fixture } from "./ssh-fixture.js";
const card = (page, name) =>
  page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name, exact: true }) });
test("named keys are created independently, renamed and reused by two hosts", async ({
  page,
}) => {
  const state = await fixture(page);
  state.keys = [];
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseURL + "/settings/ssh");
  await expect(
    page.getByRole("button", { name: "Add server access", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Add SSH key", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Shared deployment");
  state.fail = true;
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Fixture conflict");
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Shared deployment");
  state.fail = false;
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect(state.accesses).toEqual([]);
  await card(page, "Shared deployment")
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await expect(
    page.getByLabel("Unencrypted private SSH key", { exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Name", { exact: true }).fill("Deployment");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  for (const name of ["Build host", "Production host"]) {
    await page.getByRole("button", { name: "Add server access", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel("Host", { exact: true }).fill("build.example.test");
    await page.getByLabel("Username", { exact: true }).fill("deploy");
    await page.getByRole("button", { name: "Fetch host key", exact: true }).click();
    await page
      .getByLabel(
        "I have independently verified the fingerprint with the server operator.",
      )
      .check();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(card(page, name)).toBeVisible();
  }
  expect(state.accesses.map((a) => a.keyId)).toEqual([
    state.keys[0].id,
    state.keys[0].id,
  ]);
  await expect(card(page, "Deployment")).toContainText("Build host");
  await expect(card(page, "Deployment")).toContainText("Production host");
  await expect(
    card(page, "Deployment").getByRole("button", { name: "Delete", exact: true }),
  ).toBeDisabled();
  await card(page, "Deployment")
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await page.getByLabel("Name", { exact: true }).fill("Renamed shared key");
  state.fail = true;
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Fixture conflict");
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    "Renamed shared key",
  );
  state.fail = false;
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card(page, "Build host")).toContainText("Renamed shared key");
  await expect(card(page, "Production host")).toContainText("Renamed shared key");
  for (const name of ["Build host", "Production host"]) {
    await card(page, name).getByRole("button", { name: "Delete", exact: true }).click();
    await card(page, name)
      .getByRole("button", { name: "Confirm deletion", exact: true })
      .click();
    await expect(card(page, name)).toHaveCount(0);
  }
  await expect(
    card(page, "Renamed shared key").getByRole("button", { name: "Delete", exact: true }),
  ).toBeEnabled();
  await expect(
    card(page, "Renamed shared key").getByText("ssh-ed25519 public-fixture", {
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({ path: ".cache/ssh-keys-mobile-en.png", fullPage: true });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});
test("existing host key selection preserves confirmation and failed key deletion is visible", async ({
  page,
}) => {
  const state = await fixture(page);
  state.accesses = [state.access];
  state.keys.push({ ...state.keys[0], id: "key-two", name: "Replacement" });
  await page.goto(baseURL + "/settings/ssh");
  await card(page, "Build server")
    .getByRole("button", { name: "Bearbeiten", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "SSH-Schlüssel", exact: true }),
  ).toHaveValue("key-one");
  await page
    .getByRole("combobox", { name: "SSH-Schlüssel", exact: true })
    .selectOption("key-two");
  await expect(
    page.getByRole("button", { name: "Speichern", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await card(page, "Deployment key")
    .getByRole("button", { name: "Löschen", exact: true })
    .click();
  state.fail = true;
  await card(page, "Deployment key")
    .getByRole("button", { name: "Löschen bestätigen", exact: true })
    .click();
  await expect(card(page, "Deployment key").getByRole("alert")).toContainText(
    "Fixture conflict",
  );
  state.fail = false;
  await card(page, "Deployment key")
    .getByRole("button", { name: "Löschen bestätigen", exact: true })
    .click();
  await expect(card(page, "Deployment key")).toHaveCount(0);
});
test("key catalog loading gates key and host creation", async ({ page }) => {
  await fixture(page);
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/api/ssh-keys", async (route) => {
    await pending;
    await route.fulfill({ json: { keys: [] } });
  });
  await page.goto(baseURL + "/settings/ssh");
  try {
    await expect(
      page.getByRole("button", { name: "SSH-Schlüssel hinzufügen", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Serverzugang hinzufügen", exact: true }),
    ).toBeDisabled();
  } finally {
    release();
  }
  await expect(
    page.getByRole("button", { name: "SSH-Schlüssel hinzufügen", exact: true }),
  ).toBeEnabled();
});
