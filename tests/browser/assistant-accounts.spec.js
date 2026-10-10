import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";
async function setup(page, ready = true) {
  await fixture(page);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const state = { accounts: [], status: "awaiting_user", checked: false, removed: false };
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    let body;
    if (path === "/api/assistant-model-accounts") body = { accounts: state.accounts };
    else if (path.endsWith("/check")) {
      state.checked = true;
      body = { status: "ok" };
    } else if (path === "/api/assistant-model-accounts/openclaw%3Atest") {
      state.removed = true;
      state.accounts = [];
      body = { accounts: [] };
    } else if (path.startsWith("/api/assistant-model-login")) {
      if (method === "DELETE") state.status = "cancelled";
      if (state.status === "completed")
        state.accounts = [
          {
            id: "openclaw:test",
            name: "Personal ChatGPT",
            status: "ok",
            available: true,
          },
        ];
      body = {
        id: "owned",
        status: state.status,
        ...(state.status === "awaiting_user"
          ? { code: "ABCD-EFGHI", url: "https://auth.openai.com/codex/device" }
          : {}),
      };
    } else if (path === "/api/assistant-runtime")
      body = { availability: ready ? "ready" : "disabled" };
    else if (path === "/api/assistants")
      body = { assistants: [], conversations: [], models: state.accounts };
    else return route.fallback();
    await route.fulfill({ json: body });
  });
  return state;
}
test("ChatGPT login shows code, completes, checks and disconnects the selected account", async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto(baseURL + "/accounts");
  const panel = page.getByRole("region", { name: "ChatGPT for agents" });
  await panel.getByRole("button", { name: "Connect ChatGPT" }).click();
  await expect(panel.getByText("ABCD-EFGHI")).toBeVisible();
  await expect(panel.getByRole("link", { name: "Open sign-in page" })).toHaveAttribute(
    "href",
    "https://auth.openai.com/codex/device",
  );
  state.status = "completed";
  await expect(panel.getByText("Personal ChatGPT")).toBeVisible();
  await expect(panel.getByText("ABCD-EFGHI")).toHaveCount(0);
  await panel.getByRole("button", { name: "Check connection" }).click();
  await expect.poll(() => state.checked).toBe(true);
  await expect(panel.getByText("Connection verified")).toBeVisible();
  await panel.getByRole("button", { name: "Disconnect" }).click();
  await expect.poll(() => state.removed).toBe(true);
  await expect(panel.getByText("Personal ChatGPT")).toHaveCount(0);
});
test("device login can be cancelled and fits mobile", async ({ page }) => {
  await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseURL + "/accounts");
  const panel = page.getByRole("region", { name: "ChatGPT for agents" });
  await panel.getByRole("button", { name: "Connect ChatGPT" }).click();
  await expect(panel.getByText("ABCD-EFGHI")).toBeVisible();
  await page.screenshot({
    path: ".cache/assistant-account-mobile-en.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await panel.getByRole("button", { name: "Cancel sign-in" }).click();
  await expect(panel.getByText("Sign-in cancelled")).toBeVisible();
  await expect(panel.getByText("ABCD-EFGHI")).toHaveCount(0);
});
test("offline account UI links to assistant service and selected ChatGPT account saves", async ({
  page,
}) => {
  const state = await setup(page, false);
  await page.goto(baseURL + "/accounts");
  const panel = page.getByRole("region", { name: "ChatGPT for agents" });
  await expect(panel.getByRole("button", { name: "Connect ChatGPT" })).toBeDisabled();
  await expect(
    panel.getByRole("link", { name: "Agent service settings" }),
  ).toHaveAttribute("href", "/settings/assistants");
  state.accounts = [{ id: "openclaw:test", name: "Personal ChatGPT", available: true }];
  let saved;
  await page.route("**/api/assistants", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    saved = route.request().postDataJSON();
    await route.fulfill({ json: { ...saved, id: "new", revision: 1 } });
  });
  await page.goto(baseURL + "/agents");
  await page.getByRole("button", { name: "New agent" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Home");
  await page.getByLabel("Model connection").selectOption("openclaw:test");
  await page.getByLabel("Model ID").fill("gpt-6-astra");
  await page.getByRole("button", { name: "Save agent" }).click();
  await expect
    .poll(() => saved?.model)
    .toEqual({ connectionId: "openclaw:test", modelId: "gpt-6-astra" });
});
test("an older account fetch cannot restore an account after disconnect", async ({
  page,
}) => {
  const state = await setup(page);
  const account = {
    id: "openclaw:test",
    name: "Personal ChatGPT",
    status: "ok",
    available: true,
  };
  state.accounts = [account];
  let release,
    captured = false,
    fetches = 0;
  await page.route("**/api/assistant-model-accounts", async (route) => {
    if (++fetches !== 2) return route.fallback();
    captured = true;
    await new Promise((resolve) => {
      release = resolve;
    });
    await route.fulfill({ json: { accounts: [account] } });
  });
  let resumeRuntime;
  const runtimeGate = new Promise((resolve) => {
    resumeRuntime = resolve;
  });
  await page.route("**/api/assistant-runtime", async (route) => {
    await runtimeGate;
    await route.fulfill({ json: { availability: "ready" } });
  });
  await page.goto(baseURL + "/accounts");
  const panel = page.getByRole("region", { name: "ChatGPT for agents" });
  await expect(panel.getByText("Personal ChatGPT")).toBeVisible();
  resumeRuntime();
  await expect.poll(() => captured).toBe(true);
  await panel.getByRole("button", { name: "Connect ChatGPT" }).click();
  state.status = "completed";
  await expect(panel.getByText("Personal ChatGPT")).toBeVisible();
  await panel.getByRole("button", { name: "Disconnect" }).click();
  await expect(panel.getByText("Personal ChatGPT")).toHaveCount(0);
  const lateResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/assistant-model-accounts"),
  );
  release();
  await (await lateResponse).finished();
  await expect.poll(() => state.removed).toBe(true);
  // Synchronize with the deliberately late response before the final assertion.
  await page.waitForTimeout(200);
  await expect(panel.getByText("Personal ChatGPT")).toHaveCount(0);
});
