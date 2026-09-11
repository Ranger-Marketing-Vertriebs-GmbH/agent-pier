import { test, expect } from "@playwright/test";
import { pipelinesFixture, openPipelines } from "./pipelines-fixture.js";
test("profile editing preserves drafts on conflict and clones without reusing identity", async ({
  page,
}) => {
  const state = await pipelinesFixture(page);
  await openPipelines(page);
  await page.getByRole("button", { name: "Bearbeiten: Planer", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Profilname", exact: true })
    .fill("Neuer Planer");
  state.fail = "/pipeline-profiles/profile-one";
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Fixture conflict");
  await expect(
    page.getByRole("textbox", { name: "Profilname", exact: true }),
  ).toHaveValue("Neuer Planer");
  state.fail = "";
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Bearbeiten: Neuer Planer", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Duplizieren: Neuer Planer", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Profilname", exact: true }),
  ).toHaveValue("Neuer Planer (Kopie)");
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  const creation = state.calls.find(
    (c) => c.path === "/pipeline-profiles" && c.method === "POST",
  );
  expect(creation.body.id).toBeUndefined();
  expect(creation.body.config.accountId).toBe("local-codex");
});
test("mobile profile creation supports account permissions and parameters without overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await pipelinesFixture(page);
  await openPipelines(page, "profiles/new");
  await page
    .getByRole("textbox", { name: "Profilname", exact: true })
    .fill("Interaktiver Helfer");
  await page.getByLabel("Konto", { exact: true }).selectOption("local-claude");
  await page.getByLabel("Berechtigungsmodus", { exact: true }).selectOption("plan");
  await page.getByText(/Der gewählte Berechtigungsmodus gilt/).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "docs/screenshots/pipeline-permissions.png" });
  await page.getByRole("button", { name: "Parameter hinzufügen", exact: true }).click();
  await page.getByLabel("Parameterschlüssel 1", { exact: true }).fill("topic");
  await page.getByLabel("Parametername 1", { exact: true }).fill("Thema");
  await page.getByLabel("Parameter erforderlich 1", { exact: true }).check();
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Bearbeiten: Interaktiver Helfer", exact: true }),
  ).toBeVisible();
  const creation = state.calls.find(
    (c) => c.path === "/pipeline-profiles" && c.method === "POST",
  );
  expect(creation.body.config.cliTool).toBe("claude");
  expect(creation.body.config.prompts.params[0]).toEqual({
    key: "topic",
    label: "Thema",
    required: true,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});

