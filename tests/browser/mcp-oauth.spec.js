import { test, expect } from "@playwright/test";
import {
  accountDetail,
  backToAccounts,
  openAccountItem,
  saveBar as accountSaveBar,
} from "../helpers/accounts-browser.js";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { messageIdentity } from "../../server/lib/i18n/message-identity.js";
import { saveBar, settingsPath } from "../helpers/agent-settings-page.js";
import { openAdd } from "./mcp-cli-fixture.js";
import { chooseSource, primary } from "./mcp-wizard-fixture.js";
import { fixture } from "./providers-fixture.js";

const provider = "https://auth.example.test";
const german = serverMessages.mcpServers;
const refusals = {
  "plain-http-remote": [409, german.oauthPlainHttpRemote],
  "loopback-redirect": [409, german.oauthLoopbackRedirect],
  "no-dynamic-registration": [502, german.oauthNoDynamicRegistration],
  "redirect-rejected": [
    502,
    german.oauthRedirectRejected("http://127.0.0.1:4380/api/mcp-servers/oauth/callback"),
  ],
};

/** The MCP server API with OAuth: `state.status` decides what the list reports. */
async function setup(page, { language = "en" } = {}) {
  await fixture(page);
  await page.addInitScript(
    (value) => localStorage.setItem("agentpier-language", value),
    language,
  );
  const state = {
    requests: [],
    servers: [],
    bindings: [],
    status: {},
    refusal: "",
    deferLogout: false,
    pendingApply: false,
    providerStays: false,
    nextId: 1,
  };
  const home = {
    id: "home",
    name: "Home",
    instructions: "Plan",
    revision: 1,
    effectiveRevision: 1,
    model: { connectionId: "router", modelId: "model" },
    capabilities: { memory: false, reminders: false },
  };
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const path = new URL(route.request().url()).pathname;
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
    if (path === "/api/assistants")
      return route.fulfill({
        json: {
          assistants: [{ ...home, mcpServers: state.bindings }],
          conversations: [],
          models: [{ id: "router", name: "Router", available: true }],
          teams: [],
          members: [],
        },
      });
    if (path === "/api/assistants/home" && route.request().method() === "PATCH") {
      state.bindings = route.request().postDataJSON().mcpServers;
      // Binding compiles the server, so OpenClaw can now report its login.
      for (const id of state.bindings) state.status[id] = { oauthStatus: "connected" };
      return route.fulfill({ json: { ...home, mcpServers: state.bindings } });
    }
    if (path === "/api/assistant-runtime")
      return route.fulfill({ json: { availability: "ready", sync: "current" } });
    return route.fulfill({ json: {} });
  });
  await page.route(/\/api\/mcp-servers/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const listed = () =>
      state.servers.map((server) =>
        server.auth === "oauth"
          ? {
              ...server,
              ...(state.status[server.id] || { oauthStatus: "not-connected" }),
            }
          : server,
      );
    if (path === "/api/mcp-servers/cli-finds")
      return route.fulfill({ json: { finds: [], problems: [] } });
    if (method === "GET") return route.fulfill({ json: listed() });
    const body = request.postDataJSON?.() || {};
    state.requests.push({ path, method, body });
    const id = path.split("/")[3];
    const server = state.servers.find((s) => s.id === id);
    if (path.endsWith("/oauth/login")) {
      if (state.refusal) {
        const [status, message] = refusals[state.refusal];
        return route.fulfill({
          status,
          json: { code: state.refusal, error: message, ...messageIdentity(message) },
        });
      }
      state.status[id] = { oauthStatus: "login-pending" };
      return route.fulfill({
        json: {
          status: "authorize",
          authorizationUrl: `${provider}/authorize?client_id=c&state=s-${id}`,
        },
      });
    }
    if (path.endsWith("/oauth/logout")) {
      state.status[id] = { oauthStatus: "not-connected" };
      return route.fulfill({ status: 204, body: "" });
    }
    if (method === "POST") {
      const created = {
        id: `s${state.nextId++}`,
        name: body.name,
        transport: body.transport,
        url: body.url,
        headerNames: Object.keys(body.headers || {}),
        envNames: [],
        auth: body.auth || "headers",
        ...(body.oauthScope ? { oauthScope: body.oauthScope } : {}),
        revision: 1,
      };
      state.servers.push(created);
      return route.fulfill({ status: 201, json: created });
    }
    if (method === "PUT") {
      if (body.auth) server.auth = body.auth;
      if (server.auth === "oauth") server.headerNames = [];
      server.revision += 1;
      return route.fulfill({ json: server });
    }
    state.servers = state.servers.filter((s) => s.id !== id);
    return route.fulfill(
      state.deferLogout
        ? {
            json: {
              ...(state.pendingApply ? { pending: true } : {}),
              oauthWarning: {
                code: "oauth-logout-deferred",
                error: german.oauthLogoutDeferred,
                messageKey: "mcpServers.oauthLogoutDeferred",
              },
            },
          }
        : { status: 204, body: "" },
    );
  });
  // A cancelled navigation keeps the page, like a tab that comes back from the
  // provider. (WebKit renders a fulfilled attachment instead of downloading it.)
  await page.route(`${provider}/**`, (route) =>
    state.providerStays
      ? route.abort("aborted")
      : route.fulfill({ contentType: "text/html", body: "<h1>Provider consent</h1>" }),
  );
  return state;
}

