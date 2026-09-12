import { test, expect } from "@playwright/test";
import { pipelinesFixture, openPipelines } from "./pipelines-fixture.js";

for (const width of [1440, 390])
  test(`normal session dialog selects and overrides an interactive profile at width ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const state = await pipelinesFixture(page);
    state.profiles[0].config.run.autonomous = false;
    state.profiles[0].config.models = {
      available: ["profile-model"],
      default: "profile-model",
    };
    await page.route("**/api/ssh-accesses", (route) =>
      route.fulfill({
        json: {
          accesses: [
            {
              id: "host-one",
              name: "Testserver",
              username: "test",
              host: "host.example.test",
              port: 22,
            },
          ],
        },
      }),
    );
    await openPipelines(page);
    await (width === 390 ? page.getByRole("main") : page)
      .getByRole("button", { name: "Neue Sitzung", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Neue Sitzung", exact: true });
    const profile = dialog.getByRole("combobox", { name: "Aufgabenprofil", exact: true });
    await expect(profile).toHaveValue("");
    await profile.selectOption("profile-one");
    await expect(dialog.getByLabel("CLI", { exact: true })).toHaveValue("codex");
    await expect(dialog.getByLabel("Zugang", { exact: true })).toHaveValue("local-codex");
    const model = dialog.getByRole("textbox", {
      name: "Natives Modell (optional)",
      exact: true,
    });
    await expect(model).toHaveValue("profile-model");
    await expect(dialog.getByLabel("Startmodus", { exact: true })).toHaveValue("profile");
    await model.fill("session-model");
    await dialog.getByLabel("Startmodus", { exact: true }).selectOption("yolo");
    await page.locator(".launch-extensions > summary").click();
    await dialog.getByRole("checkbox", { name: /Testserver/ }).check();
    await dialog.getByRole("checkbox", { name: /AgentPier-Werkzeuge/ }).uncheck();
    await profile.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `docs/screenshots/session-profile-${width}.png` });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    state.fail = "/pipeline-profiles/profile-one/launch";
    await dialog.getByRole("button", { name: "Sitzung starten", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("Fixture conflict");
    expect(state.calls.find((call) => call.path.endsWith("/launch")).body).toMatchObject({
      access: { accountId: "local-codex", tool: "codex", nativeModelId: "session-model" },
      launchMode: "yolo",
      sshAccessIds: ["host-one"],
      agentpierTools: false,
    });
    await expect(profile).toHaveValue("profile-one");
    await expect(model).toHaveValue("session-model");
    await profile.selectOption("");
    await expect(dialog.getByLabel("Startmodus", { exact: true })).toHaveValue("yolo");
    await expect(model).toHaveValue("");
    await profile.selectOption("profile-one");
    await dialog.getByLabel("CLI", { exact: true }).selectOption("claude");
    await expect(profile).toHaveValue("profile-one");
    await expect(dialog.getByLabel("Startmodus", { exact: true })).toHaveValue("auto");
  });

test("profile shortcut presets central access and sends its source account with the selected model", async ({
  page,
}) => {
  const state = await pipelinesFixture(page);
  state.profiles[0].config.providerConnectionId = "central-openrouter";
  state.profiles[0].config.models = {
    available: ["fixture/model"],
    default: "fixture/model",
  };
  await openPipelines(page);
  await page
    .getByRole("button", { name: "Sitzung mit Profil starten", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Neue Sitzung", exact: true });
  await expect(dialog.getByLabel("Zugang", { exact: true })).toHaveValue(
    "provider:central-openrouter",
  );
  await dialog.getByRole("button", { name: "Sitzung starten", exact: true }).click();
  await expect(page).toHaveURL(/sessions\/launched\/terminal$/);
  expect(state.calls.find((call) => call.path.endsWith("/launch")).body.access).toEqual({
    tool: "codex",
    accountId: "local-codex",
    providerConnectionId: "central-openrouter",
    providerModelId: "fixture/model",
  });
});

test("a removed preselected profile cannot silently launch a plain session", async ({
  page,
}) => {
  const state = await pipelinesFixture(page);
  await openPipelines(page);
  await expect(
    page.getByRole("button", { name: "Sitzung mit Profil starten", exact: true }),
  ).toBeVisible();
  state.profiles = [];
  await page
    .getByRole("button", { name: "Sitzung mit Profil starten", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toContainText("nicht verfügbar");
  await expect(
    dialog.getByRole("button", { name: "Sitzung starten", exact: true }),
  ).toBeDisabled();
  await dialog.getByLabel("Aufgabenprofil", { exact: true }).selectOption("");
  await expect(
    dialog.getByRole("button", { name: "Sitzung starten", exact: true }),
  ).toBeEnabled();
});

test("Bug Hunter instructions and parameters survive switching from Claude to Codex", async ({
  page,
}) => {
  const state = await pipelinesFixture(page);
  const profile = state.profiles[0];
  profile.name = "Bug Hunter";
  profile.config.cliTool = "claude";
  profile.config.accountId = "local-claude";
  profile.config.permissions.mode = "auto";
  profile.config.prompts.params = [{ key: "topic", label: "Fehler", required: true }];
  await openPipelines(page);
  await page.getByRole("button", { name: "Neue Sitzung", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Neue Sitzung", exact: true });
  const selection = dialog.getByRole("combobox", { name: "Aufgabenprofil", exact: true });
  await selection.selectOption(profile.id);
  await dialog.getByLabel("Fehler", { exact: true }).fill("Missing kickoff");
  await dialog.getByLabel("CLI", { exact: true }).selectOption("codex");
  await expect(selection).toHaveValue(profile.id);
  await expect(dialog.getByLabel("Fehler", { exact: true })).toHaveValue(
    "Missing kickoff",
  );
  await expect(dialog.getByLabel("Startmodus", { exact: true })).toHaveValue("yolo");
  await expect(
    dialog.getByLabel("Startmodus", { exact: true }).locator('option[value="profile"]'),
  ).toHaveCount(0);
  state.fail = `/pipeline-profiles/${profile.id}/launch`;
  await dialog.getByRole("button", { name: "Sitzung starten", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Fixture conflict");
  expect(state.calls.find((call) => call.path.endsWith("/launch")).body).toMatchObject({
    access: { tool: "codex", accountId: "local-codex" },
    params: { topic: "Missing kickoff" },
    launchMode: "yolo",
  });
  expect(
    state.calls.some((call) => call.path === "/sessions" && call.method === "POST"),
  ).toBe(false);
  await dialog
    .getByLabel("Zugang", { exact: true })
    .selectOption("provider:central-openrouter");
  await dialog
    .getByRole("combobox", { name: "Anbietermodell", exact: true })
    .selectOption("fixture/model");
  await dialog.getByRole("button", { name: "Sitzung starten", exact: true }).click();
  await expect
    .poll(() => state.calls.filter((call) => call.path.endsWith("/launch")).length)
    .toBe(2);
  expect(
    state.calls.filter((call) => call.path.endsWith("/launch"))[1].body.access,
  ).toEqual({
    tool: "codex",
    accountId: "local-codex",
    providerConnectionId: "central-openrouter",
    providerModelId: "fixture/model",
  });
});