test("profile launch validates required parameters and opens its native session", async ({
  page,
}) => {
  const state = await pipelinesFixture(page);
  state.profiles[0].config.prompts.params = [
    { key: "topic", label: "Thema", required: true },
  ];
  await openPipelines(page);
  await page
    .getByRole("button", { name: "Sitzung mit Profil starten", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Neue Sitzung", exact: true });
  await expect(
    dialog.getByRole("combobox", { name: "Aufgabenprofil", exact: true }),
  ).toHaveValue("profile-one");
  await dialog
    .getByRole("textbox", { name: "Name der Sitzung", exact: true })
    .fill("Meine Planung");
  await dialog
    .getByRole("textbox", { name: "Arbeitsverzeichnis", exact: true })
    .fill("/fixture/project");
  await dialog.locator(".launch-extensions > summary").click();
  await dialog.getByRole("checkbox", { name: /AgentBus/ }).uncheck();
  await dialog.getByRole("button", { name: "Sitzung starten", exact: true }).click();
  expect(state.calls.filter((c) => c.path.endsWith("/launch"))).toHaveLength(0);
  await dialog.getByRole("textbox", { name: "Thema", exact: true }).fill("Security");
  await dialog.getByRole("button", { name: "Sitzung starten", exact: true }).click();
  await expect(page).toHaveURL(/sessions\/launched\/terminal$/);
  expect(state.calls.find((c) => c.path.endsWith("/launch")).body).toMatchObject({
    name: "Meine Planung",
    cwd: "/fixture/project",
    params: { topic: "Security" },
    access: { accountId: "local-codex", tool: "codex" },
    agentbus: false,
    agentpierTools: true,
    sshAccessIds: [],
  });
});

test("disabled profiles cannot launch and rejected deletion preserves the profile", async ({
  page,
}) => {
  const state = await pipelinesFixture(page);
  state.profiles[0].enabled = false;
  await openPipelines(page);
  await expect(
    page.getByRole("button", { name: "Sitzung mit Profil starten", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Löschen: Planer", exact: true }).click();
  state.fail = "/pipeline-profiles/profile-one";
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Entfernen", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("Fixture conflict");
  expect(state.profiles).toHaveLength(1);
  state.fail = "";
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Entfernen", exact: true })
    .click();
  await expect(
    page.getByText("Noch keine Aufgabenprofile.", { exact: true }),
  ).toBeVisible();
});

test("mobile profile selectors stay anchored inside the dialog and preserve keyboard selection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await pipelinesFixture(page);
  await openPipelines(page, "profiles/new");
  const field = page.getByRole("combobox", { name: "Konto", exact: true });
  await field.click();
  const list = page.getByRole("listbox", { name: "Konto: Optionen", exact: true });
  await expect(list).toBeVisible();
  const anchor = await field.boundingBox(),
    popup = await list.boundingBox(),
    dialog = await page.getByRole("dialog").boundingBox();
  expect(Math.abs(popup.x - anchor.x)).toBeLessThan(2);
  expect(
    Math.min(
      Math.abs(popup.y - anchor.y - anchor.height),
      Math.abs(anchor.y - popup.y - popup.height),
    ),
  ).toBeLessThan(9);
  expect(popup.y).toBeGreaterThanOrEqual(dialog.y);
  expect(popup.y + popup.height).toBeLessThanOrEqual(dialog.y + dialog.height);
  expect(popup.x + popup.width).toBeLessThanOrEqual(390);
  await list.getByRole("option", { name: "Claude lokal", exact: true }).click();
  await expect(field).toHaveValue("local-claude");
  const permissions = page.getByRole("combobox", {
    name: "Berechtigungsmodus",
    exact: true,
  });
  await permissions.press("ArrowDown");
  await expect(
    page.getByRole("listbox", { name: "Berechtigungsmodus: Optionen", exact: true }),
  ).toBeVisible();
  await permissions.press("End");
  await permissions.press("Enter");
  await expect(permissions).toHaveValue("bypassPermissions");
  await permissions.press("ArrowDown");
  await permissions.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(permissions).toBeFocused();
});

for (const width of [1440, 390])
  test(`central profile selection preserves its source account and catalog model at width ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const state = await pipelinesFixture(page);
    await openPipelines(page, "profiles/new");
    await page
      .getByRole("textbox", { name: "Profilname", exact: true })
      .fill("Zentrales Profil");
    const access = page.getByRole("combobox", {
      name: "Provider-Verbindung",
      exact: true,
    });
    await expect(access.locator("option[value=central-zai]")).toHaveCount(0);
    await access.selectOption("central-openrouter");
    await page
      .getByRole("combobox", { name: "Anbietermodell", exact: true })
      .selectOption("fixture/model");
    await page.getByRole("button", { name: "Speichern", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Bearbeiten: Zentrales Profil", exact: true }),
    ).toBeVisible();
    const creation = state.calls.find(
      (c) => c.path === "/pipeline-profiles" && c.method === "POST",
    );
    expect(creation.body.config.accountId).toBe("local-codex");
    expect(creation.body.config.providerConnectionId).toBe("central-openrouter");
    expect(creation.body.config.models).toEqual({
      available: ["fixture/model"],
      default: "fixture/model",
    });
    await page
      .getByRole("button", { name: "Bearbeiten: Zentrales Profil", exact: true })
      .click();
    await page.reload();
    await expect(access).toHaveValue("central-openrouter");
    await page
      .getByRole("combobox", { name: "Konto", exact: true })
      .selectOption("local-claude");
    await expect(access).toHaveValue("");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
  });
