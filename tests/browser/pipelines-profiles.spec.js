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
  await expect(page).toHaveURL(/\/pipelines\/profiles\/new$/);
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
  await page.getByLabel("Account", { exact: true }).selectOption("local-claude");
  await page.getByLabel("Berechtigungsmodus", { exact: true }).selectOption("plan");
  await page.getByText(/Der gewählte Berechtigungsmodus gilt/).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "docs/screenshots/pipeline-permissions.png" });
  await page.getByRole("button", { name: "Parameter hinzufügen", exact: true }).click();
  await page.getByLabel("Parameterschlüssel 1", { exact: true }).fill("topic");
  await page.getByLabel("Parametername 1", { exact: true }).fill("Thema");
  await page.getByLabel("Parameter erforderlich 1", { exact: true }).check();
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page).toHaveURL(/\/pipelines\/profiles\/profile-new$/);
  await expect(
    page.getByRole("heading", { name: "Interaktiver Helfer", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Alle Profile", exact: true }).click();
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

test("mobile profile selectors stay anchored inside the editor and preserve keyboard selection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await pipelinesFixture(page);
  await openPipelines(page, "profiles/new");
  const field = page.getByRole("combobox", { name: "Account", exact: true });
  await field.click();
  const list = page.getByRole("listbox", { name: "Account: Optionen", exact: true });
  await expect(list).toBeVisible();
  const anchor = await field.boundingBox(),
    popup = await list.boundingBox();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(Math.abs(popup.x - anchor.x)).toBeLessThan(2);
  expect(
    Math.min(
      Math.abs(popup.y - anchor.y - anchor.height),
      Math.abs(anchor.y - popup.y - popup.height),
    ),
  ).toBeLessThan(9);
  expect(popup.y).toBeGreaterThanOrEqual(0);
  expect(popup.y + popup.height).toBeLessThanOrEqual(844);
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
  await expect(page.getByRole("form", { name: "Neues Profil" })).toBeVisible();
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
    await expect(page).toHaveURL(/\/pipelines\/profiles\/profile-new$/);
    await expect(
      page.getByRole("heading", { name: "Zentrales Profil", exact: true }),
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
    await page.reload();
    await expect(access).toHaveValue("central-openrouter");
    await page
      .getByRole("combobox", { name: "Account", exact: true })
      .selectOption("local-claude");
    await expect(access).toHaveValue("");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
  });

// Profiles in phase order, spread over three phases with both run modes.
function addProfiles(state) {
  const base = state.profiles[0];
  state.profiles.push(
    {
      ...structuredClone(base),
      id: "profile-review",
      name: "Prüfer",
      phaseKey: "review",
      enabled: false,
      config: {
        ...structuredClone(base.config),
        accountId: "local-claude",
        cliTool: "claude",
        models: { available: ["opus"], default: "opus" },
        permissions: { mode: "plan" },
        run: { autonomous: false },
      },
    },
    { ...structuredClone(base), id: "profile-own", name: "Eigenes", phaseKey: null },
    {
      ...structuredClone(base),
      id: "profile-refine",
      name: "Klärer",
      phaseKey: "refinement",
    },
  );
}

test("desktop profiles select the first profile, group by phase and edit inline", async ({
  page,
}) => {
  const state = await pipelinesFixture(page);
  addProfiles(state);
  await openPipelines(page);
  const list = page.getByRole("navigation", { name: "Aufgabenprofile", exact: true });
  await expect(list.locator(".profile-group-caps")).toHaveText([
    "Klärung",
    "Planung",
    "Prüfung",
    "Eigene Profile",
  ]);
  // The first profile in phase order opens without a dialog.
  await expect(page).toHaveURL(/\/pipelines\/profiles\/profile-refine$/);
  const first = list.getByRole("button", { name: "Bearbeiten: Klärer", exact: true });
  await expect(first).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Klärer", exact: true })).toBeVisible();
  await expect(
    page.getByText("Klärung · 3 Stufenläufe in den letzten 7 Tagen"),
  ).toBeVisible();
  const reviewer = list.getByRole("button", { name: "Bearbeiten: Prüfer", exact: true });
  await expect(reviewer).toContainText("Claude Code · opus");
  await expect(reviewer).toContainText("Interaktiv · Deaktiviert");
  await expect(first).toContainText("Codex · Account-Standard");
  await expect(first).toContainText("Autonom");
  for (const section of ["Grundlagen", "Ausführung", "Anweisungen", "Parameter"])
    await expect(page.getByRole("group", { name: section, exact: true })).toBeVisible();
  await reviewer.click();
  await expect(page).toHaveURL(/\/profiles\/profile-review$/);
  await expect(
    page.getByRole("button", { name: "Sitzung mit Profil starten", exact: true }),
  ).toBeDisabled();
  const hint = page.getByText(
    "Pipeline-Stufen benötigen ein autonomes Profil ohne erforderliche Parameter.",
    { exact: true },
  );
  await expect(hint).toHaveCSS("color", "rgb(255, 201, 157)");
  await expect(
    page.getByRole("button", { name: "Duplizieren: Prüfer", exact: true }),
  ).toHaveText("Duplizieren");
  await expect(
    page.getByRole("button", { name: "Löschen: Prüfer", exact: true }),
  ).toHaveText("Löschen");
});

test("unsaved profile drafts ask before another profile, a new one or a copy opens", async ({
  page,
}) => {
  const state = await pipelinesFixture(page);
  addProfiles(state);
  await openPipelines(page, "profiles/profile-one");
  const name = page.getByRole("textbox", { name: "Profilname", exact: true });
  await name.fill("Geänderter Planer");
  const confirm = page.getByRole("dialog", { name: "Aktion bestätigen" });
  await page.getByRole("button", { name: "Bearbeiten: Prüfer", exact: true }).click();
  await confirm.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await expect(page).toHaveURL(/\/profiles\/profile-one$/);
  await expect(name).toHaveValue("Geänderter Planer");
  await page.getByRole("button", { name: "Neues Profil", exact: true }).click();
  await confirm.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await page.getByRole("button", { name: "Duplizieren: Planer", exact: true }).click();
  await confirm.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await expect(page).toHaveURL(/\/profiles\/profile-one$/);
  await page.getByRole("button", { name: "Bearbeiten: Prüfer", exact: true }).click();
  await confirm.getByRole("button", { name: "Verwerfen", exact: true }).click();
  await expect(page).toHaveURL(/\/profiles\/profile-review$/);
  await expect(name).toHaveValue("Prüfer");
  // An unchanged editor switches without asking.
  await page.getByRole("button", { name: "Neues Profil", exact: true }).click();
  await expect(page).toHaveURL(/\/profiles\/new$/);
  await expect(name).toHaveValue("");
  expect(state.calls.some((c) => c.method === "PATCH")).toBe(false);
});

test("unknown profiles report unavailability", async ({ page }) => {
  await pipelinesFixture(page);
  await openPipelines(page, "profiles/missing-profile");
  await expect(
    page.getByText("Dieses Profil ist nicht verfügbar.", { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/profiles\/missing-profile$/);
});

test("mobile profiles show the list first and the editor without overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await pipelinesFixture(page);
  addProfiles(state);
  await openPipelines(page);
  const item = page.getByRole("button", { name: "Bearbeiten: Prüfer", exact: true });
  await expect(item).toBeVisible();
  await expect(page).toHaveURL(/\/pipelines\/profiles$/);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await item.click();
  await expect(page).toHaveURL(/\/profiles\/profile-review$/);
  await expect(item).toBeHidden();
  await expect(
    page.getByRole("textbox", { name: "Profilname", exact: true }),
  ).toHaveValue("Prüfer");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.getByRole("textbox", { name: "Profilname", exact: true }).fill("Neu");
  await page.getByRole("button", { name: "Alle Profile", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Aktion bestätigen" })
    .getByRole("button", { name: "Verwerfen", exact: true })
    .click();
  await expect(item).toBeVisible();
});

test.describe("English task profiles", () => {
  test.use({ locale: "en-GB" });
  test("list and editor use English copy", async ({ page }) => {
    const state = await pipelinesFixture(page);
    addProfiles(state);
    await openPipelines(page, "profiles/profile-review");
    const list = page.getByRole("navigation", { name: "Task profiles", exact: true });
    await expect(list.locator(".profile-group-caps")).toHaveText([
      "Refinement",
      "Planning",
      "Review",
      "Custom profiles",
    ]);
    await expect(
      list.getByRole("button", { name: "Edit: Prüfer", exact: true }),
    ).toContainText("Interactive · Disabled");
    await expect(
      list.getByRole("button", { name: "Edit: Planer", exact: true }),
    ).toContainText("Autonomous");
    for (const section of ["Basics", "Execution", "Instructions", "Parameters"])
      await expect(page.getByRole("group", { name: section, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Duplicate: Prüfer" })).toHaveText(
      "Duplicate",
    );
    await expect(
      page.getByText("Review · 3 stage runs in the last 7 days"),
    ).toBeVisible();
  });
});

test("refreshing the profile list asks before discarding an unsaved draft", async ({
  page,
}) => {
  const state = await pipelinesFixture(page);
  await openPipelines(page, "profiles/profile-one");
  const name = page.getByRole("textbox", { name: "Profilname", exact: true });
  await name.fill("Entwurf");
  state.fail = "/pipeline-profiles/profile-one";
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Fixture conflict");
  state.fail = "";
  state.profiles[0] = { ...state.profiles[0], name: "Server-Planer", revision: 5 };
  const confirm = page.getByRole("dialog", { name: "Aktion bestätigen" });
  await page.getByRole("button", { name: "Aktualisieren", exact: true }).click();
  await confirm.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await expect(name).toHaveValue("Entwurf");
  await page.getByRole("button", { name: "Aktualisieren", exact: true }).click();
  await confirm.getByRole("button", { name: "Verwerfen", exact: true }).click();
  await expect(name).toHaveValue("Server-Planer");
});

test("starting a session from an unsaved draft asks before discarding it", async ({
  page,
}) => {
  await pipelinesFixture(page);
  await openPipelines(page, "profiles/profile-one");
  const name = page.getByRole("textbox", { name: "Profilname", exact: true });
  await name.fill("Entwurf");
  const start = page.getByRole("button", {
    name: "Sitzung mit Profil starten",
    exact: true,
  });
  const confirm = page.getByRole("dialog", { name: "Aktion bestätigen" });
  const launch = page.getByRole("dialog", { name: "Neue Sitzung", exact: true });
  await start.click();
  await expect(confirm).toBeVisible();
  await expect(launch).toHaveCount(0);
  await confirm.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await expect(name).toHaveValue("Entwurf");
  await start.click();
  await confirm.getByRole("button", { name: "Verwerfen", exact: true }).click();
  await expect(launch).toBeVisible();
  await expect(name).toHaveValue("Planer");
});
