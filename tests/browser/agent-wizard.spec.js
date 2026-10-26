import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { home, setupAssistantSettings } from "../helpers/assistant-settings-browser.js";

// Neuer Agent (handoff 5.3): six steps over one draft, creation through the settings
// endpoints in order, partial failure with "Try again", side sheets and duplicate.
async function wizard(page, options = {}) {
  const state = await setupAssistantSettings(page, {
    catalog: {
      projects: [{ id: "p1", name: "Notes", path: "/srv/notes" }],
      pipelines: [],
    },
    ...options,
  });
  const sent = [];
  const fail = { channel: options.failChannel || 0 };
  await page.route(/\/api\/(assistants|assistant-channels)/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = method === "GET" ? null : request.postDataJSON();
    const record = (name) => sent.push([name, body]);
    if (path === "/api/assistants" && method === "POST") {
      record("create");
      const fresh = home({ id: "fresh", name: body.name, revision: 3 });
      state.assistants.push(fresh);
      return route.fulfill({ status: 201, json: fresh });
    }
    if (path === "/api/assistants/fresh" && method === "PATCH") {
      record("update");
      return route.fulfill({ json: { ...state.assistants.at(-1), revision: 4 } });
    }
    if (path === "/api/assistants/fresh/access")
      return route.fulfill({ json: { revision: 11 } });
    if (path === "/api/assistants/fresh/work") {
      record("work");
      return route.fulfill({ json: { access: { revision: 12 }, team: null } });
    }
    if (path === "/api/assistants/fresh/routines" && method === "POST") {
      record("routine");
      return route.fulfill({ status: 201, json: { id: "r1" } });
    }
    if (path === "/api/assistants/fresh/conversations" && method === "POST")
      return route.fulfill({ json: { id: "fresh-chat", assistantId: "fresh" } });
    if (path === "/api/assistant-channels" && method === "POST") {
      record("channel");
      if (fail.channel-- > 0)
        return route.fulfill({ status: 400, json: { error: "Bot token invalid" } });
      return route.fulfill({ status: 201, json: { id: "ch", revision: 1 } });
    }
    return route.fallback();
  });
  return { state, sent };
}
const next = (page) => page.getByRole("button", { name: "Next", exact: true }).click();
async function identity(page, name = "Scout") {
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page
    .getByRole("combobox", { name: "Model connection" })
    .selectOption({ label: "Router" });
  const model = page.getByRole("textbox", { name: "Model ID" });
  if (!(await model.inputValue())) await model.fill("model");
}
const heading = (page, name) =>
  page.getByRole("heading", { name, level: 2, exact: true });

