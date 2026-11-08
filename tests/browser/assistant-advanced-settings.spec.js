import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";
import { DatabaseSync } from "node:sqlite";
import { AdvancedConfig } from "../../server/features/assistants/advanced-config.js";
import { OverrideStore } from "../../server/features/assistants/runtimes/openclaw/openclaw-config/overrides.js";
import { migrateAssistants } from "../../server/features/assistants/assistant-schema.js";
import { attachHermesFleet } from "../../server/features/assistants/runtimes/runtime-for.js";
import { HermesFleet } from "../../server/features/assistants/runtimes/hermes/hermes-fleet.js";

/**
 * The page talks to the real AdvancedConfig and OverrideStore (in memory, with a
 * runtime that has not started), so it sees the real six settings, bounds, options,
 * reload kinds and validation. `running` only presents the Gateway as running.
 * `restart` names paths to present as needing a restart: no 2026.9.9 path does, but
 * the prompt must work for one a later runtime reports. `hermes` names the installed
 * Hermes version while Hermes runs; `hermesAgents` how many Hermes agents exist.
 */
async function setup(
  page,
  {
    language = "en",
    running = true,
    version = null,
    restart = [],
    hermes = null,
    hermesAgents = hermes ? 1 : 0,
  } = {},
) {
  await fixture(page);
  await page.addInitScript(
    (lang) => localStorage.setItem("agentpier-language", lang),
    language,
  );
  await page.route("**/api/assistant-feature", fulfillEnabledAssistantFeature);
  const db = new DatabaseSync(":memory:");
  migrateAssistants(db);
  const overrides = new OverrideStore(db);
  overrides.set("agents.defaults.thinkingDefault", "high");
  const runtime = {
    status: () => ({ availability: version ? "failed" : "disabled", version }),
  };
  attachHermesFleet(
    runtime,
    new HermesFleet({ dataDir: null, available: () => !!hermes, version: () => hermes }),
  );
  const advanced = new AdvancedConfig({
    assistants: {
      runtime,
      admit: (operation) => operation(),
      store: {
        listAssistants: () =>
          Array.from({ length: hermesAgents }, (_, i) => ({
            id: `h${i}`,
            runtime: "hermes",
          })),
      },
    },
    overrides,
    synchronization: {},
  });
  const present = (data) => ({
    gateway: { ...data.gateway, running: running && data.gateway.qualified },
    hermes: data.hermes,
    settings: data.settings.map((setting) => ({
      ...setting,
      ...(running && { current: setting.override }),
      ...(restart.includes(setting.path) && { reloadKind: "restart" }),
    })),
  });
  const state = { puts: [] };
  await page.route("**/api/assistant-advanced-settings", async (route) => {
    const request = route.request();
    if (request.method() !== "PUT")
      return route.fulfill({ json: present(await advanced.get()) });
    const body = request.postDataJSON();
    state.puts.push(body);
    if (restart.includes(body.path) && !body.confirmRestart)
      return route.fulfill({
        status: 409,
        json: {
          code: "ASSISTANT_RESTART_REQUIRED",
          error: "Restart required",
          affected: { agents: [{ id: "a", name: "Home" }], teamMembers: 0 },
        },
      });
    try {
      await route.fulfill({ json: present(await advanced.save(body.path, body.value)) });
    } catch (error) {
      await route.fulfill({
        status: error.status || 500,
        json: { error: error.message },
      });
    }
  });
  return { state, overrides };
}

