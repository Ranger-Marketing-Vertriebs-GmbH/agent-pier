import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { pipelinesFixture, openPipelines } from "./pipelines-fixture.js";

// docs/ui-guide.md#saving-unsaved-changes-and-conflicts: a pipelines draft is asked
// about with the shared UnsavedChangesSheet before any navigation leaves it, not only
// before the page's own actions.
const sheet = (page) => page.getByRole("dialog", { name: "Änderungen speichern?" });
const profileName = (page) =>
  page.getByRole("textbox", { name: "Profilname", exact: true });

test("a tab switch asks about the draft and Save and continue saves before leaving", async ({
  page,
}) => {
  const state = await pipelinesFixture(page);
  await openPipelines(page, "profiles/profile-one");
  await profileName(page).fill("Geänderter Planer");
  await page.getByRole("tab", { name: /^Läufe/ }).click();
  await expect(sheet(page)).toBeVisible();
  await expect(
    sheet(page).getByRole("button", { name: "Speichern und fortfahren", exact: true }),
  ).toHaveClass(/\bprimary\b/);
  await sheet(page).getByRole("button", { name: "Abbrechen", exact: true }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/pipelines\/profiles\/profile-one$/);
  await expect(profileName(page)).toHaveValue("Geänderter Planer");
  await page.getByRole("tab", { name: /^Läufe/ }).click();
  await sheet(page)
    .getByRole("button", { name: "Speichern und fortfahren", exact: true })
    .click();
  await expect(page).toHaveURL(/\/pipelines$/);
  const patch = state.calls.find(
    (call) => call.method === "PATCH" && call.path === "/pipeline-profiles/profile-one",
  );
  expect(patch.body.name).toBe("Geänderter Planer");
});

test("Save and continue on a new profile saves it and still opens the chosen tab", async ({
  page,
}) => {
  const state = await pipelinesFixture(page);
  await openPipelines(page, "profiles/profile-one");
  await page.getByRole("button", { name: "Duplizieren: Planer", exact: true }).click();
  await expect(page).toHaveURL(/\/pipelines\/profiles\/new$/);
  await profileName(page).fill("Neuer Planer");
  await page.getByRole("tab", { name: /^Läufe/ }).click();
  await sheet(page)
    .getByRole("button", { name: "Speichern und fortfahren", exact: true })
    .click();
  await expect(page).toHaveURL(/\/pipelines$/);
  const post = state.calls.find(
    (call) => call.method === "POST" && call.path === "/pipeline-profiles",
  );
  expect(post.body.name).toBe("Neuer Planer");
});

test("browser back asks about the draft and Discard leaves it", async ({ page }) => {
  const state = await pipelinesFixture(page);
  await page.goto(baseURL + "/pipelines");
  await page.getByRole("tab", { name: /^Aufgabenprofile/ }).click();
  await page.getByRole("button", { name: "Bearbeiten: Planer", exact: true }).click();
  await profileName(page).fill("Entwurf");
  await page.goBack();
  await expect(sheet(page)).toBeVisible();
  await sheet(page).getByRole("button", { name: "Verwerfen", exact: true }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page).not.toHaveURL(/profile-one$/);
  expect(state.calls.some((call) => call.method === "PATCH")).toBe(false);
});

test("an unsaved draft warns before the page unloads", async ({ page }) => {
  await pipelinesFixture(page);
  await openPipelines(page, "profiles/profile-one");
  await profileName(page).fill("Entwurf");
  // The sheet's busy state and the warning follow the draft, not the editor's focus.
  await page.getByRole("heading", { name: "Pipelines", exact: true }).click();
  const dialog = page.waitForEvent("dialog");
  await page.close({ runBeforeUnload: true });
  expect((await dialog).type()).toBe("beforeunload");
});
