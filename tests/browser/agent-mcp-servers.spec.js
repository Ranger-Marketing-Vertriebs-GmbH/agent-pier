import { test, expect } from "@playwright/test";
import {
  accountDetail,
  openAccountItem,
  saveBar as accountSaveBar,
} from "../helpers/accounts-browser.js";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { saveBar, settingsPath } from "../helpers/agent-settings-page.js";
import { openAdd } from "./mcp-cli-fixture.js";
import { chooseSource, primary } from "./mcp-wizard-fixture.js";
import { fixture } from "./providers-fixture.js";

const secret = "Bearer fixture-secret-token";
const refusal = {
  status: 409,
  json: {
    code: "MCP_STDIO_CONFIRMATION_REQUIRED",
    error: "Bestätigung nötig",
    messageKey: "mcpServers.stdioConfirmationRequired",
  },
};
const tokenColor = (page, token) =>
  page.evaluate((name) => {
    const probe = document.body.appendChild(document.createElement("span"));
    probe.style.color = `var(${name})`;
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
const stdioChange = (body) =>
  ["command", "args", "cwd", "env"].some((key) => body[key] !== undefined);

async function setup(page, { serversUnavailable = false } = {}) {
  await fixture(page);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const state = { requests: [], servers: [], bindings: [], nextId: 1 };
  const home = {
    id: "home",
    name: "Home",
    instructions: "Plan",
    revision: 1,
    effectiveRevision: 1,
    model: { connectionId: "router", modelId: "model" },
    capabilities: { memory: false, reminders: false },
    mcpServers: [],
  };
  const temporary = {
    ...home,
    id: "temp-agent",
    name: "Researcher",
    teamMemberId: "member-1",
    parentAssistantId: "home",
    lifetime: "task",
  };
  delete temporary.mcpServers;
  const member = {
    id: "member-1",
    kind: "member",
    assistantId: "temp-agent",
    parentAssistantId: "home",
    teamId: "team",
    name: "Researcher",
    role: "Research",
    assignment: "Look things up",
    phase: "running",
    conversationId: "chat-1",
    revision: 1,
    lifetime: "task",
    inheritedRevision: 1,
    mcpServers: [
      { name: "docs", stdio: false },
      { name: "local", stdio: true },
    ],
  };
  const proposal = {
    id: "proposal",
    kind: "team",
    parentAssistantId: "home",
    objective: "Plan a second assignment",
    phase: "awaiting_approval",
    members: [
      {
        name: "Planner",
        role: "Plan",
        assignment: "Plan next step",
        ...(serversUnavailable
          ? { mcpServersUnavailable: true }
          : {
              mcpServers: [
                { name: "docs", stdio: false },
                { name: "local", stdio: true },
              ],
            }),
      },
    ],
    revision: 1,
  };
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (
      [
        "/api/assistant-channels",
        "/api/assistant-speech",
        "/api/assistant-web-search",
        "/api/assistant-runtime/updates",
        "/api/assistant-model-accounts",
      ].includes(path)
    )
      return route.fallback();
    if (path === "/api/assistant-events")
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'data: {"type":"connected"}\n\n',
      });
    if (path === "/api/assistants" && request.method() === "GET")
      return route.fulfill({
        json: {
          assistants: [{ ...home, mcpServers: state.bindings }, temporary],
          conversations: [
            { id: "parent-chat", assistantId: "home" },
            { id: "chat-1", assistantId: "temp-agent" },
          ],
          models: [{ id: "router", name: "Router", available: true }],
          teams: [proposal],
          members: [member],
        },
      });
    if (path === "/api/assistants/home" && request.method() === "PATCH") {
      const body = request.postDataJSON();
      state.requests.push({ path, method: "PATCH", body });
      const added = body.mcpServers.filter((id) => !state.bindings.includes(id));
      const stdio = added.some((id) => state.servers.find((s) => s.id === id)?.stdio);
      if (stdio && body.confirmStdio !== true) return route.fulfill(refusal);
      state.bindings = body.mcpServers;
      home.revision += 1;
      return route.fulfill({
        json: {
          ...home,
          mcpServers: state.bindings,
          ...(state.pending && { pending: true }),
        },
      });
    }
    if (path === "/api/assistant-runtime")
      return route.fulfill({ json: { availability: "ready", sync: "current" } });
    if (path.endsWith("/messages"))
      return route.fulfill({ json: { messages: [], requests: [], stale: false } });
    if (path.endsWith("/conversations"))
      return route.fulfill({ json: { id: "parent-chat", assistantId: "home" } });
    return route.fulfill({ json: {} });
  });
  await page.route(/\/api\/mcp-commands\/resolve/, (route) => {
    const name = new URL(route.request().url()).searchParams.get("name");
    return route.fulfill({ json: { found: true, path: `/opt/homebrew/bin/${name}` } });
  });
  await page.route(/\/api\/mcp-servers/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const publicServer = (full) => {
      const { stdio: _stdio, ...server } = full;
      return server;
    };
    if (path === "/api/mcp-servers/cli-finds")
      return route.fulfill({ json: { finds: [], problems: [] } });
    if (method === "GET") return route.fulfill({ json: state.servers.map(publicServer) });
    const body = request.postDataJSON?.() || {};
    state.requests.push({ path, method, body });
    if (method === "POST") {
      if (body.transport === "stdio" && body.confirmStdio !== true)
        return route.fulfill(refusal);
      const stdio = body.transport === "stdio";
      const server = {
        id: `server-${state.nextId++}`,
        name: body.name,
        transport: body.transport,
        stdio,
        ...(stdio
          ? {
              command: body.command.startsWith("/")
                ? body.command
                : `/opt/homebrew/bin/${body.command}`,
              args: body.args || [],
              ...(body.cwd ? { cwd: body.cwd } : {}),
              headerNames: [],
              envNames: Object.keys(body.env || {}),
            }
          : {
              url: body.url.split("?")[0],
              headerNames: Object.keys(body.headers || {}),
              envNames: [],
            }),
        revision: 1,
      };
      state.servers.push(server);
      return route.fulfill({ status: 201, json: publicServer(server) });
    }
    const id = path.split("/").pop();
    const server = state.servers.find((s) => s.id === id);
    if (method === "PUT") {
      if (server.stdio && stdioChange(body) && body.confirmStdio !== true)
        return route.fulfill(refusal);
      Object.assign(server, body.command ? { command: body.command } : {}, {
        revision: server.revision + 1,
      });
      if (body.args) server.args = body.args;
      return route.fulfill({
        json: { ...publicServer(server), ...(state.pending && { pending: true }) },
      });
    }
    state.servers = state.servers.filter((s) => s.id !== id);
    if (state.pending) return route.fulfill({ json: { pending: true } });
    return route.fulfill({ status: 204, body: "" });
  });
  return state;
}