test("the owner changes and resets advanced settings on Agenten › Laufzeit", async ({
  page,
}) => {
  const { state, overrides } = await setup(page);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // The former subpage is an inline group of the Runtime tab; its old address scrolls there.
  await page.goto(baseURL + "/settings/assistants-advanced");
  await expect(page).toHaveURL(/\/agents\?tab=runtime&section=advanced$/);
  const heading = page.getByRole("heading", { name: "Advanced · for all agents" });
  await expect(heading).toBeVisible();
  // section=advanced scrolls the whole group into view. A tall viewport (the tablet)
  // ends the page before the heading reaches the top, so no fixed offset is asserted.
  await expect(page.locator("#agents-runtime-advanced")).toBeInViewport({ ratio: 1 });
  await expect(page.getByText("Tasks", { exact: true })).toBeVisible();
  await expect(page.getByText("Images and media", { exact: true })).toBeVisible();
  // All six 2026.9.9 settings apply at once; each default in the field's own unit.
  await expect(page.getByText("Immediate", { exact: true })).toHaveCount(6);
  await expect(page.getByText("Restart needed", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Default: 172,800 seconds (48 hours)")).toBeVisible();
  await expect(page.getByText("Default: 1,200 pixels")).toBeVisible();
  await expect(
    page.getByText("Default: no general cleanup (only outgoing staging files)"),
  ).toBeVisible();

  // The help is our own text, shown on demand.
  await page.getByRole("button", { name: "Media file retention" }).click();
  await expect(page.getByText(/including received images and voice notes/)).toBeVisible();

  const timeout = page.getByRole("spinbutton", { name: /Time limit per task/ });
  await timeout.fill("60");
  await expect(page.getByText(/Whole numbers from 300 to 604800/).first()).toBeVisible();
  await page.getByRole("button", { name: "Save settings" }).click();
  expect(state.puts).toEqual([]);
  await timeout.fill("900");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("button", { name: "Save settings" })).toHaveCount(0);
  // The bar's button reads "Saving …" while the save runs, so wait for the store.
  await expect
    .poll(() => overrides.get("agents.defaults.timeoutSeconds")?.value)
    .toBe(900);
  expect(state.puts).toEqual([{ path: "agents.defaults.timeoutSeconds", value: 900 }]);

  // The image rows: our option labels and the narrowed size range.
  const quality = page.getByRole("combobox", { name: /Image quality/ });
  await expect(quality.locator("option")).toHaveText([
    "Default (Automatic)",
    "Automatic",
    "Efficient",
    "Balanced",
    "High",
  ]);
  await quality.selectOption("high");
  const size = page.getByRole("spinbutton", { name: /Maximum image size/ });
  await size.fill("4000");
  await expect(page.getByText(/Whole numbers from 256 to 2000/).first()).toBeVisible();
  await size.fill("1600");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("button", { name: "Save settings" })).toHaveCount(0);
  await expect
    .poll(() => state.puts.slice(1), { message: JSON.stringify(state.puts) })
    .toEqual([
      { path: "agents.defaults.imageQuality", value: "high" },
      { path: "agents.defaults.imageMaxDimensionPx", value: 1600 },
    ]);
  expect(overrides.get("agents.defaults.imageMaxDimensionPx")?.value).toBe(1600);

  // "Default" resets a stored value; the select lists every thinking level.
  const thinking = page.getByRole("combobox", { name: /Thinking level/ });
  await expect(thinking).toHaveValue("high");
  await expect(thinking.locator("option")).toHaveCount(10);
  await page.getByRole("button", { name: "Reset Thinking level to the default" }).click();
  await expect(thinking).toHaveValue("");
  await expect(thinking.locator("option").first()).toHaveText(
    "Default (depends on the model)",
  );
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect
    .poll(() => state.puts.at(-1))
    .toEqual({ path: "agents.defaults.thinkingDefault", value: null });
  expect(overrides.get("agents.defaults.thinkingDefault")).toBe(null);
  expect(errors).toEqual([]);
});

test("a setting that needs a restart asks first and then restarts", async ({ page }) => {
  // No 2026.9.9 path needs a restart; the prompt must still work for one that does.
  const { state } = await setup(page, { restart: ["attachments.ttlHours"] });
  await page.goto(baseURL + "/settings/assistants-advanced");
  await expect(page.getByText("Restart needed", { exact: true })).toHaveCount(1);
  await page.getByRole("spinbutton", { name: /Media file retention/ }).fill("72");
  await page.getByRole("button", { name: "Save settings" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Restart the agent service?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/Home/)).toBeVisible();
  await dialog.getByRole("button", { name: "Save and restart" }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() => state.puts)
    .toEqual([
      { path: "attachments.ttlHours", value: 72 },
      { path: "attachments.ttlHours", value: 72, confirmRestart: true },
    ]);
});

