import { test, expect } from "@playwright/test";
import { accountDetail, openAccountItem, saveBar } from "../helpers/accounts-browser.js";
import { baseURL } from "../helpers/browser.js";
import { finds, header, openAdd, setup, stdioServer } from "./mcp-cli-fixture.js";

const findLoads = (state) =>
  state.requests.filter((r) => r.method === "GET" && r.path.endsWith("/cli-finds"))
    .length;

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
  await openAccountItem(page, "docs");
  const dialog = accountDetail(page);
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
  await expect(saveBar(page)).toHaveCount(0);
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

test("a find with environment references stays in the CLI and says why", async ({
  page,
}) => {
  await setup(page, {
    finds: [
      {
        key: "k4",
        name: "gh",
        clis: ["claude"],
        adoptable: false,
        reason: "env-references",
        referenceNames: ["Authorization"],
        messageKey: "mcpServers.cliFindEnvReferences",
      },
    ],
  });
  await page.goto(baseURL + "/accounts");
  await openAccountItem(page, "Found in the CLIs");
  const found = page.getByRole("region", { name: "Found in the CLIs" });
  await expect(
    found.getByText(
      "Uses references to environment variables or files (in Authorization); another CLI or an agent would read them differently, so it stays in the CLI.",
    ),
  ).toBeVisible();
  await expect(found.getByRole("button", { name: /^Adopt/ })).toHaveCount(0);
});

test("the finds keep their heading while loading and after a failed load", async ({
  page,
}) => {
  const state = await setup(page);
  let release;
  const held = new Promise((resolve) => (release = resolve));
  await page.route("**/api/mcp-servers/cli-finds", async (route) => {
    state.requests.push({ method: "GET", path: "/api/mcp-servers/cli-finds" });
    await held;
    return route.fulfill({ status: 500, json: { error: "Finds unavailable." } });
  });
  await page.goto(baseURL + "/accounts");
  await openAccountItem(page, "Found in the CLIs");
  const found = page.getByRole("region", { name: "Found in the CLIs" });
  await expect(
    found.getByRole("heading", { name: "Found in the CLIs", level: 2 }),
  ).toBeVisible();
  await expect(found.getByText(/^Entries you added to a CLI yourself/)).toBeVisible();
  await expect(found.getByText("Looking in the CLIs…")).toBeVisible();
  release();
  await expect(found.getByRole("alert")).toContainText("Finds unavailable.");
  await expect(found.getByRole("heading", { name: "Found in the CLIs" })).toBeVisible();
  await expect(found.getByText("Looking in the CLIs…")).toHaveCount(0);
});

/** Waits until the finds were requested `count` times, then holds to catch a late extra load. */
async function settledFindLoads(page, state, count) {
  await expect.poll(() => findLoads(state)).toBe(count);
  await page.waitForTimeout(600);
  expect(findLoads(state)).toBe(count);
}
const listLoaded = (page) =>
  page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/mcp-servers" &&
      response.request().method() === "GET",
  );

test("an adoption reloads the finds once and confirms what was adopted", async ({
  page,
}) => {
  const state = await setup(page, { finds: finds.slice(0, 2) });
  state.handle = async ({ route, path, body }) => {
    if (path !== "/api/mcp-servers/cli-finds/adopt") return false;
    const keys = body.all ? state.finds.map((find) => find.key) : body.keys;
    const adopted = keys.map((key) => header({ id: key, name: body.names[key] }));
    state.finds = state.finds.filter((find) => !keys.includes(find.key));
    state.servers.push(...adopted);
    return route.fulfill({ json: { adopted, failed: [] } });
  };
  await page.goto(baseURL + "/accounts");
  await openAccountItem(page, "Found in the CLIs");
  const found = page.getByRole("region", { name: "Found in the CLIs" });
  await expect(found.getByRole("button", { name: "Adopt all" })).toBeVisible();
  // The first page load asks for the finds once.
  await settledFindLoads(page, state, 1);
  const status = found.locator('[role="status"]');
  await expect(status).toBeEmpty();
  const reloaded = listLoaded(page);
  await found.getByRole("button", { name: "Adopt docs" }).click();
  await reloaded;
  await expect(status).toHaveText("Adopted: docs.");
  await expect(found.getByText("docs", { exact: true })).toHaveCount(0);
  await settledFindLoads(page, state, 2);
  state.finds = structuredClone(finds.slice(0, 2));
  await page.reload();
  await page
    .getByRole("region", { name: "Found in the CLIs" })
    .getByRole("button", { name: "Adopt all" })
    .click();
  await expect(
    page.getByRole("region", { name: "Found in the CLIs" }).getByRole("status"),
  ).toHaveText("Adopted: docs, my-tool.");
});

test("the finds reload after an adoption even when the list fails to reload", async ({
  page,
}) => {
  const state = await setup(page, { finds: finds.slice(0, 1) });
  state.handle = async ({ route, path, body }) => {
    if (path !== "/api/mcp-servers/cli-finds/adopt") return false;
    state.finds = [];
    return route.fulfill({
      json: { adopted: [header({ name: body.names.k1 })], failed: [] },
    });
  };
  await page.goto(baseURL + "/accounts");
  await openAccountItem(page, "Found in the CLIs");
  const found = page.getByRole("region", { name: "Found in the CLIs" });
  await settledFindLoads(page, state, 1);
  await page.route("**/api/mcp-servers", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ status: 500, json: { error: "List unavailable." } })
      : route.fallback(),
  );
  await found.getByRole("button", { name: "Adopt docs" }).click();
  await settledFindLoads(page, state, 2);
  await expect(found.getByText("Nothing else found in the CLIs.")).toBeVisible();
});
