import { test, expect } from "@playwright/test";
import { openAccountItem } from "../helpers/accounts-browser.js";
import { baseURL } from "../helpers/browser.js";
import { header, setup } from "./mcp-cli-fixture.js";

const authorize = "https://as.example.test/authorize?state=abc";
const port = new URL(baseURL).port;

/** An OAuth server bound to Codex with four managed accounts in every state. */
const codexServer = (accounts) =>
  header({
    id: "s2",
    name: "search",
    auth: "oauth",
    headerNames: [],
    clis: ["codex"],
    cliSupport: {
      claude: { supported: true },
      codex: { supported: true },
      opencode: { supported: true },
    },
    cliStatus: {
      codex: {
        status: "written",
        oauth: {
          state: "login-required",
          command: "codex mcp login search",
          accounts: accounts ?? [
            { id: "a1", name: "Work", state: "connected" },
            { id: "a2", name: "Private", state: "login-required" },
            { id: "a3", name: "Spare", state: "unknown" },
            { id: "a4", name: "Ops", state: "failed", reason: "access_denied" },
          ],
        },
      },
    },
    users: { agents: [], clis: ["codex"] },
  });

const accountsOf = (state) => state.servers[0].cliStatus.codex.oauth.accounts;
const setState = (state, id, next) => {
  const account = accountsOf(state).find((item) => item.id === id);
  Object.assign(account, next);
  if (next.state !== "failed") delete account.reason;
};

/** Stands in for window.open: records what the login tab was sent to. */
async function fakeTabs(page, { blocked = false } = {}) {
  await page.addInitScript((refuse) => {
    window.__tabs = [];
    window.open = (url, target) => {
      if (refuse) return null;
      const tab = {
        url,
        target,
        opener: window,
        closed: false,
        location: { replace: (next) => (tab.url = next) },
        close: () => (tab.closed = true),
      };
      window.__tabs.push(tab);
      return tab;
    };
  }, blocked);
}
const tabs = (page) =>
  page.evaluate(() =>
    window.__tabs.map(({ url, target, opener, closed }) => ({
      url,
      target,
      opener: opener === null ? null : "page",
      closed,
    })),
  );

function handleLogins(state, { start } = {}) {
  state.handle = async ({ route, request, path, body }) => {
    if (path !== "/api/mcp-servers/s2/cli-oauth/codex/login") return false;
    if (request.method() === "POST") {
      if (start) return start({ route, body });
      setState(state, body.accountId, { state: "pending" });
      return route.fulfill({ json: { authorizationUrl: authorize } });
    }
    setState(state, body.accountId, { state: "login-required" });
    return route.fulfill({ status: 204, body: "" });
  };
}

test("each managed Codex account shows its login and logs in in a new tab", async ({
  page,
}) => {
  await fakeTabs(page);
  const state = await setup(page, { servers: [codexServer()] });
  handleLogins(state);
  await page.goto(baseURL + "/accounts");
  await openAccountItem(page, "search");
  const area = page.getByRole("group", { name: "Codex accounts for search" });
  // The owner's own profile keeps the CLI's command.
  await expect(
    page.getByText("Log in once in your Codex profile: codex mcp login search"),
  ).toBeVisible();
  await expect(area.getByText("Work: logged in")).toHaveClass(/mcp-oauth-connected/);
  await expect(area.getByText("Private: login required")).toBeVisible();
  await expect(area.getByText("Spare: status unknown")).toBeVisible();
  await expect(
    area.getByText("Ops: login failed. Access was denied at the provider."),
  ).toBeVisible();
  await expect(
    area.getByRole("button", { name: "Log in to search in the Codex account Work" }),
  ).toHaveCount(0);
  await expect(area.getByRole("list")).toHaveAttribute("aria-live", "polite");

  await area
    .getByRole("button", { name: "Log in to search in the Codex account Private" })
    .click();
  await expect(area.getByText("Private: login in progress")).toBeVisible();
  expect(await tabs(page)).toEqual([
    { url: authorize, target: "_blank", opener: null, closed: false },
  ]);
  await expect(area.getByText(/Complete the login in the new tab/)).toBeVisible();
  const post = state.requests.find((r) => r.method === "POST");
  expect(post).toMatchObject({
    path: "/api/mcp-servers/s2/cli-oauth/codex/login",
    body: { accountId: "a2" },
  });

  // The list follows the login by itself while it is pending.
  setState(state, "a2", { state: "connected" });
  await expect(area.getByText("Private: logged in")).toBeVisible({ timeout: 8000 });
  await expect(area.getByText(/Complete the login in the new tab/)).toHaveCount(0);
});

