// tests/browser/endpoint-routing.spec.js
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fixture } from "./providers-fixture.js";

test.use({ locale: "en-GB" });

async function openNewEndpoint(page) {
  const controls = await fixture(page);
  await page.goto(baseURL + "/accounts");
  await page
    .getByRole("button", { name: "Add provider connection", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Connection name", { exact: true }).fill("GPU box");
  await dialog.getByLabel("API provider", { exact: true }).selectOption("endpoint");
  await dialog.getByLabel("Server type", { exact: true }).selectOption("llamacpp");
  return { controls, dialog };
}

test("routes resolve live and explain unavailable choices", async ({ page }) => {
  const { controls, dialog } = await openNewEndpoint(page);
  const routing = dialog.getByRole("group", { name: "CLIs and routes", exact: true });
  const uses = (text) => routing.getByText(`Uses: ${text}`, { exact: true });
  // llama.cpp preset: only Chat Completions is enabled.
  await expect(uses("via adapter · Chat Completions")).toHaveCount(2);
  await expect(uses("native")).toHaveCount(1);
  const claude = routing.getByLabel("Route for Claude Code", { exact: true });
  await expect(claude.locator('option[value="native"]')).toBeDisabled();
  await expect(claude.locator('option[value="adapter:responses"]')).toBeDisabled();
  const responses = dialog.getByRole("checkbox", { name: /OpenAI Responses/ });
  await responses.check();
  await claude.selectOption("adapter:responses");
  await expect(uses("via adapter · Responses")).toBeVisible();
  // Review Focus 2: the explicit choice survives when its protocol is switched off again.
  await responses.uncheck();
  await expect(claude).toHaveValue("adapter:responses");
  await expect(
    routing.getByText("Not available: protocol not enabled", { exact: true }),
  ).toBeVisible();
  await expect(uses("not offered")).toBeVisible();
  await dialog.getByRole("button", { name: "Save connection", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const created = controls.calls
    .filter((call) => call.path === "/api/provider-connections" && call.method === "POST")
    .at(-1).body;
  expect(created.endpoint.protocols.responses).toBe(false);
  expect(created.endpoint.routing).toEqual({
    claude: "adapter:responses",
    codex: "auto",
    opencode: "auto",
  });
});