test("German on a phone: own labels, no sideways scroll, inline on Laufzeit", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page, { language: "de", running: false });
  await page.goto(baseURL + "/settings/assistants-advanced");
  await expect(
    page.getByRole("heading", { name: "Erweitert · für alle Agenten" }),
  ).toBeInViewport();
  await expect(page.getByText(/Der Agentendienst läuft gerade nicht/)).toBeVisible();
  await expect(page.getByText("Zeitlimit pro Auftrag")).toBeVisible();
  await expect(page.getByText("Standard: 172.800 Sekunden (48 Stunden)")).toBeVisible();
  await expect(page.getByText("Standard: Zeitzone dieses Rechners")).toBeVisible();
  await expect(page.getByText("Bildqualität", { exact: true })).toBeVisible();
  await expect(page.getByText("Sofort", { exact: true })).toHaveCount(6);
  // No English upstream label reaches the German page.
  await expect(
    page.getByText(/Agent Timeout|Thinking Default|Attachment Retention|Image Quality/),
  ).toHaveCount(0);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.getByRole("tab", { name: "Laufzeit" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("an unapproved runtime keeps every setting read-only", async ({ page }) => {
  await setup(page, { version: "2026.9.8" });
  await page.goto(baseURL + "/settings/assistants-advanced");
  await expect(page.getByText(/2026\.9\.8 is not approved/)).toBeVisible();
  await expect(
    page.getByRole("spinbutton", { name: /Time limit per task/ }),
  ).toBeDisabled();
  await expect(page.getByRole("combobox", { name: /Thinking level/ })).toBeDisabled();
  await expect(
    page.getByText("Not available with the installed agent runtime"),
  ).toHaveCount(6);
});

for (const phone of [false, true])
  test(`with Hermes agents, settings Hermes has no equivalent of say so${phone ? " on a phone" : ""}`, async ({
    page,
  }) => {
    if (phone) await page.setViewportSize({ width: 390, height: 844 });
    const { state } = await setup(page, { hermes: "0.22.5" });
    await page.goto(baseURL + "/settings/assistants-advanced");
    await expect(
      page.getByText("Settings without “OpenClaw only” also apply to Hermes agents."),
    ).toBeVisible();
    // Thinking level and time zone reach Hermes agents, the time zone with a restart
    // of theirs; the other four do not reach them.
    await expect(page.getByText("OpenClaw only", { exact: true })).toHaveCount(4);
    await expect(page.getByText("Restarts Hermes agents", { exact: true })).toHaveCount(
      1,
    );
    for (const [name, pill] of [
      ["Time limit per task", "OpenClaw only"],
      ["Thinking level", null],
      ["Time zone", "Restarts Hermes agents"],
      ["Image quality", "OpenClaw only"],
      ["Maximum image size", "OpenClaw only"],
      ["Media file retention", "OpenClaw only"],
    ])
      await expect(
        page
          .locator(".advanced-setting-row")
          .filter({ hasText: name })
          .locator(".advanced-setting-badge.scope"),
      ).toHaveText(pill ? [pill] : []);
    await page.getByRole("button", { name: "Thinking level", exact: true }).click();
    await expect(page.getByText(/no “Adaptive” level/)).toBeVisible();
    await page.getByRole("combobox", { name: /Time zone/ }).selectOption("Asia/Tokyo");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect
      .poll(() => state.puts)
      .toEqual([{ path: "agents.defaults.userTimezone", value: "Asia/Tokyo" }]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

test("a Hermes version the mapping is not approved for is named", async ({ page }) => {
  await setup(page, { hermes: "0.23.0" });
  await page.goto(baseURL + "/settings/assistants-advanced");
  await expect(page.getByText(/Hermes Agent 0\.23\.0 is not approved/)).toBeVisible();
  // That version takes none of them, so nothing restarts it; OpenClaw-only stays.
  await expect(page.getByText("Restarts Hermes agents", { exact: true })).toHaveCount(0);
  await expect(page.getByText("OpenClaw only", { exact: true })).toHaveCount(4);
  // OpenClaw's settings stay editable.
  await expect(page.getByRole("combobox", { name: /Thinking level/ })).toBeEnabled();
});

for (const [label, options] of [
  ["without Hermes", {}],
  ["with Hermes but no Hermes agent", { hermes: "0.22.5", hermesAgents: 0 }],
])
  test(`${label} the page names no runtime per setting`, async ({ page }) => {
    await setup(page, options);
    await page.goto(baseURL + "/settings/assistants-advanced");
    await expect(page.getByText("Tasks", { exact: true })).toBeVisible();
    await expect(page.locator(".advanced-setting-badge.scope")).toHaveCount(0);
    await expect(
      page.getByText(/apply to Hermes agents|Hermes Agent .* approved/),
    ).toHaveCount(0);
  });