test("a pending login can be cancelled", async ({ page }) => {
  await fakeTabs(page);
  const state = await setup(page, {
    servers: [codexServer([{ id: "a2", name: "Private", state: "pending" }])],
  });
  handleLogins(state);
  await page.goto(baseURL + "/accounts");
  await openAccountItem(page, "search");
  const area = page.getByRole("group", { name: "Codex accounts for search" });
  await area
    .getByRole("button", {
      name: "Cancel the login to search in the Codex account Private",
    })
    .click();
  await expect(area.getByText("Private: login required")).toBeVisible();
  const cancel = state.requests.find((r) => r.method === "DELETE");
  expect(cancel.body).toEqual({ accountId: "a2" });
});

test("a refused tab offers the login page as a link", async ({ page }) => {
  await fakeTabs(page, { blocked: true });
  const state = await setup(page, { servers: [codexServer()] });
  handleLogins(state);
  await page.goto(baseURL + "/accounts");
  await openAccountItem(page, "search");
  const area = page.getByRole("group", { name: "Codex accounts for search" });
  await area
    .getByRole("button", { name: "Log in to search in the Codex account Spare" })
    .click();
  const link = area.getByRole("link", {
    name: "Open the login page for the Codex account Spare",
  });
  await expect(link).toHaveAttribute("href", authorize);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
});

test("over plain HTTP from the network only the CLI command is offered", async ({
  page,
}) => {
  await fakeTabs(page);
  const state = await setup(page, { servers: [codexServer()] });
  handleLogins(state, {
    start: ({ route }) =>
      route.fulfill({
        status: 409,
        json: { code: "plain-http-remote", error: "OAuth needs HTTPS." },
      }),
  });
  await page.goto(baseURL + "/accounts");
  await openAccountItem(page, "search");
  const area = page.getByRole("group", { name: "Codex accounts for search" });
  await area
    .getByRole("button", { name: "Log in to search in the Codex account Private" })
    .click();
  await expect(
    area.getByText(
      `Logging in needs AgentPier's HTTPS address (Tailscale) or a browser on the AgentPier host itself. Open AgentPier one of those ways and log in there, or forward its port over SSH (ssh -L ${port}:127.0.0.1:${port} <AgentPier host>) and open http://127.0.0.1:${port}.`,
    ),
  ).toBeVisible();
  await expect(area.getByRole("button")).toHaveCount(0);
  expect((await tabs(page))[0].closed).toBe(true);
});

test("a login Codex cannot start shows its error and closes the tab", async ({
  page,
}) => {
  await fakeTabs(page);
  const state = await setup(page, { servers: [codexServer()] });
  handleLogins(state, {
    start: ({ route }) =>
      route.fulfill({
        status: 502,
        json: {
          code: "cli-failed",
          error: "Codex konnte die Anmeldung nicht starten. Bitte erneut versuchen.",
          messageKey: "mcpServers.cliLoginFailed",
        },
      }),
  });
  await page.goto(baseURL + "/accounts");
  await openAccountItem(page, "search");
  const area = page.getByRole("group", { name: "Codex accounts for search" });
  await area
    .getByRole("button", { name: "Log in to search in the Codex account Private" })
    .click();
  await expect(
    area.getByText("Codex could not start the login. Please try again."),
  ).toBeVisible();
  expect((await tabs(page))[0].closed).toBe(true);
});

