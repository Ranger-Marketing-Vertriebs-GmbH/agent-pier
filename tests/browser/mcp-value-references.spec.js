import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { openAdd, setup } from "./mcp-cli-fixture.js";

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
  const state = await setup(page);
  state.handle = async ({ route, request, path }) =>
    path === "/api/mcp-servers" && request.method() === "POST"
      ? route.fulfill(refusal("headers", ["Authorization"]))
      : false;
  await page.goto(baseURL + "/accounts");
  const dialog = await openAdd(page);
  await dialog.getByLabel("Name", { exact: true }).fill("docs");
  await dialog.getByLabel("Address").fill("https://mcp.example.test/mcp");
  const headers = dialog.getByRole("group", { name: "Headers" });
  await headers.getByRole("button", { name: "Add entry" }).click();
  await headers.getByLabel("Name", { exact: true }).fill("Authorization");
  await headers.getByLabel("Value", { exact: true }).fill("Bearer ${TOKEN}");
  await dialog.getByRole("button", { name: "Save server" }).click();
  const alert = headers.getByRole("alert");
  await expect(alert).toHaveText(`${message} Affected: Authorization`);
  await expect(headers).toHaveAccessibleDescription(`${message} Affected: Authorization`);
  await expect(dialog).toBeVisible();
  // The general error line stays empty: the message belongs to its field.
  await expect(dialog.getByRole("alert")).toHaveCount(1);
  await headers.getByLabel("Value", { exact: true }).fill("Bearer literal");
  await expect(alert).toHaveCount(0);
});

test("a working directory with a reference is refused at that field", async ({
  page,
}) => {
  const state = await setup(page);
  state.handle = async ({ route, request, path }) =>
    path === "/api/mcp-servers" && request.method() === "POST"
      ? route.fulfill(refusal("cwd"))
      : false;
  await page.goto(baseURL + "/accounts");
  const dialog = await openAdd(page);
  await dialog.getByLabel("Name", { exact: true }).fill("local");
  await dialog.getByRole("radio", { name: "Local command (stdio)" }).check();
  await dialog.getByRole("textbox", { name: /^Command/ }).fill("/usr/bin/true");
  const cwd = dialog.getByLabel("Working directory");
  await cwd.fill("${HOME}/work");
  await dialog.getByRole("button", { name: "Save server" }).click();
  await expect(cwd).toHaveAttribute("aria-invalid", "true");
  await expect(cwd).toHaveAccessibleDescription(message);
  await expect(dialog.getByRole("alert")).toHaveText(message);
  await cwd.fill("/work");
  await expect(cwd).not.toHaveAttribute("aria-invalid", "true");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
});
