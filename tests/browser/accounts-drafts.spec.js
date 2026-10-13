import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import {
  accountDetail,
  accountRow,
  backToAccounts,
  openAccountItem,
  saveBar,
} from "../helpers/accounts-browser.js";
import { fixture } from "./providers-fixture.js";

test.use({ locale: "en-GB" });

const router = {
  id: "c1",
  name: "Agent router",
  providerId: "openrouter",
  hasSecret: true,
  launchable: true,
  tools: ["codex"],
};
const other = { ...router, id: "c2", name: "Second router" };

async function setup(page) {
  const controls = await fixture(page);
  controls.state.providerConnections = [router, other];
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  return controls;
}

test("the bar appears only while a subpage has changes", async ({ page }) => {
  await setup(page);
  await page.goto(baseURL + "/accounts");
  const detail = await openAccountItem(page, "Agent router");
  await expect(saveBar(page)).toHaveCount(0);
  await detail.getByLabel("Connection name", { exact: true }).fill("Agent router 2");
  await expect(saveBar(page)).toBeVisible();
  const bar = saveBar(page);
  const save = bar.getByRole("button", { name: "Save connection", exact: true });
  const box = await save.boundingBox();
  expect(Math.round(box.height)).toBe(40);
  await bar.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(saveBar(page)).toHaveCount(0);
  await expect(detail.getByLabel("Connection name", { exact: true })).toHaveValue(
    "Agent router",
  );
});

test("switching entries with changes asks; cancel stays, discard switches", async ({
  page,
}) => {
  await setup(page);
  await page.goto(baseURL + "/accounts");
  const detail = await openAccountItem(page, "Agent router");
  await detail.getByLabel("Connection name", { exact: true }).fill("Changed");
  await accountRow(page, "Second router").click();
  const sheet = page.getByRole("dialog", { name: "Save changes?" });
  await expect(sheet).toContainText("1 change in Agent router is not saved yet.");
  await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page).toHaveURL(/item=c1/);
  await expect(detail.getByLabel("Connection name", { exact: true })).toHaveValue(
    "Changed",
  );
  await accountRow(page, "Second router").click();
  await page.getByRole("dialog").getByRole("button", { name: "Discard" }).click();
  await expect(page).toHaveURL(/item=c2/);
});

test("save and switch saves first, then opens the other entry", async ({ page }) => {
  const controls = await setup(page);
  await page.goto(baseURL + "/accounts");
  const detail = await openAccountItem(page, "Agent router");
  await detail.getByLabel("Connection name", { exact: true }).fill("Renamed");
  await accountRow(page, "Second router").click();
  await page.getByRole("button", { name: "Save and switch" }).click();
  await expect(page).toHaveURL(/item=c2/);
  expect(controls.calls.filter((call) => call.method === "PATCH").at(-1).body).toEqual({
    name: "Renamed",
  });
});

test("a failed save keeps the changes and reports in the bar", async ({ page }) => {
  const controls = await setup(page);
  await page.goto(baseURL + "/accounts");
  const detail = await openAccountItem(page, "Agent router");
  await detail.getByLabel("Connection name", { exact: true }).fill("Failing");
  controls.failConnection = true;
  await saveBar(page).getByRole("button", { name: "Save connection" }).click();
  await expect(saveBar(page).getByRole("alert")).toContainText(
    "Fixture connection conflict",
  );
  await expect(detail.getByLabel("Connection name", { exact: true })).toHaveValue(
    "Failing",
  );
});

test("phones ask before Back leaves a changed subpage", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.goto(baseURL + "/accounts?section=models&item=c1");
  await expect(
    page.getByRole("heading", { name: "Agent router", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("Accounts · Model access")).toBeVisible();
  await accountDetail(page)
    .getByLabel("Connection name", { exact: true })
    .fill("Changed");
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("dialog", { name: "Save changes?" })).toBeVisible();
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(page).toHaveURL(`${baseURL}/accounts?section=models`);
  await expect(accountRow(page, "Agent router")).toBeVisible();
});

test("leaving the page with changes is held by beforeunload", async ({ page }) => {
  await setup(page);
  await page.goto(baseURL + "/accounts?section=models&item=c1");
  await accountDetail(page)
    .getByLabel("Connection name", { exact: true })
    .fill("Changed");
  let asked = false;
  page.on("dialog", async (dialog) => {
    asked = dialog.type() === "beforeunload";
    await dialog.dismiss();
  });
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => asked).toBe(true);
});

