import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { openAdd, setup, stdioServer } from "./mcp-cli-fixture.js";

test("a change that rules out a bound CLI says that saving removes it there", async ({
  page,
}) => {
  const state = await setup(page, { servers: [stdioServer()] });
  state.handle = async ({ route, request, path, body }) => {
    if (path === "/api/mcp-servers/s1" && request.method() === "PUT") {
      state.servers[0] = { ...state.servers[0], cwd: body.cwd, clis: body.clis };
      return route.fulfill({ json: state.servers[0] });
    }
    return false;
  };
  await page.goto(baseURL + "/accounts");
  await page.getByRole("button", { name: "Edit docs" }).click();
  const dialog = page.getByRole("dialog");
  const claude = dialog.getByRole("checkbox", { name: "Claude Code" });
  await expect(claude).toBeChecked();
  const notes = dialog.locator(".mcp-cli-notes");
  await expect(notes).toHaveAttribute("aria-live", "polite");
  await expect(notes).toBeEmpty();
  await dialog.getByLabel("Working directory").fill("/tmp");
  await expect(claude).toBeDisabled();
  await expect(dialog.getByText(/^Claude Code cannot start/)).toBeVisible();
  await expect(notes).toHaveText("Saving removes docs from Claude Code.");
  await dialog.getByLabel("Working directory").fill("");
  await expect(claude).toBeChecked();
  await expect(notes).toBeEmpty();
  await dialog.getByLabel("Working directory").fill("/tmp");
  await expect(notes).toHaveText("Saving removes docs from Claude Code.");
  await dialog.getByRole("button", { name: "Save server" }).click();
  await expect(dialog).toHaveCount(0);
  const writes = state.requests.filter((r) => r.method !== "GET");
  expect(writes[0].body).toMatchObject({ cwd: "/tmp", clis: ["codex"] });
});

test("a CLI that drops out of the choice is named, not silently unchecked", async ({
  page,
}) => {
  await setup(page);
  await page.goto(baseURL + "/accounts");
  const dialog = await openAdd(page);
  const notes = dialog.locator(".mcp-cli-notes");
  await dialog.getByRole("checkbox", { name: "Codex" }).check();
  await dialog.getByRole("radio", { name: "SSE", exact: true }).check();
  await expect(dialog.getByRole("checkbox", { name: "Codex" })).toBeDisabled();
  await expect(notes).toHaveText("Codex will not get this server.");
  await dialog.getByRole("radio", { name: "Local command (stdio)" }).check();
  await expect(dialog.getByRole("checkbox", { name: "Codex" })).toBeChecked();
  await expect(notes).toBeEmpty();
  await dialog.getByRole("checkbox", { name: "Claude Code" }).check();
  await dialog.getByLabel("Working directory").fill("/tmp");
  await expect(notes).toHaveText("Claude Code will not get this server.");
});