const openStep = (page, id, step = "") =>
  page.goto(
    `${baseURL}/accounts?section=mcp-servers&item=${id}${step ? `&step=${step}` : ""}`,
  );

async function fits(page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
}

for (const [label, use] of [
  ["desktop", {}],
  ["phone", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
]) {
  test.describe(label, () => {
    test.use(use);

    test("an HTTP server with a header never shows the stored value", async ({
      page,
    }) => {
      const state = await setup(page);
      await page.goto(baseURL + "/accounts");
      const panel = page.getByRole("region", { name: "MCP servers" });
      await expect(panel.getByText("No MCP servers yet")).toBeVisible();
      const wizard = await openAdd(page);
      await chooseSource(wizard, "Server on the internet");
      await expect(wizard.getByText(/1 to 30 letters, digits, hyphens/)).toBeVisible();
      await wizard.getByLabel("Name", { exact: true }).fill("docs");
      await wizard
        .getByLabel("Address", { exact: true })
        .fill("https://mcp.example.com/v1?token=abc");
      await wizard.getByRole("radio", { name: /API key or token/ }).check();
      await wizard.getByLabel("Token", { exact: true }).fill("fixture-secret-token");
      if (label === "phone") await fits(page);
      await primary(wizard).click();
      await expect(
        wizard.getByRole("heading", { level: 1, name: "Settings for docs" }),
      ).toBeFocused();
      await primary(wizard).click();
      await wizard.getByRole("button", { name: "Save server" }).click();
      expect(state.requests[0].body).toMatchObject({
        name: "docs",
        transport: "http",
        headers: { Authorization: secret },
      });
      await wizard.getByRole("button", { name: "Skip for now" }).click();
      await wizard.getByRole("button", { name: "Open server" }).click();
      await expect(page).toHaveURL(/item=server-1$/);
      const item = accountDetail(page);
      await expect(item).toContainText("docs");
      await expect(item).toContainText("https://mcp.example.com/v1");
      await expect(item).toContainText("Authorization");
      expect(await page.content()).not.toContain(secret);
      expect(await page.content()).not.toContain("token=abc");
      // The settings step shows the header name as stored and offers replacing it.
      await item.getByRole("button", { name: "Change: Settings" }).click();
      await expect(item.getByText("stored", { exact: true })).toBeVisible();
      await expect(item.getByLabel(/Authorization: New value/)).toHaveValue("");
      expect(await page.content()).not.toContain(secret);
      await item.getByRole("button", { name: "Remove", exact: true }).click();
      await accountSaveBar(page).getByRole("button", { name: "Save changes" }).click();
      await expect(page).toHaveURL(/item=server-1$/);
      expect(state.requests[1].body).toEqual({
        revision: 1,
        headers: { Authorization: null },
      });
      if (label === "phone") await fits(page);
    });

    test("a stdio server needs confirmation and shows its resolved path", async ({
      page,
    }) => {
      const state = await setup(page);
      await page.goto(baseURL + "/accounts");
      const wizard = await openAdd(page);
      await chooseSource(wizard, /Own command/);
      await wizard.getByLabel("Name", { exact: true }).fill("local");
      await wizard.getByLabel("Command").fill("npx");
      await expect(wizard.getByText("Found: /opt/homebrew/bin/npx")).toBeVisible();
      await primary(wizard).click();
      await wizard.getByText(/^Arguments and working directory/).click();
      await wizard.getByRole("button", { name: "Add an argument" }).click();
      await wizard.getByLabel("Argument 1", { exact: true }).fill("-y");
      await wizard.getByRole("button", { name: "Add an argument" }).click();
      await wizard.getByLabel("Argument 2", { exact: true }).fill("server");
      await primary(wizard).click();
      const warning = wizard.getByRole("region", { name: "Run a local command?" });
      await expect(warning).toContainText("your user rights, without a sandbox");
      await expect(warning).toContainText("every session of every agent");
      expect(state.servers).toHaveLength(0);
      if (label === "phone") await fits(page);
      await wizard.getByRole("button", { name: "Allow and save" }).click();
      expect(state.requests.at(-1).body).toMatchObject({
        confirmStdio: true,
        args: ["-y", "server"],
      });
      // Connect gives the new server to the agent with the one consent.
      await wizard.getByRole("switch", { name: "Home" }).check();
      await primary(wizard).click();
      await expect(page).toHaveURL(/step=done/);
      expect(state.requests.at(-1)).toEqual({
        path: "/api/assistants/home",
        method: "PATCH",
        body: { mcpServers: ["server-1"], revision: 1, confirmStdio: true },
      });
      await wizard.getByRole("button", { name: "Open server" }).click();
      const item = accountDetail(page);
      await expect(item).toContainText("/opt/homebrew/bin/npx");
      await expect(item.getByText("stdio", { exact: true })).toBeVisible();
    });

    test("editing the command of a stdio server asks again", async ({ page }) => {
      const state = await setup(page);
      state.servers.push({
        id: "server-9",
        name: "local",
        transport: "stdio",
        stdio: true,
        command: "/opt/homebrew/bin/npx",
        args: [],
        headerNames: [],
        envNames: [],
        revision: 1,
      });
      await openStep(page, "server-9", "setup");
      const panel = page.getByRole("region", { name: "MCP servers" });
      const dialog = accountDetail(page);
      await dialog
        .getByRole("textbox", { name: /^Command/ })
        .fill("/usr/local/bin/other");
      await accountSaveBar(page).getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByRole("alertdialog")).toContainText("without a sandbox");
      await page.getByRole("button", { name: "Confirm and save" }).click();
      await expect(page).toHaveURL(/item=server-9$/);
      expect(state.requests.map((r) => r.body.confirmStdio)).toEqual([undefined, true]);
      await expect(dialog).toContainText("/usr/local/bin/other");
      // Removing asks first and then drops the server.
      await dialog.getByRole("button", { name: "Remove local" }).click();
      await expect(dialog.getByRole("alertdialog")).toContainText("lose access");
      await dialog.getByRole("button", { name: "Remove server" }).click();
      await expect(panel.getByText("No MCP servers yet")).toBeVisible();
    });

    test("a saved change whose live apply is pending shows a notice", async ({
      page,
    }) => {
      const state = await setup(page);
      state.pending = true;
      state.servers.push(
        {
          id: "s1",
          name: "docs",
          transport: "http",
          url: "https://a.example/mcp",
          headerNames: [],
          envNames: [],
        },
        {
          id: "s2",
          name: "more",
          transport: "http",
          url: "https://b.example/mcp",
          headerNames: [],
          envNames: [],
        },
      );
      const notice = "Saved \u2014 will be applied to running agents shortly.";
      await page.goto(baseURL + settingsPath("capabilities"));
      const panel = page.getByRole("region", { name: "MCP servers" });
      await panel.getByLabel("docs").check();
      await saveBar(page).getByRole("button", { name: "Save agent" }).click();
      await expect(panel.getByText(notice)).toBeVisible();
      expect(state.bindings).toEqual(["s1"]);
      await page.goto(baseURL + "/accounts");
      const settings = page.getByRole("region", { name: "MCP servers" });
      await openAccountItem(page, "more");
      await accountDetail(page).getByRole("button", { name: "Remove more" }).click();
      await accountDetail(page).getByRole("button", { name: "Remove server" }).click();
      await expect(settings.getByText(notice)).toBeVisible();
      await expect(settings.getByText("more")).toHaveCount(0);
      if (label === "phone") await fits(page);
    });

    test("binding a stdio server to an agent asks for confirmation", async ({ page }) => {
      const state = await setup(page);
      state.servers.push(
        { id: "s1", name: "docs", transport: "http", url: "https://a.example/mcp" },
        { id: "s2", name: "local", transport: "stdio", stdio: true, command: "/bin/x" },
      );
      await page.goto(baseURL + settingsPath("capabilities"));
      const panel = page.getByRole("region", { name: "MCP servers" });
      await panel.getByLabel("docs").check();
      await saveBar(page).getByRole("button", { name: "Save agent" }).click();
      await expect(panel.getByText("MCP servers saved.")).toBeVisible();
      expect(state.bindings).toEqual(["s1"]);
      await panel.getByLabel(/local/).check();
      await saveBar(page).getByRole("button", { name: "Save agent" }).click();
      const warning = page.getByRole("dialog", { name: "Give agents a local command?" });
      await expect(warning).toContainText("every session of every agent");
      expect(state.bindings).toEqual(["s1"]);
      if (label === "phone") await fits(page);
      await warning.getByRole("button", { name: "Confirm and save" }).click();
      await expect(panel.getByText("MCP servers saved.")).toBeVisible();
      expect(state.bindings).toEqual(["s1", "s2"]);
      expect(state.requests.at(-1).body.confirmStdio).toBe(true);
    });

    test("a package that is not installed cannot be given to an agent yet", async ({
      page,
    }) => {
      const state = await setup(page);
      const pkg = (id, name, status) => ({
        id,
        name,
        transport: "stdio",
        stdio: true,
        command: "/data/node",
        source: { registry: "npm", name, version: "1.0.0", status, leadingArgs: 1 },
      });
      state.servers.push(
        pkg("s1", "installing", "installing"),
        pkg("s2", "ready", "ready"),
      );
      await page.goto(baseURL + settingsPath("capabilities"));
      const panel = page.getByRole("region", { name: "MCP servers" });
      await expect(panel.getByLabel(/installing/)).toBeDisabled();
      await expect(panel.getByLabel(/ready/)).toBeEnabled();
      await expect(
        panel.getByText(
          "Coding CLIs and agents can be added once the package is installed.",
        ),
      ).toBeVisible();
    });

    test("the confirmation dialogs hold focus, cancel on Escape and return focus", async ({
      page,
    }) => {
      const state = await setup(page);
      state.servers.push({
        id: "s1",
        name: "docs",
        transport: "http",
        url: "https://a.example/mcp",
        headerNames: [],
        envNames: [],
        revision: 1,
      });
      await page.goto(baseURL + "/accounts");
      const insideAlert = () =>
        page.evaluate(() => !!document.activeElement?.closest('[role="alertdialog"]'));
      // Remove: focus enters, Tab stays inside, Escape cancels and focus returns.
      await openAccountItem(page, "docs");
      const remove = accountDetail(page).getByRole("button", { name: "Remove docs" });
      await remove.click();
      const removal = accountDetail(page).getByRole("alertdialog");
      await expect(removal.getByRole("button", { name: "Cancel" })).toBeFocused();
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press("Tab");
        expect(await insideAlert()).toBe(true);
      }
      await page.keyboard.press("Shift+Tab");
      expect(await insideAlert()).toBe(true);
      await page.keyboard.press("Escape");
      await expect(removal).toHaveCount(0);
      await expect(remove).toBeFocused();
      // The stdio confirmation of an edit: Escape closes only the warning.
      state.servers.push({
        id: "s2",
        name: "local",
        transport: "stdio",
        stdio: true,
        command: "/opt/homebrew/bin/npx",
        args: [],
        headerNames: [],
        envNames: [],
        revision: 1,
      });
      await openStep(page, "s2", "setup");
      const dialog = accountDetail(page);
      await dialog.getByRole("textbox", { name: /^Command/ }).fill("uvx");
      const save = accountSaveBar(page).getByRole("button", { name: "Save changes" });
      await save.click();
      const warning = page.getByRole("alertdialog");
      await expect(warning.getByRole("button", { name: "Cancel" })).toBeFocused();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      expect(await insideAlert()).toBe(true);
      await page.keyboard.press("Escape");
      await expect(warning).toHaveCount(0);
      await expect(dialog).toBeVisible();
      await expect(save).toBeFocused();
      expect(state.servers.find((s) => s.id === "s2").command).toBe(
        "/opt/homebrew/bin/npx",
      );
    });

    test("temporary members list their servers read only", async ({ page }) => {
      await setup(page);
      await page.goto(baseURL + settingsPath("capabilities", undefined, "temp-agent"));
      const panel = page.getByRole("region", { name: "MCP servers" });
      await expect(panel).toContainText("Granted by the lead agent's team proposal");
      await expect(panel).toContainText("docs");
      await expect(panel).toContainText("local");
      await expect(panel).toContainText("stdio, local command");
      await expect(panel.getByRole("checkbox")).toHaveCount(0);
    });

    test("the team approval lists servers per member with a stdio marker", async ({
      page,
    }) => {
      await setup(page);
      await page.goto(baseURL + "/agents/home/chats/parent-chat");
      const card = page.locator(".assistant-team-card.awaiting");
      const line = card.locator(".assistant-team-proposal li .mcp-team-servers");
      await expect(line).toContainText("docs, local (stdio, local command)");
      await expect(card.locator(".mcp-team-warning")).toHaveText(
        "A listed stdio server runs a local command with your user rights, without a sandbox.",
      );
      await expect(card.locator(".mcp-team-warning")).toHaveCSS(
        "color",
        await tokenColor(page, "--muted"),
      );
      await expect(
        card.getByRole("button", { name: "Approve team", exact: true }),
      ).toBeEnabled();
      if (label === "phone") await fits(page);
    });

    test("an unreadable server list blocks the team approval", async ({ page }) => {
      await setup(page, { serversUnavailable: true });
      await page.goto(baseURL + "/agents/home/chats/parent-chat");
      const card = page.locator(".assistant-team-card.awaiting");
      await expect(
        card.getByRole("alert").filter({ hasText: "MCP server list" }),
      ).toHaveText(
        "The MCP server list cannot be read right now. The team cannot be approved until it can.",
      );
      await expect(
        card.getByRole("alert").filter({ hasText: "MCP server list" }),
      ).toHaveCSS("color", await tokenColor(page, "--accent"));
      await expect(card.locator(".mcp-team-servers")).toHaveCount(0);
      await expect(
        card.getByRole("button", { name: "Approve team", exact: true }),
      ).toBeDisabled();
      await expect(
        card.getByRole("button", { name: "Decline team", exact: true }),
      ).toBeEnabled();
    });
  });
}
