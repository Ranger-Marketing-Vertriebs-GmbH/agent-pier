// Settings and Connections polish from feature test W8: diagnostics names and
// translates its checks, network hosts are checked before saving, the backup and
// restore dialogs explain in place, and a Plane connection is checked when saved.
// Each runs on a desktop in English and on a phone in German.
import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { operationsFixture } from "./operations-fixture.js";

const variants = [
  { locale: "en-GB", width: 1440, height: 1000 },
  { locale: "de-DE", width: 390, height: 844 },
];

const noSideScroll = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

for (const { locale, width, height } of variants) {
  const en = locale === "en-GB";
  test.describe(`W8 polish ${locale} ${width}px`, () => {
    test.use({ locale });
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height });
    });

    test("diagnostics heads a model access by its name and translates its summary", async ({
      page,
    }) => {
      const state = await operationsFixture(page);
      state.report = {
        version: "0.0.0-test",
        generatedAt: "2026-11-21T10:00:00.000Z",
        checks: [
          {
            id: "provider-connection.3b1e2f4a-0000-4000-8000-000000000001",
            status: "ok",
            subject: "OpenRouter privat",
            summary:
              "Provider key presence checked; validity and entitlement were not tested.",
            summaryId: "keyPresence",
            summaryArgs: [],
          },
        ],
      };
      await page.goto(baseURL + "/settings/diagnostics");
      await expect(
        page.getByText(
          en ? "Model access: OpenRouter privat" : "Modell-Zugang: OpenRouter privat",
          {
            exact: true,
          },
        ),
      ).toBeVisible();
      await expect(page.getByText(/provider-connection\./)).toHaveCount(0);
      await expect(
        page.getByText(en ? /whether it works was not tested/ : /ob er funktioniert/),
      ).toBeVisible();
      // The project scope lists the projects of the Projects page.
      await page
        .getByRole("combobox", { name: en ? "Check scope" : "Prüfumfang" })
        .click();
      await page
        .getByRole("option", { name: en ? "Project" : "Projekt", exact: true })
        .click();
      await page
        .getByRole("combobox", { name: en ? "Project" : "Projekt", exact: true })
        .click();
      await expect(page.getByRole("option", { name: "Fixture project" })).toBeVisible();
      expect(await noSideScroll(page)).toBe(true);
    });

    test("a wrong network host is named before saving and a long one wraps", async ({
      page,
    }) => {
      const state = await operationsFixture(page);
      state.remote.network.saved.enabled = true;
      await page.goto(baseURL + "/settings/remote");
      const input = page.getByRole("textbox", {
        name: en ? "Additional host" : "Zusätzlicher Host",
      });
      const add = page.getByRole("button", { name: en ? "Add host" : "Host hinzufügen" });
      await input.fill("bad host:8080");
      await add.click();
      await expect(page.getByRole("alert")).toContainText("bad host:8080");
      await expect(input).toHaveAttribute("aria-invalid", "true");
      const long = `${"x".repeat(60)}.${"y".repeat(60)}.example`;
      await input.fill(long);
      await add.click();
      await expect(page.getByText(long, { exact: true })).toBeVisible();
      await expect(page.getByRole("alert")).toHaveCount(0);
      expect(await noSideScroll(page)).toBe(true);
      await page
        .getByRole("button", { name: en ? `Remove ${long}` : `${long} entfernen` })
        .click();
      await expect(page.getByText(long, { exact: true })).toHaveCount(0);
    });

    test("backup history needs credentials and a short passphrase is explained", async ({
      page,
    }) => {
      await operationsFixture(page);
      await page.goto(baseURL + "/settings/backups");
      await page
        .getByRole("button", { name: en ? "Prepare backup" : "Sicherung vorbereiten" })
        .first()
        .click();
      const dialog = page.getByRole("dialog");
      const history = dialog.getByRole("checkbox", {
        name: en ? "Include history" : "Verläufe einschließen",
      });
      await expect(history).toBeDisabled();
      await expect(history).not.toBeChecked();
      await dialog
        .getByRole("checkbox", {
          name: en
            ? "Include encrypted credentials"
            : "Zugangsdaten verschlüsselt einschließen",
        })
        .check();
      await expect(history).toBeEnabled();
      await expect(history).toBeChecked();
      await dialog
        .getByRole("button", {
          name: en ? "Review backup scope" : "Sicherungsumfang prüfen",
        })
        .click();
      await dialog.getByLabel("Passphrase").fill("short");
      await dialog
        .getByRole("button", { name: en ? "Create backup" : "Sicherung erstellen" })
        .click();
      await expect(dialog.getByRole("alert")).toHaveText(
        en
          ? "The passphrase needs at least 12 characters."
          : "Die Passphrase braucht mindestens 12 Zeichen.",
      );
      await expect(dialog.getByLabel("Passphrase")).toHaveAttribute(
        "aria-invalid",
        "true",
      );
      expect(await noSideScroll(page)).toBe(true);
    });

    test("a restore leaves unmapped projects historical and lists the next steps", async ({
      page,
    }) => {
      const state = await operationsFixture(page);
      await page.goto(baseURL + "/settings/backups");
      await page
        .getByRole("button", {
          name: en
            ? "Inspect and restore backup"
            : "Sicherung prüfen und wiederherstellen",
        })
        .click();
      const dialog = page.getByRole("dialog");
      await dialog.locator('input[type="file"]').setInputFiles({
        name: "backup.apbackup",
        mimeType: "application/octet-stream",
        buffer: Buffer.from("fixture"),
      });
      await dialog
        .getByRole("button", { name: en ? "Inspect archive" : "Archiv prüfen" })
        .click();
      await expect(
        dialog.getByText(en ? /historical record only/ : /historischen Eintrag/),
      ).toBeVisible();
      await dialog
        .getByRole("textbox", {
          name: en ? "New data directory" : "Neues Datenverzeichnis",
        })
        .fill("/restored/data");
      await dialog
        .getByRole("button", {
          name: en ? "Restore to new directory" : "In neuem Verzeichnis wiederherstellen",
        })
        .click();
      await page
        .getByRole("button", { name: en ? "Restore now" : "Jetzt wiederherstellen" })
        .click();
      await expect(page.getByText(en ? "Next steps" : "Nächste Schritte")).toBeVisible();
      const restore = state.calls.find(
        (call) => call.method === "POST" && call.path === "/operations/restore",
      );
      expect(restore.body.projectMap).toEqual({});
      await expect(page.getByText(/AGENTPIER_DATA_DIR="\/restored\/data"/)).toBeVisible();
      expect(await noSideScroll(page)).toBe(true);
    });

    test("a saved Plane connection is checked and its row opens the editor", async ({
      page,
    }) => {
      const state = await operationsFixture(page);
      state.planeUnreachable = true;
      await page.goto(baseURL + "/connections?section=tickets");
      await page
        .getByRole("button", {
          name: en ? "Add Plane connection" : "Plane-Zugang hinzufügen",
        })
        .first()
        .click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("textbox", { name: "Name" }).fill("w8-plane");
      await dialog
        .getByRole("textbox", { name: en ? "API URL" : "API-Adresse" })
        .fill("https://plane.example.invalid");
      await dialog
        .getByRole("textbox", { name: en ? "Workspace slug" : "Workspace-Kürzel" })
        .fill("my-team");
      await dialog.getByLabel(en ? "API key" : "API-Schlüssel").fill("plane-token");
      await dialog.getByRole("button", { name: en ? "Save" : "Speichern" }).click();
      await expect(
        page.getByText(en ? "Not reachable" : "Nicht erreichbar"),
      ).toBeVisible();
      await expect(page.getByText(/ENOTFOUND/)).toBeVisible();
      expect(
        state.calls.some((call) => call.path === "/ticket-connections/plane-1/projects"),
      ).toBe(true);
      await page
        .getByRole("button", { name: /w8-plane/ })
        .first()
        .click();
      await expect(
        page.getByRole("dialog", {
          name: en ? "Edit Plane connection" : "Plane-Zugang bearbeiten",
        }),
      ).toBeVisible();
      expect(await noSideScroll(page)).toBe(true);
    });
  });
}