const oauthServer = (id, name, extra = {}) => ({
  id,
  name,
  transport: "http",
  url: `https://${name}.example/mcp`,
  headerNames: [],
  envNames: [],
  auth: "oauth",
  revision: 1,
  ...extra,
});

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
    // Phones show the hub and a subpage one at a time.
    const hub = async (page) => {
      if (label === "phone") await backToAccounts(page);
    };

    test("an OAuth server is created, logged in through the provider and logged out", async ({
      page,
    }) => {
      const state = await setup(page);
      await page.goto(baseURL + "/accounts");
      const panel = page.getByRole("region", { name: "MCP servers" });
      const wizard = await openAdd(page);
      await chooseSource(wizard, "Server on the internet");
      await wizard.getByLabel("Name", { exact: true }).fill("docs");
      await wizard
        .getByLabel("Address", { exact: true })
        .fill("https://docs.example/mcp");
      await wizard.getByRole("radio", { name: /^OAuth/ }).check();
      // OAuth uses no headers; the scope sits in the advanced section.
      await expect(wizard.getByLabel("Token", { exact: true })).toHaveCount(0);
      await expect(
        wizard.getByText("You sign in once per CLI after saving."),
      ).toBeVisible();
      await wizard.getByText("Advanced", { exact: true }).click();
      await wizard.getByLabel("OAuth scope (optional)").fill(" read write ");
      if (label === "phone") await fits(page);
      await primary(wizard).click();
      await expect(
        wizard.getByText("With this sign-in no headers are sent."),
      ).toBeVisible();
      await primary(wizard).click();
      await wizard.getByRole("button", { name: "Save server" }).click();
      await wizard.getByRole("button", { name: "Skip for now" }).click();
      await wizard.getByRole("button", { name: "Open server" }).click();
      await expect(page).toHaveURL(/item=s1$/);
      expect(state.requests[0].body).toEqual({
        name: "docs",
        transport: "http",
        url: "https://docs.example/mcp",
        auth: "oauth",
        oauthScope: "read write",
        origin: "manual",
      });
      // The page lands on the new server.
      const item = accountDetail(page);
      await expect(item.getByText("Not connected", { exact: true })).toBeVisible();
      await expect(item).toContainText("read write");
      state.status.s1 = { oauthStatus: "login-required" };
      await page.reload();
      await expect(item.getByText("Login required", { exact: true })).toBeVisible();
      if (label === "phone") await fits(page);
      // Log in navigates this tab to the provider (a home-screen app keeps it).
      await item.getByRole("button", { name: "Log in to docs" }).click();
      await expect(page).toHaveURL(`${provider}/authorize?client_id=c&state=s-s1`);
      await expect(page.getByText("Provider consent")).toBeVisible();
      // The provider returned through the callback, which redirects here.
      state.status.s1 = {
        oauthStatus: "connected",
        oauthExpiresAt: Date.UTC(2099, 0, 1),
      };
      await page.goto(baseURL + "/accounts?oauth=connected&server=s1");
      const banner = panel.getByRole("status").filter({ hasText: "Logged in to docs" });
      await expect(banner).toHaveText(/Agents bound to it can use its tools/);
      await expect(page).toHaveURL(baseURL + "/accounts");
      await panel.getByRole("button", { name: "Dismiss" }).click();
      await expect(banner).toHaveCount(0);
      await openAccountItem(page, "docs");
      await expect(item.getByText("Connected", { exact: true })).toBeVisible();
      await expect(item.getByText(/Access valid until .*2099/)).toBeVisible();
      await expect(item.getByRole("button", { name: "Log in to docs" })).toHaveCount(0);
      if (label === "phone") await fits(page);
      await item.getByRole("button", { name: "Log out of docs" }).click();
      // The confirmation shows next to the buttons, also on phones.
      await expect(item.getByText("Logged out of docs.")).toBeVisible();
      await expect(item.getByText("Not connected", { exact: true })).toBeVisible();
      expect(state.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        "POST /api/mcp-servers",
        "POST /api/mcp-servers/s1/oauth/login",
        "POST /api/mcp-servers/s1/oauth/logout",
      ]);
    });

    test("login refusals explain the address, registration and redirect", async ({
      page,
    }) => {
      const state = await setup(page);
      state.servers.push(oauthServer("s1", "docs"));
      await page.goto(baseURL + "/accounts");
      const item = await openAccountItem(page, "docs");
      const login = item.getByRole("button", { name: "Log in to docs" });
      state.refusal = "plain-http-remote";
      await login.click();
      await expect(item.getByRole("alert")).toHaveText(
        "OAuth needs HTTPS or the AgentPier host itself. Open AgentPier through Tailscale (HTTPS) or directly on the AgentPier host.",
      );
      // The notice shows next to the buttons, also on phones.
      await expect(
        item.getByRole("status").filter({ hasText: /^OAuth logins cannot start/ }),
      ).toContainText(
        "OAuth logins cannot start from the address you opened AgentPier with.",
      );
      expect(page.url()).toContain(baseURL + "/accounts");
      state.refusal = "loopback-redirect";
      await login.click();
      await expect(item.getByRole("alert")).toContainText(
        "The login returns to the local address of the AgentPier host.",
      );
      state.refusal = "no-dynamic-registration";
      await login.click();
      await expect(item.getByRole("alert")).toHaveText(
        "This provider does not support automatic client registration. Use a token in the headers instead.",
      );
      state.refusal = "redirect-rejected";
      await login.click();
      await expect(item.getByRole("alert")).toHaveText(
        "The provider rejected the redirect address http://127.0.0.1:4380/api/mcp-servers/oauth/callback.",
      );
      if (label === "phone") await fits(page);
      // An accepted login lifts the address notice; a page restored from the
      // back-forward cache releases the buttons and refreshes the statuses.
      state.refusal = "";
      state.providerStays = true;
      await login.click();
      await expect(login).toHaveText("Opening login …");
      await expect(login).toBeDisabled();
      expect(page.url()).toContain(baseURL + "/accounts");
      await expect(item.getByText(/cannot start from the address/)).toHaveCount(0);
      state.status.s1 = { oauthStatus: "login-required" };
      await page.evaluate(() =>
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
      );
      await expect(login).toHaveText("Log in");
      await expect(login).toBeEnabled();
      await expect(item.getByText("Login required", { exact: true })).toBeVisible();
    });

    test("a failed callback names the reason and the redirect in use", async ({
      page,
    }) => {
      const state = await setup(page);
      state.servers.push(oauthServer("s1", "docs"));
      await page.goto(
        baseURL + "/accounts?oauth=error&server=s1&reason=redirect-rejected",
      );
      const panel = page.getByRole("region", { name: "MCP servers" });
      await expect(panel.getByRole("alert")).toHaveText(
        `The login to docs failed. The provider rejected the redirect address ${baseURL}/api/mcp-servers/oauth/callback.Dismiss`,
      );
      await expect(page).toHaveURL(baseURL + "/accounts");
      await page.goto(baseURL + "/accounts?oauth=error&server=s1&reason=access_denied");
      await expect(panel.getByRole("alert")).toContainText(
        "The login to docs failed. Access was denied at the provider.",
      );
      await page.goto(baseURL + "/accounts?oauth=error&reason=unavailable");
      await expect(panel.getByRole("alert")).toContainText(
        "The OAuth login failed. AgentPier could not complete the login right now",
      );
      if (label === "phone") await fits(page);
    });

    test("switching to OAuth confirms that stored headers are deleted", async ({
      page,
    }) => {
      const state = await setup(page);
      state.servers.push({
        ...oauthServer("s1", "docs"),
        auth: "headers",
        headerNames: ["Authorization"],
      });
      await page.goto(baseURL + "/accounts");
      await page.goto(`${baseURL}/accounts?section=mcp-servers&item=s1&step=setup`);
      const dialog = accountDetail(page);
      await dialog.getByRole("radio", { name: "OAuth", exact: true }).check();
      const save = accountSaveBar(page).getByRole("button", { name: "Save changes" });
      await save.click();
      const confirmation = page.getByRole("alertdialog", { name: "Switch to OAuth?" });
      await expect(confirmation).toContainText(
        "Saving deletes the stored headers Authorization",
      );
      if (label === "phone") await fits(page);
      await confirmation.getByRole("button", { name: "Cancel" }).click();
      expect(state.requests).toHaveLength(0);
      await save.click();
      await page.getByRole("button", { name: "Delete headers and save" }).click();
      await expect(page).toHaveURL(/item=s1$/);
      expect(state.requests[0].body).toEqual({
        revision: 1,
        auth: "oauth",
        oauthScope: "",
      });
      await expect(dialog.getByText("Not connected", { exact: true })).toBeVisible();
    });

    test("statuses show on the list and the agent, and deferred logouts warn", async ({
      page,
    }) => {
      const state = await setup(page);
      state.servers.push(
        oauthServer("s1", "docs"),
        oauthServer("s2", "wiki"),
        oauthServer("s3", "tracker"),
      );
      state.status = {
        s1: { oauthStatus: "unknown" },
        s2: {
          oauthStatus: "login-required",
          oauthReason: {
            code: "logout-pending",
            error: german.oauthLogoutPending,
            messageKey: "mcpServers.oauthLogoutPending",
          },
        },
        s3: { oauthStatus: "connected" },
      };
      state.bindings = ["s1", "s3"];
      await page.goto(baseURL + "/accounts");
      const panel = page.getByRole("region", { name: "MCP servers" });
      const detail = accountDetail(page);
      await openAccountItem(page, "docs");
      await expect(detail.getByText("Status unknown", { exact: true })).toBeVisible();
      await expect(detail).toContainText("The login status cannot be read right now");
      await hub(page);
      await openAccountItem(page, "wiki");
      await expect(detail.getByText("Removing old login", { exact: true })).toBeVisible();
      await expect(detail).toContainText("The previous login is still being removed.");
      if (label === "phone") await fits(page);
      state.deferLogout = true;
      state.pendingApply = true;
      await detail.getByRole("button", { name: "Remove wiki" }).click();
      await detail.getByRole("button", { name: "Remove server" }).click();
      await expect(panel.getByRole("status").filter({ hasText: /^Saved/ })).toHaveText(
        "Saved \u2014 will be applied to running agents shortly. Saved. The previous OAuth login could not be removed right now; AgentPier retries in the background.",
      );
      await page.goto(baseURL + settingsPath("capabilities"));
      const agent = page.getByRole("region", { name: "MCP servers" });
      await expect(agent.getByLabel(/docs/)).toBeChecked();
      await expect(agent.getByText("Status unknown", { exact: true })).toBeVisible();
      await expect(agent.getByText("Connected", { exact: true })).toBeVisible();
      await expect(agent).toContainText("Log in to OAuth servers under Accounts");
      if (label === "phone") await fits(page);
      // Saving the bindings reads the statuses again; a save needs a change.
      await agent.getByLabel(/tracker/).uncheck();
      await saveBar(page).getByRole("button", { name: "Save agent" }).click();
      await expect(agent.getByText("MCP servers saved.")).toBeVisible();
      await agent.getByLabel(/tracker/).check();
      await saveBar(page).getByRole("button", { name: "Save agent" }).click();
      await expect(agent.getByText("MCP servers saved.")).toBeVisible();
      await expect(agent.getByText("Connected", { exact: true })).toHaveCount(2);
      await expect(agent).not.toContainText("Log in to OAuth servers under Accounts");
    });
  });
}

test("German copy for status, login and the callback result", async ({ page }) => {
  const state = await setup(page, { language: "de" });
  state.servers.push(oauthServer("s1", "docs"));
  state.status.s1 = { oauthStatus: "login-required" };
  await page.goto(baseURL + "/accounts?oauth=error&server=s1&reason=access_denied");
  const panel = page.getByRole("region", { name: "MCP-Server" });
  await expect(panel.getByRole("alert")).toContainText(
    "Die Anmeldung bei docs ist fehlgeschlagen. Der Zugriff wurde beim Anbieter abgelehnt.",
  );
  const item = await openAccountItem(page, "docs");
  await expect(item.getByText("Anmeldung nötig", { exact: true })).toBeVisible();
  await expect(item.getByRole("button", { name: "Bei docs anmelden" })).toBeVisible();
  await expect(item.getByRole("button", { name: "Von docs abmelden" })).toBeVisible();
});
