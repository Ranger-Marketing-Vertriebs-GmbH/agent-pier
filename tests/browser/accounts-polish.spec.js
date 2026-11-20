import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { accountDetail, accountRow } from "../helpers/accounts-browser.js";
import { fixture } from "./providers-fixture.js";

// CLI accounts polish (AGENTPIER-399).
test.use({ locale: "en-GB" });

async function setup(page, accounts) {
  const controls = await fixture(page);
  controls.state.accounts = accounts;
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  return controls;
}

test("a long account name wraps, Enter saves and the help fits the CLI", async ({
  page,
}) => {
  const long = "W3B" + "Y".repeat(97);
  const controls = await setup(page, [
    { id: "managed-claude", name: long, tool: "claude", kind: "managed" },
  ]);
  controls.state.sessions = [];
  await page.goto(baseURL + "/accounts?section=cli&item=managed-claude");
  const detail = accountDetail(page);
  const name = detail.getByLabel("Account name", { exact: true });
  await expect(name).toHaveValue(long);
  expect(
    await page.evaluate(
      () => document.scrollingElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBe(0);
  // Claude Code's key is an Anthropic key, not OpenCode's OpenAI note.
  await expect(detail.getByText(/Anthropic API key/)).toBeVisible();
  await expect(detail.getByText(/For OpenCode/)).toHaveCount(0);
  // The form groups its fields without the browser's groove border.
  expect(
    await detail
      .locator("form fieldset")
      .first()
      .evaluate((fieldset) => getComputedStyle(fieldset).borderTopStyle),
  ).toBe("none");
  await name.fill("Work Claude");
  await name.press("Enter");
  await expect
    .poll(() =>
      controls.calls.some(
        (call) => call.method === "PATCH" && call.body?.name === "Work Claude",
      ),
    )
    .toBe(true);
});

test("a row value such as Sessions stays one word", async ({ page }) => {
  const controls = await setup(page, [
    {
      id: "managed-claude",
      name: "claude test",
      tool: "claude",
      kind: "managed",
    },
  ]);
  controls.usage = {
    agentsEnabled: false,
    connections: {},
    chatgpt: {},
    mcpServers: {},
    cliAccounts: {
      "managed-claude": { agents: [], sessions: 1, pipelineProfiles: [], clis: [] },
    },
  };
  await page.goto(baseURL + "/accounts?section=cli");
  const row = accountRow(page, "claude test");
  const value = row.locator(".list-row-value");
  await expect(value).toHaveText("Sessions");
  // The row's value is a single word; it takes one line.
  const lines = await value.evaluate((element) => {
    const height = parseFloat(getComputedStyle(element).lineHeight) || 18;
    return Math.round(element.getBoundingClientRect().height / height);
  });
  expect(lines).toBeLessThanOrEqual(1);
});

test("the LOCAL badge is at least 11px", async ({ page }) => {
  await setup(page, []);
  await page.goto(baseURL + "/accounts");
  const badge = page.locator(".local-badge").first();
  await expect(badge).toBeVisible();
  expect(
    await badge.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
  ).toBeGreaterThanOrEqual(11);
});
