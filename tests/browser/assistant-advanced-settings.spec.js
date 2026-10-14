import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";

const settings = () => [
  {
    id: "runTimeout",
    path: "agents.defaults.timeoutSeconds",
    group: "runs",
    type: "integer",
    unit: "seconds",
    minimum: 60,
    maximum: 604800,
    fallback: 172800,
    override: null,
    current: null,
    reloadKind: "hot",
    available: true,
  },
  {
    id: "thinkingDefault",
    path: "agents.defaults.thinkingDefault",
    group: "runs",
    type: "string",
    options: ["off", "low", "medium", "high"],
    fallback: null,
    override: "high",
    current: "high",
    reloadKind: "hot",
    available: true,
  },
  {
    id: "userTimezone",
    path: "agents.defaults.userTimezone",
    group: "runs",
    type: "string",
    format: "timeZone",
    fallback: null,
    override: null,
    current: null,
    reloadKind: "hot",
    available: true,
  },
  {
    id: "mediaRetention",
    path: "attachments.ttlHours",
    group: "media",
    type: "integer",
    unit: "hours",
    minimum: 1,
    maximum: 168,
    fallback: null,
    override: null,
    current: null,
    reloadKind: "restart",
    available: true,
  },
];

async function setup(page, { language = "en", gateway = {} } = {}) {
  await fixture(page);
  await page.addInitScript(
    (lang) => localStorage.setItem("agentpier-language", lang),
    language,
  );
  await page.route("**/api/assistant-feature", fulfillEnabledAssistantFeature);
  const state = {
    puts: [],
    data: {
      gateway: { running: true, version: "2026.9.9", qualified: true, ...gateway },
      // The server offers nothing to edit on a runtime the list was not qualified for.
      settings: settings().map((s) => ({ ...s, available: gateway.qualified !== false })),
    },
  };
  await page.route("**/api/assistant-advanced-settings", async (route) => {
    const request = route.request();
    if (request.method() === "PUT") {
      const body = request.postDataJSON();
      state.puts.push(body);
      const setting = state.data.settings.find((s) => s.path === body.path);
      if (setting.reloadKind === "restart" && !body.confirmRestart)
        return route.fulfill({
          status: 409,
          json: {
            code: "ASSISTANT_RESTART_REQUIRED",
            error: "Restart required",
            affected: { agents: [{ id: "a", name: "Home" }], teamMembers: 0 },
          },
        });
      setting.override = body.value;
      setting.current = body.value;
    }
    await route.fulfill({ json: state.data });
  });
  return state;
}

test("the owner changes and resets advanced settings from the agent service", async ({
  page,
}) => {
  const state = await setup(page);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(baseURL + "/settings/assistants");
  await page.getByRole("link", { name: /Advanced settings/ }).click();
  await expect(page).toHaveURL(/\/settings\/assistants-advanced$/);
  await expect(
    page.getByRole("heading", { name: "Advanced", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Tasks", { exact: true })).toBeVisible();
  await expect(page.getByText("Images and media", { exact: true })).toBeVisible();
  await expect(page.getByText("Default: 48 hours")).toBeVisible();
  await expect(page.getByText("Immediate", { exact: true })).toHaveCount(3);
  await expect(page.getByText("Restart needed", { exact: true })).toHaveCount(1);

  // The help is our own text, shown on demand.
  await page.getByRole("button", { name: "Time limit per task" }).click();
  await expect(page.getByText(/How long an agent may work on one message/)).toBeVisible();

  const timeout = page.getByRole("spinbutton", { name: /Time limit per task/ });
  await timeout.fill("10");
  await expect(page.getByText(/Whole numbers from 60 to 604800/).first()).toBeVisible();
  await page.getByRole("button", { name: "Save settings" }).click();
  expect(state.puts).toEqual([]);
  await timeout.fill("900");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("button", { name: "Save settings" })).toHaveCount(0);
  expect(state.puts).toEqual([{ path: "agents.defaults.timeoutSeconds", value: 900 }]);

  // "Default" resets a stored value; the select names the model-dependent default.
  const thinking = page.getByRole("combobox", { name: /Thinking level/ });
  await expect(thinking).toHaveValue("high");
  await page.getByRole("button", { name: "Reset Thinking level to the default" }).click();
  await expect(thinking).toHaveValue("");
  await expect(thinking.locator("option").first()).toHaveText(
    "Default (depends on the model)",
  );
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect
    .poll(() => state.puts.at(-1))
    .toEqual({
      path: "agents.defaults.thinkingDefault",
      value: null,
    });
  expect(errors).toEqual([]);
});

test("a setting that needs a restart asks first and then restarts", async ({ page }) => {
  const state = await setup(page);
  await page.goto(baseURL + "/settings/assistants-advanced");
  await page.getByRole("spinbutton", { name: /Media file retention/ }).fill("24");
  await page.getByRole("button", { name: "Save settings" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Restart the agent service?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/Home/)).toBeVisible();
  await dialog.getByRole("button", { name: "Save and restart" }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() => state.puts)
    .toEqual([
      { path: "attachments.ttlHours", value: 24 },
      { path: "attachments.ttlHours", value: 24, confirmRestart: true },
    ]);
});

test("German on a phone: own labels, no sideways scroll, back to the agent service", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page, { language: "de", gateway: { running: false } });
  await page.goto(baseURL + "/settings/assistants-advanced");
  await expect(
    page.getByRole("heading", { name: "Erweitert", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Der Agentendienst läuft gerade nicht/)).toBeVisible();
  await expect(page.getByText("Zeitlimit pro Auftrag")).toBeVisible();
  await expect(page.getByText("Standard: Zeitzone dieses Rechners")).toBeVisible();
  await expect(page.getByText("Neustart nötig", { exact: true })).toBeVisible();
  // No English upstream label reaches the German page.
  await expect(
    page.getByText(/Agent Timeout|Thinking Default|Attachment Retention/),
  ).toHaveCount(0);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.getByRole("button", { name: "Zurück zu Agentendienst" }).click();
  await expect(page).toHaveURL(/\/settings\/assistants$/);
});

test("an unapproved runtime keeps every setting read-only", async ({ page }) => {
  await setup(page, { gateway: { version: "2026.9.8", qualified: false } });
  await page.goto(baseURL + "/settings/assistants-advanced");
  await expect(page.getByText(/2026\.9\.8 is not approved/)).toBeVisible();
  await expect(
    page.getByRole("spinbutton", { name: /Time limit per task/ }),
  ).toBeDisabled();
  await expect(page.getByRole("combobox", { name: /Thinking level/ })).toBeDisabled();
});
