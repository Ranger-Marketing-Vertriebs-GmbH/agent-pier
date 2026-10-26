import { test, expect } from "@playwright/test";
import { accountDetail, saveBar } from "../helpers/accounts-browser.js";
import { baseURL } from "../helpers/browser.js";
import { header, openAdd } from "./mcp-cli-fixture.js";
import { chooseSource, primary, wizardSetup, writes } from "./mcp-wizard-fixture.js";

const message =
  "AgentPier stores values literally. The CLIs would each resolve references such as ${…}, {env:…} or {file:…} differently, and agents not at all; enter the value itself.";
const refusal = (field, names = []) => ({
  status: 400,
  json: {
    code: "MCP_SERVER_VALUE_REFERENCE",
    field,
    names,
    error: "AgentPier speichert Werte wörtlich.",
    messageKey: "mcpServers.valueReference",
  },
});

test("a header value with a reference is refused at the headers, in English", async ({
  page,
}) => {
  const state = await wizardSetup(page, { servers: [header()] });
  state.refusePut = refusal("headers", ["Authorization"]);
  await page.goto(`${baseURL}/accounts?section=mcp-servers&item=s1&step=settings`);
  const view = accountDetail(page);
  const headers = view.getByRole("group", { name: "Headers" });
  const value = headers.getByLabel("Authorization: New value (leave empty to keep)");
  await value.fill("Bearer ${TOKEN}");
  await saveBar(page).getByRole("button", { name: "Save changes" }).click();
  const alert = headers.getByRole("alert");
  await expect(alert).toHaveText(`${message} Affected: Authorization`);
  await expect(headers).toHaveAccessibleDescription(`${message} Affected: Authorization`);
  await expect(value).toHaveAttribute("aria-invalid", "true");
  await expect(page).toHaveURL(/step=settings/);
  // The general error line stays empty: the message belongs to its field.
  await expect(view.getByRole("alert")).toHaveCount(1);
  await value.fill("Bearer literal");
  await expect(alert).toHaveCount(0);
  await expect(value).not.toHaveAttribute("aria-invalid", "true");
});

test("the wizard refuses a header reference before anything is sent", async ({
  page,
}) => {
  const state = await wizardSetup(page);
  await page.goto(baseURL + "/connections?section=mcp-servers");
  const wizard = await openAdd(page);
  await chooseSource(wizard, "Server on the internet");
  await wizard.getByLabel("Name", { exact: true }).fill("docs");
  await wizard
    .getByLabel("Address", { exact: true })
    .fill("https://mcp.example.test/mcp");
  await wizard.getByRole("radio", { name: /API key or token/ }).check();
  await wizard.getByLabel("Token", { exact: true }).fill("abc");
  await primary(wizard).click();
  await expect(
    wizard.getByRole("heading", { level: 1, name: "Settings for docs" }),
  ).toBeFocused();
  await wizard.getByRole("button", { name: "Add a header" }).click();
  const row = wizard.locator(".mcp-setting");
  await row.getByLabel("Name", { exact: true }).fill("X-Key");
  await row.getByLabel("Value", { exact: true }).fill("${TOKEN}");
  await expect(row.getByRole("alert")).toHaveText(
    "This value points to another setting (${…}). Type the real value here.",
  );
  await primary(wizard).click();
  await expect(page).toHaveURL(/step=settings/);
  expect(writes(state)).toEqual([]);
});

test("a working directory with a reference is refused at that field", async ({
  page,
}) => {
  const state = await wizardSetup(page);
  state.refuseCreate = refusal("cwd");
  await page.goto(baseURL + "/connections?section=mcp-servers");
  const wizard = await openAdd(page);
  await chooseSource(wizard, /Own command/);
  await wizard.getByLabel("Name", { exact: true }).fill("local");
  await wizard.getByLabel("Command").fill("uvx");
  await expect(primary(wizard)).toBeEnabled();
  await primary(wizard).click();
  await wizard.getByText(/^Arguments and working directory/).click();
  const cwd = wizard.getByLabel(
    "Working directory (optional, absolute path or agent placeholder)",
  );
  await cwd.fill("${HOME}/work");
  await primary(wizard).click();
  await wizard.getByRole("button", { name: "Allow and save" }).click();
  await expect(page).toHaveURL(/step=settings/);
  await expect(cwd).toHaveAttribute("aria-invalid", "true");
  await expect(cwd).toHaveAccessibleDescription(message);
  await expect(wizard.getByRole("alert")).toHaveText(message);
  await cwd.fill("/work");
  await expect(cwd).not.toHaveAttribute("aria-invalid", "true");
  await expect(wizard.getByRole("alert")).toHaveCount(0);
});
