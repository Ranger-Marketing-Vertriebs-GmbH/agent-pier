import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
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
      await expect(panel.getByText("No MCP servers yet.")).toBeVisible();
      await panel.getByRole("button", { name: "Add MCP server" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByText(/1 to 30 letters, digits, hyphens/)).toBeVisible();
      await dialog.getByLabel("Name", { exact: true }).fill("docs");
      await dialog.getByLabel("Address").fill("https://mcp.example.com/v1?token=abc");
      await dialog.getByRole("button", { name: "Add entry" }).click();
      await dialog.getByLabel("Name", { exact: true }).nth(1).fill("Authorization");
      await dialog.getByLabel("Value", { exact: true }).fill(secret);
      if (label === "phone") await fits(page);
      await dialog.getByRole("button", { name: "Save server" }).click();
      await expect(dialog).toHaveCount(0);
      expect(state.requests[0].body).toMatchObject({
        name: "docs",
        transport: "http",
        headers: { Authorization: secret },
      });
      const item = panel.getByRole("listitem");
      await expect(item).toContainText("docs");
      await expect(item).toContainText("https://mcp.example.com/v1");
      await expect(item).toContainText("Authorization");
      expect(await page.content()).not.toContain(secret);
      expect(await page.content()).not.toContain("token=abc");
      // Editing shows the header name as stored and offers replacing it.
      await panel.getByRole("button", { name: "Edit docs" }).click();
      await expect(dialog.getByText("stored", { exact: true })).toBeVisible();
      await expect(dialog.getByLabel(/Authorization: New value/)).toHaveValue("");
      expect(await page.content()).not.toContain(secret);
      await dialog.getByRole("button", { name: "Remove", exact: true }).click();
      await dialog.getByRole("button", { name: "Save server" }).click();
      await expect(dialog).toHaveCount(0);
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
      const panel = page.getByRole("region", { name: "MCP servers" });
      await panel.getByRole("button", { name: "Add MCP server" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Name", { exact: true }).fill("local");
      await dialog.getByRole("radio", { name: "Local command (stdio)" }).check();
      await dialog.getByRole("textbox", { name: /^Command/ }).fill("npx");
      await dialog.getByLabel("Arguments (one per line)").fill("-y\nserver");
      await dialog.getByRole("button", { name: "Save server" }).click();
      const warning = dialog.getByRole("alertdialog");
      await expect(warning).toContainText("your user rights, without a sandbox");
      await expect(warning).toContainText("every session of every agent");
      expect(state.servers).toHaveLength(0);
      if (label === "phone") await fits(page);
      await warning.getByRole("button", { name: "Confirm and save" }).click();
      await expect(dialog).toHaveCount(0);
      expect(state.requests.at(-1).body).toMatchObject({
        confirmStdio: true,
        args: ["-y", "server"],
      });
      const item = panel.getByRole("listitem");
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
      await page.goto(baseURL + "/accounts");
      const panel = page.getByRole("region", { name: "MCP servers" });
      await panel.getByRole("button", { name: "Edit local" }).click();
      const dialog = page.getByRole("dialog");
      await dialog
        .getByRole("textbox", { name: /^Command/ })
        .fill("/usr/local/bin/other");
      await dialog.getByRole("button", { name: "Save server" }).click();
      await expect(dialog.getByRole("alertdialog")).toContainText("without a sandbox");
      await dialog.getByRole("button", { name: "Confirm and save" }).click();
      await expect(dialog).toHaveCount(0);
      expect(state.requests.map((r) => r.body.confirmStdio)).toEqual([undefined, true]);
      await expect(panel.getByRole("listitem")).toContainText("/usr/local/bin/other");
      // Removing asks first and then drops the server.
      await panel.getByRole("button", { name: "Remove local" }).click();
      await expect(panel.getByRole("alertdialog")).toContainText("lose access");
      await panel.getByRole("button", { name: "Remove server" }).click();
      await expect(panel.getByText("No MCP servers yet.")).toBeVisible();
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
      await page.goto(baseURL + "/agents/home/settings");
      const panel = page.getByRole("region", { name: "MCP servers" });
      await panel.getByLabel("docs").check();
      await panel.getByRole("button", { name: "Save MCP servers" }).click();
      await expect(panel.getByText(notice)).toBeVisible();
      expect(state.bindings).toEqual(["s1"]);
      await page.goto(baseURL + "/accounts");
      const settings = page.getByRole("region", { name: "MCP servers" });
      await settings.getByRole("button", { name: "Remove more" }).click();
      await settings.getByRole("button", { name: "Remove server" }).click();
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
      await page.goto(baseURL + "/agents/home/settings");
      const panel = page.getByRole("region", { name: "MCP servers" });
      await panel.getByLabel("docs").check();
      await panel.getByRole("button", { name: "Save MCP servers" }).click();
      await expect(panel.getByText("MCP servers saved.")).toBeVisible();
      expect(state.bindings).toEqual(["s1"]);
      await panel.getByLabel(/local/).check();
      await panel.getByRole("button", { name: "Save MCP servers" }).click();
      const warning = panel.getByRole("alertdialog");
      await expect(warning).toContainText("every session of every agent");
      expect(state.bindings).toEqual(["s1"]);
      if (label === "phone") await fits(page);
      await warning.getByRole("button", { name: "Confirm and save" }).click();
      await expect(panel.getByText("MCP servers saved.")).toBeVisible();
      expect(state.bindings).toEqual(["s1", "s2"]);
      expect(state.requests.at(-1).body.confirmStdio).toBe(true);
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
      const panel = page.getByRole("region", { name: "MCP servers" });
      const insideAlert = () =>
        page.evaluate(() => !!document.activeElement?.closest('[role="alertdialog"]'));
      // Remove: focus enters, Tab stays inside, Escape cancels and focus returns.
      await panel.getByRole("button", { name: "Remove docs" }).click();
      const removal = panel.getByRole("alertdialog");
      await expect(removal.getByRole("button", { name: "Cancel" })).toBeFocused();
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press("Tab");
        expect(await insideAlert()).toBe(true);
      }
      await page.keyboard.press("Shift+Tab");
      expect(await insideAlert()).toBe(true);
      await page.keyboard.press("Escape");
      await expect(removal).toHaveCount(0);
      await expect(panel.getByRole("button", { name: "Remove docs" })).toBeFocused();
      // Stdio confirmation inside the side panel: Escape closes only the warning.
      await panel.getByRole("button", { name: "Add MCP server" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Name", { exact: true }).fill("local");
      await dialog.getByRole("radio", { name: "Local command (stdio)" }).check();
      await dialog.getByRole("textbox", { name: /^Command/ }).fill("npx");
      const save = dialog.getByRole("button", { name: "Save server" });
      await save.click();
      const warning = dialog.getByRole("alertdialog");
      await expect(warning.getByRole("button", { name: "Cancel" })).toBeFocused();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      expect(await insideAlert()).toBe(true);
      await page.keyboard.press("Escape");
      await expect(warning).toHaveCount(0);
      await expect(dialog).toBeVisible();
      await expect(save).toBeFocused();
      expect(state.servers).toHaveLength(1);
    });

    test("temporary members list their servers read only", async ({ page }) => {
      await setup(page);
      await page.goto(baseURL + "/agents/temp-agent/settings");
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