test("creating lands on the new entry without a prompt", async ({ page }) => {
  const controls = await setup(page);
  await page.goto(baseURL + "/accounts");
  await page
    .getByRole("button", { name: "Add provider connection", exact: true })
    .click();
  await expect(page).toHaveURL(/section=models&item=new/);
  const detail = accountDetail(page);
  await detail.getByLabel("Connection name", { exact: true }).fill("Fresh");
  await detail.getByLabel("API key", { exact: true }).fill("fixture-key");
  await saveBar(page).getByRole("button", { name: "Save connection" }).click();
  await expect(page).toHaveURL(/section=models&item=connection-one/);
  await expect(page.getByRole("dialog", { name: "Save changes?" })).toHaveCount(0);
  await page.goBack();
  await expect(page).not.toHaveURL(/item=new/);
  expect(controls.calls.filter((call) => call.method === "POST").length).toBe(1);
});

test("a restart note names how many agents restart", async ({ page }) => {
  const controls = await setup(page);
  controls.usage = {
    agentsEnabled: true,
    connections: {
      c1: {
        agents: [
          { id: "a", name: "Olli", kind: "agent", via: "model" },
          { id: "b", name: "Tmp", kind: "teamMember", via: "model" },
        ],
        sessions: 0,
        pipelineProfiles: [],
        clis: [],
      },
    },
    chatgpt: {},
    mcpServers: {},
    webSearch: null,
    speech: null,
    cliAccounts: {},
  };
  await page.route("**/api/assistant-feature", (route) =>
    fulfillEnabledAssistantFeature(route),
  );
  await page.goto(baseURL + "/accounts");
  const detail = await openAccountItem(page, "Agent router");
  await expect(detail.getByRole("link", { name: /^Olli/ })).toHaveAttribute(
    "href",
    "/agents/a/settings",
  );
  await expect(detail.getByText("Temporary team member")).toBeVisible();
  await detail.getByLabel("Connection name", { exact: true }).fill("Changed");
  await expect(saveBar(page)).toContainText("Briefly restarts 2 agents.");
});

test("a speech change made elsewhere offers reload and overwrite", async ({ page }) => {
  await setup(page);
  let revision = 0;
  const puts = [];
  await page.route("**/api/assistant-feature", (route) =>
    fulfillEnabledAssistantFeature(route),
  );
  await page.route("**/api/assistant-speech", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        json: { revision, model: "nova-3", language: "auto", hasSecret: false },
      });
    const body = route.request().postDataJSON();
    puts.push(body);
    if (body.revision !== revision)
      return route.fulfill({
        status: 409,
        json: { error: "Changed elsewhere", messageKey: "assistants.conflict" },
      });
    revision += 1;
    return route.fulfill({
      json: { revision, model: body.model, language: body.language, hasSecret: false },
    });
  });
  await page.goto(baseURL + "/accounts");
  const detail = await openAccountItem(page, "Speech recognition");
  await detail.getByLabel("Recognition model").fill("nova-4");
  // Someone else saves meanwhile: the server is at revision 7 now.
  revision = 7;
  await saveBar(page).getByRole("button", { name: "Save speech settings" }).click();
  await expect(saveBar(page).getByRole("alert")).toContainText("Changed elsewhere");
  expect(puts[0].revision).toBe(0);
  // The conflict re-read the settings, so overwriting sends the newer revision.
  await saveBar(page).getByRole("button", { name: "Overwrite anyway" }).click();
  await expect.poll(() => puts.at(-1)?.revision).toBe(7);
  await expect(saveBar(page)).toHaveCount(0);
  expect(puts.at(-1).model).toBe("nova-4");
});

test("the agents-off detail lists no agents in Used by", async ({ page }) => {
  const controls = await setup(page);
  controls.usage = {
    agentsEnabled: false,
    connections: {
      c1: {
        agents: [{ id: "a", name: "Olli", kind: "agent", via: "model" }],
        sessions: 2,
        pipelineProfiles: [],
        clis: [],
      },
    },
    chatgpt: {},
    mcpServers: {},
    webSearch: null,
    speech: null,
    cliAccounts: {},
  };
  await page.goto(baseURL + "/accounts");
  const detail = await openAccountItem(page, "Agent router");
  await expect(detail.getByText("2 sessions")).toBeVisible();
  await expect(detail.getByRole("link", { name: /^Olli/ })).toHaveCount(0);
  await expect(detail.getByRole("group", { name: "Compatible CLIs" })).toContainText(
    "Codex",
  );
  await backToAccounts(page);
});
