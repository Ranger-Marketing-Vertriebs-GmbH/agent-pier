import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { operationsFixture } from "./operations-fixture.js";
test("diagnostics uses explicit probes and retains failures with remedies", async ({
  page,
}) => {
  const state = await operationsFixture(page);
  await page.goto(baseURL + "/settings/diagnostics");
  await expect(
    page.getByText("Noch kein Diagnosebericht.", { exact: true }),
  ).toBeVisible();
  expect(
    state.calls.some(
      (call) => call.path === "/operations/doctor" && call.method === "POST",
    ),
  ).toBe(false);
  await page.getByRole("button", { name: "Prüfungen starten", exact: true }).click();
  await expect(page.getByText("Not installed", { exact: true })).toBeVisible();
  await expect(page.getByText("Install tmux", { exact: true })).toBeVisible();
  expect(
    state.calls.find(
      (call) => call.path === "/operations/doctor" && call.method === "POST",
    ).body.deep,
  ).toBe(false);
});
test("backup planning binds confirmed options and observes one durable job after reload", async ({
  page,
}) => {
  const state = await operationsFixture(page);
  await page.goto(baseURL + "/settings/backups");
  await page.getByRole("button", { name: "Sicherung vorbereiten", exact: true }).click();
  await page
    .getByLabel("Zugangsdaten verschlüsselt einschließen", { exact: true })
    .check();
  await page
    .getByRole("button", { name: "Sicherungsumfang prüfen", exact: true })
    .click();
  await expect(
    page.getByText("Externe lokale CLI-Profile und Betriebssystem-Schlüsselbunde", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByLabel("Passphrase", { exact: true }).fill("fixture passphrase");
  await page.getByRole("button", { name: "Sicherung erstellen", exact: true }).click();
  await expect(page).toHaveURL(/job=job-backup/);
  await expect(
    page.getByRole("region", { name: "Vorgang", exact: true }).getByRole("status"),
  ).toContainText("Abgeschlossen");
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Vorgang", exact: true }).getByRole("status"),
  ).toContainText("Abgeschlossen");
  expect(
    state.calls.filter(
      (call) => call.path === "/operations/backups" && call.method === "POST",
    ),
  ).toHaveLength(1);
});
test("mobile archive inspection restores only into the specified fresh target with project mapping", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await operationsFixture(page);
  await page.goto(baseURL + "/settings/backups");
  await page
    .getByRole("button", { name: "Sicherung prüfen und wiederherstellen", exact: true })
    .click();
  await page.getByLabel("Sicherungsdatei", { exact: true }).setInputFiles({
    name: "fixture.apb",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("fixture archive"),
  });
  await page.getByRole("button", { name: "Archiv prüfen", exact: true }).click();
  await page
    .getByLabel("Neues Datenverzeichnis", { exact: true })
    .fill("/fixture/restored");
  await page.getByLabel("Imported project", { exact: true }).fill("/fixture/project");
  await page
    .getByRole("button", { name: "In neuem Verzeichnis wiederherstellen", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Bestätigen", exact: true })
    .click();
  await expect(page).toHaveURL(/job=job-restore/);
  await expect(page.getByText("/fixture/restored", { exact: true })).toBeVisible();
  expect(
    state.calls.find(
      (call) => call.path === "/operations/restore" && call.method === "POST",
    ).body.projectMap,
  ).toEqual({ "old-project": "/fixture/project" });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});
test("release flow stages the checked version then confirms activation without repeating on reload", async ({
  page,
}) => {
  const state = await operationsFixture(page);
  await page.goto(baseURL + "/settings/updates");
  await page.getByRole("button", { name: "Nach Updates suchen", exact: true }).click();
  await page.getByRole("button", { name: "Version vorbereiten", exact: true }).click();
  await expect(page).toHaveURL(/job=job-stage/);
  await page
    .getByRole("button", { name: "Vorbereitete Version aktivieren: 1.1.0", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Bestätigen", exact: true })
    .click();
  await expect(
    page.getByText("Aktivierung und Zustandsprüfung bestätigt", { exact: true }),
  ).toBeVisible();
  await page.reload();
  expect(
    state.calls.filter((call) => call.path === "/operations/releases/activate"),
  ).toHaveLength(1);
});
test("running update jobs prevent duplicate mutations and a failed activation never claims health success", async ({
  page,
}) => {
  const state = await operationsFixture(page);
  state.jobStatus = "running";
  await page.goto(baseURL + "/settings/updates");
  await page.getByRole("button", { name: "Nach Updates suchen", exact: true }).click();
  await page.getByRole("button", { name: "Version vorbereiten", exact: true }).click();
  await expect(page).toHaveURL(/job=job-stage/);
  await expect(
    page.getByRole("button", { name: "Version vorbereiten", exact: true }),
  ).toBeDisabled();
  await page.reload();
  await expect(
    page.getByRole("button", {
      name: "Vorbereitete Version aktivieren: 1.1.0",
      exact: true,
    }),
  ).toBeDisabled();
  state.jobStatus = "succeeded";
  await page
    .getByRole("button", { name: "Vorbereitete Version aktivieren: 1.1.0", exact: true })
    .click();
  state.jobStatus = "failed";
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Bestätigen", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Vorgang", exact: true }).getByRole("status"),
  ).toContainText("Fehlgeschlagen");
  await expect(
    page.getByText("Aktivierung und Zustandsprüfung bestätigt", { exact: true }),
  ).toHaveCount(0);
  expect(
    state.calls.filter((call) => call.path === "/operations/releases/stage"),
  ).toHaveLength(1);
  expect(
    state.calls.filter((call) => call.path === "/operations/releases/activate"),
  ).toHaveLength(1);
});
test("source checkout exposes server capability boundaries and option changes require a new backup plan", async ({
  page,
}) => {
  const state = await operationsFixture(page);
  state.releases.installed = false;
  state.releases.reason = "Fixture source checkout";
  state.releases.staged = [{ id: "staged-one", version: "1.1.0" }];
  await page.goto(baseURL + "/settings/updates");
  await expect(page.getByText("Fixture source checkout", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Vorbereitete Version aktivieren: 1.1.0",
      exact: true,
    }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Sicherungen", exact: true }).click();
  await page.getByRole("button", { name: "Sicherung vorbereiten", exact: true }).click();
  await page
    .getByRole("button", { name: "Sicherungsumfang prüfen", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Sicherung erstellen", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Zugangsdaten verschlüsselt einschließen", { exact: true })
    .check();
  await expect(
    page.getByRole("button", { name: "Sicherung erstellen", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Sicherungsumfang prüfen", exact: true }),
  ).toBeVisible();
  expect(
    state.calls.filter(
      (call) => call.path === "/operations/backups" && call.method === "POST",
    ),
  ).toHaveLength(0);
});