test("all six steps create the agent, its grants and routine, then its chat", async ({
  page,
}) => {
  const { sent } = await wizard(page);
  await page.goto(baseURL + "/agents?new=1");
  await expect(page.getByRole("heading", { name: "New agent", level: 1 })).toBeVisible();
  const rail = page.getByRole("navigation", { name: "Steps" });
  await expect(rail.getByRole("button")).toHaveCount(6);
  await expect(heading(page, "Start")).toBeVisible();
  await next(page);
  // Weiter needs a name and a model.
  await next(page);
  await expect(page.getByRole("alert")).toContainText("Give the agent a name.");
  await identity(page);
  await next(page);
  await expect(heading(page, "Capabilities")).toBeVisible();
  await page.getByRole("radio", { name: /^Assistant/ }).check();
  await expect(page.getByRole("switch", { name: "Use a browser" })).toBeChecked();
  // Switches stay editable after a profile.
  await page.getByRole("switch", { name: "Read PDFs" }).click();
  await next(page);
  await expect(heading(page, "Access")).toBeVisible();
  const project = page.getByRole("combobox", { name: "Add project" });
  await project.focus();
  await page.keyboard.type("Notes");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press(" ");
  await page.getByRole("button", { name: "Add 1" }).click();
  await expect(page.locator("[data-access-grant='p1']")).toBeVisible();
  await next(page);
  await expect(heading(page, "Channels & routines")).toBeVisible();
  await page.getByLabel("Telegram bot token").fill("123:abc");
  await page.getByRole("switch", { name: "Create a first routine" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Daily overview");
  await page.getByLabel("Description").fill("Sum up the news");
  // The bot is paired after creating: the routine asks for Telegram only then.
  await expect(
    page.getByText("Switch on Telegram for it under Automation"),
  ).toBeVisible();
  await next(page);
  await expect(heading(page, "Review")).toBeVisible();
  await expect(page.getByText("1 project")).toBeVisible();
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  await expect(page).toHaveURL(/\/agents\/fresh\/chats\/fresh-chat$/);
  expect(sent.map(([name]) => name)).toEqual([
    "create",
    "update",
    "work",
    "channel",
    "routine",
  ]);
  const create = sent[0][1];
  expect(create).toMatchObject({ name: "Scout", model: { connectionId: "router" } });
  expect(create.capabilities.browser).toBe(false);
  expect(create.shell).toBeUndefined();
  expect(sent[1][1]).toMatchObject({
    revision: 3,
    capabilities: { browser: true, webSearch: true, readPdfs: false },
  });
  expect(sent[2][1].access).toMatchObject({ revision: 11, projectIds: ["p1"] });
  expect(sent[4][1]).toMatchObject({
    name: "Daily overview",
    prompt: "Sum up the news",
    trigger: { kind: "cron", expr: "30 8 * * *" },
  });
  expect("telegram" in sent[4][1]).toBe(false);
});

test("a failed step keeps the agent, lists ✓/✕ and retries only on request", async ({
  page,
}) => {
  const { sent } = await wizard(page, { failChannel: 1 });
  await page.goto(baseURL + "/agents?new=1");
  await next(page);
  await identity(page);
  await next(page);
  await page.getByRole("radio", { name: /^Conversation partner/ }).check();
  await next(page);
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await page.getByLabel("Telegram bot token").fill("bad");
  await next(page);
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Scout is created. 1 of 2 steps did not work.",
  );
  const failed = page.locator(".agent-wizard-step-failed");
  await expect(failed).toContainText("Connect Telegram");
  await expect(failed).toContainText("Bot token invalid");
  await expect(page.locator(".agent-wizard-step-done")).toContainText("Agent created");
  // Nothing is sent again on its own.
  await page.waitForTimeout(300);
  expect(sent.filter(([name]) => name === "channel")).toHaveLength(1);
  await failed.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator(".agent-wizard-step-failed")).toHaveCount(0);
  expect(sent.map(([name]) => name)).toEqual(["create", "channel", "channel"]);
  await page.getByRole("button", { name: "Open chat", exact: true }).click();
  await expect(page).toHaveURL(/\/agents\/fresh\/chats\/fresh-chat$/);
});

test("the draft survives the model side sheet and leaving asks first", async ({
  page,
}) => {
  await wizard(page);
  await page.goto(baseURL + "/agents?new=1");
  await next(page);
  await page.getByLabel("Name", { exact: true }).fill("Keeper");
  await page.getByRole("button", { name: "+ Connect model" }).click();
  const sheet = page.getByRole("dialog", { name: "Connect model" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("radio", { name: "ChatGPT for agents" })).toBeChecked();
  await sheet.getByRole("radio", { name: "Provider access" }).check();
  await sheet.getByRole("button", { name: "Done" }).first().click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Keeper");
  await page.getByRole("button", { name: "Back to Agents" }).click();
  const ask = page.getByRole("dialog", { name: "Save changes?" });
  await expect(ask).toBeVisible();
  await ask.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Keeper");
});

// "+ … anlegen" (handoff 5.3 step 4): Zugänge forms in side sheets over the wizard.
async function creationSources(page, state) {
  const keys = [];
  await page.route(
    /\/api\/(ssh-keys|ssh-projects|ssh-accesses|secrets)/,
    async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const method = request.method();
      const body = method === "GET" ? null : request.postDataJSON();
      if (path === "/api/ssh-keys" && method === "GET")
        return route.fulfill({ json: { keys } });
      if (path === "/api/ssh-keys" && method === "POST") {
        const key = { id: "key-1", name: body.name, projectId: null };
        keys.push(key);
        return route.fulfill({ status: 201, json: key });
      }
      if (path === "/api/ssh-projects") return route.fulfill({ json: { projects: [] } });
      if (path === "/api/ssh-accesses/scan")
        return route.fulfill({
          json: { hostKey: "ssh-ed25519 AAAAC3", hostFingerprint: "SHA256:wizard" },
        });
      if (path === "/api/ssh-accesses" && method === "POST") {
        const access = { id: "ssh-new", type: "ssh", ...body, projectId: null };
        state.catalog.sshHosts.push(access);
        return route.fulfill({ status: 201, json: access });
      }
      if (path === "/api/secrets" && method === "POST") {
        const secret = { id: "sec-new", name: body.name, projectId: null };
        state.catalog.secrets.push(secret);
        return route.fulfill({ status: 201, json: secret });
      }
      return route.fallback();
    },
  );
}

