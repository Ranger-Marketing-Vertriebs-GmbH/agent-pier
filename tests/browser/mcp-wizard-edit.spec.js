import { test, expect } from "@playwright/test";
import { saveBar } from "../helpers/accounts-browser.js";
import { baseURL } from "../helpers/browser.js";
import { bound, stdioServer } from "./mcp-cli-fixture.js";
import { packagedServer } from "./mcp-packages-fixture.js";
import { fits, phone, wizardSetup, writes } from "./mcp-wizard-fixture.js";

const open = (page, id, step = "") =>
  page.goto(
    `${baseURL}/accounts?section=mcp-servers&item=${id}${step ? `&step=${step}` : ""}`,
  );
const detail = (page) => page.locator(".accounts-detail");

for (const [label, use] of [
  ["desktop", {}],
  ["phone", phone],
]) {
  test.describe(label, () => {
    test.use(use);

    test("the overview shows one card per step with Change", async ({ page }) => {
      await wizardSetup(page, { servers: [bound()] });
      await open(page, "s1");
      const view = detail(page);
      await expect(view.getByRole("region", { name: "Source and name" })).toContainText(
        "docs",
      );
      await expect(view.getByRole("region", { name: "Settings" })).toContainText(
        "Authorization",
      );
      await expect(view.getByRole("region", { name: "Who may use it" })).toContainText(
        "Claude Code",
      );
      await view.getByRole("button", { name: "Change: Source and name" }).click();
      await expect(page).toHaveURL(/item=s1&step=setup/);
      await fits(page);
    });

    test("set-up keeps the connection locked and saves a rename on its own", async ({
      page,
    }) => {
      const state = await wizardSetup(page, { servers: [bound()] });
      await open(page, "s1", "setup");
      const view = detail(page);
      await expect(
        view.getByText("HTTP · The connection type cannot be changed after saving."),
      ).toBeVisible();
      await view.getByLabel("Name", { exact: true }).fill("docs2");
      await expect(view.getByText(/Running sessions keep the old name/)).toBeVisible();
      await saveBar(page).getByRole("button", { name: "Save changes" }).click();
      await expect(page).toHaveURL(/item=s1$/);
      expect(writes(state)).toEqual([
        {
          method: "PUT",
          path: "/api/mcp-servers/s1",
          body: { revision: 1, name: "docs2" },
        },
      ]);
    });

    test("set-up saves the advanced timeouts and the overview names them", async ({
      page,
    }) => {
      const state = await wizardSetup(page, {
        servers: [bound({ toolTimeoutSec: 450 })],
      });
      await open(page, "s1");
      await expect(
        detail(page).getByRole("region", { name: "Source and name" }),
      ).toContainText("Tool timeout 450 s");
      await open(page, "s1", "setup");
      const view = detail(page);
      // Opens for a stored value; the startup timeout is named Codex-only.
      await expect(view.getByText("Only Codex has this setting.")).toBeVisible();
      await view.getByLabel("Startup timeout in seconds (1 to 600)").fill("30");
      await view.getByLabel("Tool timeout in seconds (1 to 3600)").fill("");
      await fits(page);
      await saveBar(page).getByRole("button", { name: "Save changes" }).click();
      await expect(page).toHaveURL(/item=s1$/);
      expect(writes(state)[0].body).toEqual({
        revision: 1,
        startupTimeoutSec: 30,
        toolTimeoutSec: null,
      });
    });

    test("a timeout that is no number is refused at its field and never clears", async ({
      page,
    }) => {
      const state = await wizardSetup(page, { servers: [bound()] });
      state.refusePut = {
        status: 400,
        json: {
          error:
            "Bitte als Tool-Timeout ganze Sekunden von 1 bis 3600 angeben oder das Feld leer lassen.",
          messageKey: "mcpServers.invalidToolTimeout",
        },
      };
      await open(page, "s1", "setup");
      const view = detail(page);
      await view.getByText("Advanced: timeouts").click();
      const tool = view.getByLabel("Tool timeout in seconds (1 to 3600)");
      await tool.fill("4s");
      await saveBar(page).getByRole("button", { name: "Save changes" }).click();
      await expect(view.getByRole("alert")).toHaveText(
        "Enter a tool timeout of 1 to 3600 whole seconds, or leave the field empty.",
      );
      expect(writes(state)[0].body).toEqual({ revision: 1, toolTimeoutSec: "4s" });
      // Correcting the value keeps the section open.
      await tool.fill("45");
      await expect(tool).toBeVisible();
      await expect(tool).toHaveValue("45");
    });

    test("leaving an edit step with changes asks first", async ({ page }) => {
      await wizardSetup(page, { servers: [bound()] });
      await open(page, "s1");
      await detail(page).getByRole("button", { name: "Change: Source and name" }).click();
      await detail(page).getByLabel("Name", { exact: true }).fill("docs2");
      await page.goBack();
      await expect(page.getByRole("dialog", { name: "Save changes?" })).toBeVisible();
      await expect(page).toHaveURL(/step=setup/);
    });

    test("settings replace a stored value without showing it", async ({ page }) => {
      const state = await wizardSetup(page, { servers: [bound()] });
      await open(page, "s1", "settings");
      const view = detail(page);
      await expect(view.getByText("Authorization")).toBeVisible();
      await view
        .getByLabel("Authorization: New value (leave empty to keep)")
        .fill("Bearer new");
      await saveBar(page).getByRole("button", { name: "Save changes" }).click();
      await expect(page).toHaveURL(/item=s1$/);
      expect(writes(state)[0].body).toEqual({
        revision: 1,
        headers: { Authorization: "Bearer new" },
      });
    });

    test("a changed command asks to run a local command", async ({ page }) => {
      const state = await wizardSetup(page, { servers: [stdioServer()] });
      await open(page, "s1", "setup");
      await detail(page).getByLabel("Command", { exact: true }).fill("node");
      await saveBar(page).getByRole("button", { name: "Save changes" }).click();
      const question = page.getByRole("alertdialog", { name: "Run a local command?" });
      await question.getByRole("button", { name: "Confirm and save" }).click();
      await expect(page).toHaveURL(/item=s1$/);
      expect(writes(state).at(-1).body).toMatchObject({
        command: "node",
        confirmStdio: true,
      });
    });

    test("connect re-binds CLIs with a diff and shows the changes", async ({ page }) => {
      const state = await wizardSetup(page, { servers: [bound()] });
      await open(page, "s1", "connect");
      const view = detail(page);
      await expect(view.getByRole("switch", { name: "Claude Code" })).toBeChecked();
      await expect(view.getByRole("switch", { name: "Codex" })).toBeChecked();
      await view.getByRole("switch", { name: "Codex" }).uncheck();
      await view.getByRole("button", { name: "Save changes" }).click();
      await expect(view.getByText("Changes saved")).toBeVisible();
      expect(writes(state)).toEqual([
        {
          method: "PUT",
          path: "/api/mcp-servers/s1",
          body: { revision: 1, clis: ["claude"] },
        },
      ]);
      await view.getByRole("button", { name: "Back to the server" }).click();
      await expect(page).toHaveURL(/item=s1$/);
    });

    test("a package that is not installed gets no new CLI", async ({ page }) => {
      await wizardSetup(page, { servers: [packagedServer("failed", { clis: [] })] });
      await open(page, "s1", "connect");
      const view = detail(page);
      await expect(view.getByRole("switch", { name: "Claude Code" })).toBeDisabled();
      await expect(
        view
          .getByText("Coding CLIs and agents can be added once the package is installed.")
          .first(),
      ).toBeVisible();
    });
  });
}
