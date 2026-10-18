import { test, expect } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";
import { hubFixture } from "./projects-fixture.js";

const listPath = /^\/api\/assistant-project-access\/([^/]+)$/;
const putPath = /^\/api\/assistant-project-access\/([^/]+)\/([^/]+)$/;
const conflict = { error: "Changed", messageKey: "assistants.conflict" };

// Two permanent agents whose PUT answers the test releases itself.
function twoAgents({ answer } = {}) {
  const state = {
    agents: {
      home: { id: "home", name: "Home", revision: 1, coding: false, folder: "none" },
      scout: { id: "scout", name: "Scout", revision: 1, coding: false, folder: "none" },
    },
    puts: [],
    lists: 0,
  };
  const intercept = async (route, url, method) => {
    if (url.pathname === "/api/assistants") {
      await route.fulfill({
        json: { assistants: Object.values(state.agents), conversations: [] },
      });
      return true;
    }
    if (method === "GET" && listPath.test(url.pathname)) {
      state.lists++;
      await route.fulfill({ json: { agents: Object.values(state.agents), members: [] } });
      return true;
    }
    const match = putPath.exec(url.pathname);
    if (method !== "PUT" || !match) return false;
    const body = route.request().postDataJSON();
    const put = { projectId: match[1], agentId: match[2], body };
    state.puts.push(put);
    const reply = answer?.(put, state);
    if (reply) return (await reply(route), true);
    const agent = state.agents[match[2]];
    Object.assign(agent, {
      revision: agent.revision + 1,
      coding: body.coding,
      folder: body.coding ? body.folder : "none",
    });
    await route.fulfill({ json: { ...agent } });
    return true;
  };
  return { state, intercept };
}
const block = (page, id) => page.locator(`[data-project-agent="${id}"]`);

test.describe("English project agents under concurrent saves", () => {
  test.use({ locale: "en-GB" });

  test("two agents changed before the first answer both keep their choice", async ({
    page,
  }) => {
    let releaseHome;
    const held = new Promise((resolve) => (releaseHome = resolve));
    const access = twoAgents({
      // Only Home's first answer is held; later saves get the ordinary answer.
      answer: (put, state) =>
        put.agentId === "home" && state.puts.length < 3
          ? async (route) => {
              await held;
              await route.fulfill({
                json: { id: "home", revision: 2, coding: true, folder: "read" },
              });
            }
          : null,
    });
    await hubFixture(page, { intercept: access.intercept });
    await page.goto(base + "/projects/m1?tab=agents");
    await block(page, "home").getByLabel("Read", { exact: true }).check();
    await block(page, "scout").getByLabel("Read and write", { exact: true }).check();
    await expect.poll(() => access.state.puts.length).toBe(2);
    // Scout's answer arrives first; Home's afterwards must not undo it.
    await expect(block(page, "scout").getByText("Saving …")).toHaveCount(0);
    releaseHome();
    await expect(block(page, "home").getByText("Saving …")).toHaveCount(0);
    await expect(block(page, "home").getByLabel("Read", { exact: true })).toBeChecked();
    await expect(
      block(page, "scout").getByLabel("Read and write", { exact: true }),
    ).toBeChecked();
    // A further change of Home is based on what it now shows.
    await block(page, "home").getByLabel("None", { exact: true }).check();
    await expect.poll(() => access.state.puts.length).toBe(3);
    expect(access.state.puts[2].body.expected).toEqual({ coding: true, folder: "read" });
    await expect(block(page, "home").getByText("Saving …")).toHaveCount(0);
    await expect(block(page, "home").getByLabel("None", { exact: true })).toBeChecked();
    await expect(page.getByText(/changed elsewhere/)).toHaveCount(0);
  });

  test("only a real conflict reloads; a busy service is an ordinary error", async ({
    page,
  }) => {
    let next = "active";
    const access = twoAgents({
      answer: () => {
        const kind = next;
        next = null;
        if (kind === "active")
          return (route) =>
            route.fulfill({
              status: 409,
              json: {
                error: "Agents are busy right now.",
                messageKey: "assistants.active",
              },
            });
        if (kind === "conflict")
          return (route) => route.fulfill({ status: 409, json: conflict });
        return null;
      },
    });
    await hubFixture(page, { intercept: access.intercept });
    await page.goto(base + "/projects/m1?tab=agents");
    // click, not check: the refusal may already have restored None when check()
    // reads the radio back (WebKit answers the fulfilled route that fast).
    await block(page, "home").getByLabel("Read", { exact: true }).click();
    // The message comes from the server catalog by its key.
    await expect(block(page, "home").getByRole("alert")).toHaveText(
      /request is still running/,
    );
    await expect(page.getByText(/changed elsewhere/)).toHaveCount(0);
    await expect(block(page, "home").getByLabel("None", { exact: true })).toBeChecked();
    const lists = access.state.lists;
    next = "conflict";
    await block(page, "home").getByLabel("Read", { exact: true }).click();
    await expect(page.getByText(/changed elsewhere/)).toBeVisible();
    await expect.poll(() => access.state.lists).toBe(lists + 1);
  });

  test("re-adding a folder whose agents already have that access is no failure", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const access = twoAgents({
      answer: (put, state) => {
        // The project existed and Home already holds this access.
        state.agents.home = { ...state.agents.home, coding: true, folder: "read" };
        return (route) => route.fulfill({ status: 409, json: conflict });
      },
    });
    await hubFixture(page, { intercept: access.intercept });
    await page.goto(base + "/projects");
    await page.getByRole("button", { name: "Add project" }).first().click();
    await page.getByRole("menuitem", { name: "Add folder" }).click();
    const dialog = page.getByRole("dialog", { name: "Add project" });
    await dialog.getByLabel("Home").selectOption({ label: "Coding and read folder" });
    await dialog.getByLabel("Project directory", { exact: true }).fill("/work/new");
    await dialog.getByRole("button", { name: "Add project" }).click();
    await expect(dialog).toHaveCount(0);
  });

  test("cancelling after a partial failure still opens the added project", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const access = twoAgents({
      answer: () => (route) => route.fulfill({ status: 500, json: { error: "Broken" } }),
    });
    await hubFixture(page, { intercept: access.intercept });
    await page.goto(base + "/projects");
    await page.getByRole("button", { name: "Add project" }).first().click();
    await page.getByRole("menuitem", { name: "Add folder" }).click();
    const dialog = page.getByRole("dialog", { name: "Add project" });
    await dialog.getByLabel("Scout").selectOption({ label: "Coding only" });
    await dialog.getByLabel("Project directory", { exact: true }).fill("/work/new");
    await dialog.getByRole("button", { name: "Add project" }).click();
    await expect(dialog.getByText(/access for 1 agent could not be set/)).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(/\/projects\/m3/);
  });
});