test("step 4 creates an SSH access and a secret in side sheets and keeps the draft", async ({
  page,
}) => {
  const { state, sent } = await wizard(page, {
    catalog: { projects: [], pipelines: [], sshHosts: [], secrets: [] },
  });
  await creationSources(page, state);
  await page.goto(baseURL + "/agents?new=1");
  await next(page);
  await identity(page, "Keeper");
  await next(page);
  await next(page);
  await expect(heading(page, "Access")).toBeVisible();
  await page.getByRole("button", { name: "+ Create SSH/SFTP access" }).click();
  const ssh = page.getByRole("dialog", { name: "Add access" });
  await expect(ssh).toBeVisible();
  // Without a key the sheet starts with the key form.
  await expect(ssh.getByText("An SSH access needs a key first.")).toBeVisible();
  await ssh.getByLabel("Name", { exact: true }).fill("Deploy key");
  await ssh.getByRole("button", { name: "Save", exact: true }).click();
  await ssh.getByLabel("Name", { exact: true }).fill("prod-db");
  await ssh.getByLabel("Host", { exact: true }).fill("db.example");
  await ssh.getByLabel("Username", { exact: true }).fill("deploy");
  await expect(ssh.getByRole("combobox", { name: "SSH key" })).toHaveValue("key-1");
  await ssh.getByRole("button", { name: "Fetch host key" }).click();
  await ssh.getByRole("checkbox").check();
  await ssh.getByRole("button", { name: "Save", exact: true }).click();
  await expect(ssh).toHaveCount(0);
  await expect(page.getByText("“prod-db” is created and selected.")).toBeVisible();
  await expect(page.locator("[data-access-grant='ssh-new']")).toBeVisible();
  await page.getByRole("button", { name: "+ Create secret" }).click();
  const secret = page.getByRole("dialog", { name: "New secret" });
  await secret.getByLabel("Name", { exact: true }).fill("STRIPE_KEY");
  await secret.getByLabel("Value", { exact: true }).fill("sk_live_wizard");
  await secret.getByRole("button", { name: "Save", exact: true }).click();
  await expect(secret).toHaveCount(0);
  await expect(page.locator("[data-access-grant='sec-new']")).toBeVisible();
  // The draft kept everything typed before the sheets.
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Keeper");
  await next(page);
  await next(page);
  await next(page);
  await next(page);
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  await expect(page).toHaveURL(/\/agents\/fresh\/chats\/fresh-chat$/);
  const work = sent.find(([name]) => name === "work")[1].access;
  expect(work.sshAccesses).toEqual([{ accessId: "ssh-new", mode: "approval" }]);
  expect(work.secretIds).toEqual(["sec-new"]);
});

test("duplicate prefills the copy and sends its grants", async ({ page }) => {
  const { sent } = await wizard(page, {
    assistants: [
      home({
        capabilities: { memory: true, reminders: true, webFetch: true },
        mcpServers: [],
        skills: [],
      }),
    ],
    access: { revision: 2, projectIds: ["p1"], projectFiles: { p1: "read" } },
  });
  await page.goto(baseURL + "/agents?new=1&duplicate=home");
  await expect(page.getByRole("radio", { name: /^Duplicate/ })).toBeChecked();
  await next(page);
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Copy of Home");
  await expect(page.getByLabel("Instructions")).toHaveValue("Plan meals");
  await next(page);
  await expect(page.getByRole("switch", { name: "Read web pages" })).toBeChecked();
  await expect(page.getByRole("switch", { name: "Search the web" })).not.toBeChecked();
  await next(page);
  await expect(page.locator("[data-access-grant='p1']")).toBeVisible();
  await next(page);
  await next(page);
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  await expect(page).toHaveURL(/\/agents\/fresh\/chats\/fresh-chat$/);
  // The team policy comes along as its own step (5.3.1).
  expect(sent.map(([name]) => name)).toEqual(["create", "update", "work", "work"]);
  expect(sent[3][1].team).toMatchObject({
    revision: 1,
    maxMembers: 4,
    runTimeoutMinutes: 30,
  });
  expect(sent[2][1].access).toMatchObject({
    projectIds: ["p1"],
    projectFiles: { p1: "read" },
  });
});

test("phones show one step per screen with a progress bar", async ({ page }) => {
  await wizard(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseURL + "/agents?new=1");
  await expect(page.getByRole("progressbar", { name: "Progress" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Steps" })).toHaveCount(0);
  await next(page);
  await expect(heading(page, "Identity & model")).toBeVisible();
  await expect(page.getByText("Step 2 of 6", { exact: false })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});