test("the callback's result names the account and the server", async ({ page }) => {
  await setup(page, { servers: [codexServer()] });
  await page.goto(baseURL + "/accounts?oauth=connected&server=s2&cli=codex&account=a1");
  await expect(
    page.getByText(
      "The Codex account Work is logged in to search. New sessions of this account can use its tools.",
    ),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/connections$/);
});

test("without managed accounts the area says so", async ({ page }) => {
  await setup(page, { servers: [codexServer([])] });
  await page.goto(baseURL + "/accounts");
  await openAccountItem(page, "search");
  await expect(
    page
      .getByRole("group", { name: "Codex accounts for search" })
      .getByText("No Codex accounts managed by AgentPier yet."),
  ).toBeVisible();
});

test("German: Codex-Accounts mit Status, Anmelden und Ergebnis", async ({ page }) => {
  await fakeTabs(page);
  const state = await setup(page, { language: "de", servers: [codexServer()] });
  handleLogins(state);
  await page.goto(
    baseURL + "/accounts?oauth=error&server=s2&cli=codex&account=a4&reason=access_denied",
  );
  await expect(
    page.getByText(
      "Die Anmeldung des Codex-Accounts Ops bei search ist fehlgeschlagen. Der Zugriff wurde beim Anbieter abgelehnt.",
    ),
  ).toBeVisible();
  await openAccountItem(page, "search");
  const area = page.getByRole("group", { name: "Codex-Accounts für search" });
  await expect(area.getByText("Work: angemeldet")).toBeVisible();
  await expect(area.getByText("Spare: Status unbekannt")).toBeVisible();
  await area
    .getByRole("button", { name: "Im Codex-Account Private bei search anmelden" })
    .click();
  await expect(area.getByText("Private: Anmeldung läuft")).toBeVisible();
  await expect(
    area.getByRole("button", {
      name: "Anmeldung bei search im Codex-Account Private abbrechen",
    }),
  ).toBeVisible();
});

test("a connected account can log in again, for a login revoked at the provider", async ({
  page,
}) => {
  await fakeTabs(page);
  const state = await setup(page, { servers: [codexServer()] });
  handleLogins(state);
  await page.goto(baseURL + "/accounts");
  await openAccountItem(page, "search");
  const area = page.getByRole("group", { name: "Codex accounts for search" });
  const again = area.getByRole("button", {
    name: "Log in to search again in the Codex account Work",
  });
  await expect(again).toHaveText("Log in again");
  await again.click();
  await expect(area.getByText("Work: login in progress")).toBeVisible();
  expect((await tabs(page))[0].url).toBe(authorize);
  expect(state.requests.find((r) => r.method === "POST").body).toEqual({
    accountId: "a1",
  });
});

test("German: erneut anmelden und Hinweis ohne HTTPS", async ({ page }) => {
  await fakeTabs(page);
  const state = await setup(page, { language: "de", servers: [codexServer()] });
  handleLogins(state, {
    start: ({ route }) =>
      route.fulfill({ status: 409, json: { code: "plain-http-remote", error: "x" } }),
  });
  await page.goto(baseURL + "/accounts");
  await openAccountItem(page, "search");
  const area = page.getByRole("group", { name: "Codex-Accounts für search" });
  await area
    .getByRole("button", { name: "Im Codex-Account Work erneut bei search anmelden" })
    .click();
  await expect(
    area.getByText(
      `Die Anmeldung braucht die HTTPS-Adresse von AgentPier (Tailscale) oder einen Browser auf dem AgentPier-Rechner selbst. AgentPier auf einem dieser Wege öffnen und dort anmelden, oder den Port per SSH weiterleiten (ssh -L ${port}:127.0.0.1:${port} <AgentPier-Rechner>) und http://127.0.0.1:${port} öffnen.`,
    ),
  ).toBeVisible();
});
