import { test, expect } from "@playwright/test";
import { operationsFixture } from "./operations-fixture.js";
for (const locale of ["de-DE", "en-GB"]) {
  test.describe(`release cleanup ${locale}`, () => {
    test.use({ locale, viewport: { width: 390, height: 844 } });
    test("individual and bulk cleanup confirm the exact selection and preserve protected versions", async ({
      page,
    }, testInfo) => {
      const en = locale === "en-GB";
      const state = await operationsFixture(page);
      let versions = [
        { version: "0.7.0", canDelete: true },
        { version: "0.8.0", canDelete: true },
        { version: "0.9.0", canDelete: false, deleteReason: "inUse" },
        { version: "1.0.0", canDelete: false, deleteReason: "active" },
      ];
      const calls = [];
      await page.route("**/api/operations/releases/cleanup", async (route) => {
        if (route.request().method() === "GET")
          return route.fulfill({ json: { available: true, versions } });
        const body = route.request().postDataJSON();
        calls.push(body);
        versions = versions.filter((item) => !body.versions.includes(item.version));
        const id = `cleanup-${calls.length}`;
        state.jobs[id] = {
          id,
          kind: "release-cleanup",
          result: { removedVersions: body.versions },
        };
        return route.fulfill({ status: 202, json: { job: { id } } });
      });
      await page.goto("/settings/updates");
      await page
        .getByText(en ? "Remove old versions" : "Alte Versionen aufräumen", {
          exact: true,
        })
        .click();
      const label = en ? "Delete version" : "Version löschen";
      await expect(
        page.getByRole("button", { name: `${label}: 0.9.0`, exact: true }),
      ).toBeDisabled();
      await page.getByRole("button", { name: `${label}: 0.7.0`, exact: true }).click();
      await expect(page.getByRole("dialog")).toContainText("0.7.0");
      await page
        .getByRole("button", { name: en ? "Cancel" : "Abbrechen", exact: true })
        .click();
      expect(calls).toHaveLength(0);
      await page.getByRole("button", { name: `${label}: 0.7.0`, exact: true }).click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: en ? "Confirm" : "Bestätigen", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: `${label}: 0.7.0`, exact: true }),
      ).toHaveCount(0);
      expect(calls[0]).toEqual({ versions: ["0.7.0"] });
      await page.screenshot({
        path: testInfo.outputPath("release-cleanup-mobile.png"),
        fullPage: true,
      });
      await page
        .getByRole("button", {
          name: en ? "Delete all old versions" : "Alle alten Versionen löschen",
          exact: true,
        })
        .click();
      await expect(page.getByRole("dialog")).toContainText("0.8.0");
      await expect(page.getByRole("dialog")).not.toContainText("0.9.0");
      await page
        .getByRole("dialog")
        .getByRole("button", { name: en ? "Confirm" : "Bestätigen", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: `${label}: 0.8.0`, exact: true }),
      ).toHaveCount(0);
      expect(calls[1]).toEqual({ versions: ["0.8.0"] });
      await page.reload();
      expect(calls).toHaveLength(2);
    });

    test("blocked versions list their sessions and migrate them before deletion", async ({
      page,
    }) => {
      const en = locale === "en-GB";
      const state = await operationsFixture(page);
      const versions = [
        { version: "0.9.0", canDelete: false, deleteReason: "inUse" },
        { version: "1.0.0", canDelete: false, deleteReason: "active" },
      ];
      let plan = {
        version: "0.9.0",
        deleteReason: "inUse",
        migratable: true,
        nodeOnlyProcesses: 1,
        unidentifiedProcesses: [],
        sessions: [
          {
            id: "aaaaaaaa-0000-4000-8000-000000000001",
            name: "Alpha",
            tool: "claude",
            status: "running",
            eligible: true,
            reason: null,
            activity: "idle",
            reload: "idle",
            reloadError: null,
            reloadSince: null,
          },
          {
            id: "aaaaaaaa-0000-4000-8000-000000000002",
            name: null,
            tool: "codex",
            status: "running",
            eligible: true,
            reason: null,
            activity: "working",
            reload: "idle",
            reloadError: null,
            reloadSince: null,
          },
        ],
      };
      const migrations = [];
      let cancelled = 0;
      await page.route("**/api/operations/releases/cleanup", (route) =>
        route.fulfill({ json: { available: true, versions } }),
      );
      await page.route("**/api/operations/releases/cleanup/0.9.0/sessions", (route) =>
        route.fulfill({ json: plan }),
      );
      await page.route(
        "**/api/operations/releases/cleanup/0.9.0/migrate",
        async (route) => {
          if (route.request().method() === "DELETE") {
            cancelled += 1;
            return route.fulfill({ status: 204 });
          }
          migrations.push(route.request().postDataJSON());
          const id = `migrate-${migrations.length}`;
          state.jobs[id] = {
            id,
            kind: "release-migrate",
            result: {
              reloadedSessions: plan.sessions.map((s) => s.id),
              removedVersions: ["0.9.0"],
            },
          };
          return route.fulfill({ status: 202, json: { job: { id } } });
        },
      );
      state.jobStatus = "running";
      await page.goto("/settings/updates");
      await page
        .getByText(en ? "Remove old versions" : "Alte Versionen aufräumen", {
          exact: true,
        })
        .click();
      await page
        .getByRole("button", {
          name: en ? "Show sessions" : "Sessions anzeigen",
          exact: true,
        })
        .click();
      const list = page.getByRole("list", {
        name: en ? "Sessions: 0.9.0" : "Sessions: 0.9.0",
      });
      await expect(list.getByRole("listitem")).toHaveCount(2);
      await expect(list).toContainText("Alpha");
      await expect(list).toContainText(en ? "Ready" : "Bereit");
      await expect(list).toContainText(en ? "Busy" : "Beschäftigt");
      await expect(
        page.getByText(en ? /1 Node process/ : /1 Node-Prozess/),
      ).toBeVisible();
      await page
        .getByRole("button", {
          name: en ? "Migrate now and delete" : "Sofort umziehen und löschen",
          exact: true,
        })
        .click();
      await expect(page.getByRole("dialog")).toContainText(
        en ? "interrupted" : "abgebrochen",
      );
      await page
        .getByRole("dialog")
        .getByRole("button", { name: en ? "Cancel" : "Abbrechen", exact: true })
        .click();
      await page
        .getByRole("button", {
          name: en
            ? "Migrate sessions and delete version"
            : "Sessions umziehen und Version löschen",
          exact: true,
        })
        .click();
      await expect(page.getByRole("dialog")).toContainText("0.9.0");
      await page
        .getByRole("dialog")
        .getByRole("button", { name: en ? "Confirm" : "Bestätigen", exact: true })
        .click();
      expect(migrations).toEqual([{}]);
      const cancel = page.getByRole("button", {
        name: en ? "Cancel migration" : "Umzug abbrechen",
        exact: true,
      });
      await expect(cancel).toBeVisible();
      await cancel.click();
      expect(cancelled).toBe(1);
      state.jobStatus = "succeeded";
      await expect(
        page.getByText(
          en
            ? "Version deleted, 2 session(s) reloaded."
            : "Version gelöscht, 2 Session(s) neu geladen.",
        ),
      ).toBeVisible();
      await expect(cancel).toHaveCount(0);
      // Ineligible sessions and foreign processes disable migration with a hint.
      plan = {
        ...plan,
        migratable: false,
        sessions: [
          { ...plan.sessions[0], eligible: false, reason: "unsupported-session" },
        ],
        unidentifiedProcesses: [
          { reference: "server/features/pipelines/verify-supervisor.js" },
        ],
      };
      await page.reload();
      await page
        .getByText(en ? "Remove old versions" : "Alte Versionen aufräumen", {
          exact: true,
        })
        .click();
      await page
        .getByRole("button", {
          name: en ? "Show sessions" : "Sessions anzeigen",
          exact: true,
        })
        .click();
      await expect(
        page.getByRole("button", {
          name: en
            ? "Migrate sessions and delete version"
            : "Sessions umziehen und Version löschen",
          exact: true,
        }),
      ).toBeDisabled();
      await expect(
        page.getByText(
          en
            ? /Pipeline, login or shell session/
            : /Pipeline-, Login- oder Shell-Session/,
        ),
      ).toBeVisible();
      await expect(page.getByText(/verify-supervisor\.js/)).toBeVisible();
    });
  });
}
