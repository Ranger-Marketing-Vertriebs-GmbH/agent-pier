import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fixture } from "./providers-fixture.js";

/** The central MCP API; `state` records requests and holds what the list returns. */
async function setup(
  page,
  { language = "en", agents = false, servers = [], finds = [] } = {},
) {
  await fixture(page);
  await page.addInitScript(
    (value) => localStorage.setItem("agentpier-language", value),
    language,
  );
  const state = {
    requests: [],
    servers: structuredClone(servers),
    finds: structuredClone(finds),
  };
  await page.route("**/api/assistant-feature", (route) =>
    route.fulfill({ json: { enabled: agents, error: null } }),
  );
  await page.route(/\/api\/mcp-servers/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postData() ? request.postDataJSON() : undefined;
    state.requests.push({ method: request.method(), path, body });
    if (path === "/api/mcp-servers" && request.method() === "GET")
      return route.fulfill({ json: state.servers });
    if (path === "/api/mcp-servers/cli-finds")
      return route.fulfill({ json: { finds: state.finds } });
    if (state.handle) {
      const handled = await state.handle({ route, request, path, body });
      if (handled !== false) return;
    }
    return route.fulfill({ status: 404, json: { error: "unexpected" } });
  });
  return state;
}

const header = (extra = {}) => ({
  id: "s1",
  name: "docs",
  transport: "http",
  url: "https://mcp.example.test/mcp",
  auth: "headers",
  headerNames: ["Authorization"],
  envNames: [],
  revision: 1,
  ...extra,
});

test("the central MCP list is on Accounts without agents and offers no agent login", async ({
  page,
}) => {
  await setup(page, { servers: [header({ auth: "oauth", headerNames: [] })] });
  await page.goto(baseURL + "/accounts");
  await expect(
    page.getByRole("heading", { name: "MCP servers", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("docs", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /log in/i })).toHaveCount(0);
});

const bound = (extra = {}) =>
  header({
    clis: ["claude", "codex"],
    cliSupport: {
      claude: { supported: true },
      codex: { supported: true },
      opencode: { supported: true },
    },
    cliStatus: { claude: { status: "written" }, codex: { status: "conflict" } },
    users: { agents: ["Home"], clis: ["claude", "codex"] },
    ...extra,
  });

async function openAdd(page) {
  await page
    .getByRole("region", { name: "MCP servers" })
    .getByRole("button", { name: "Add MCP server" })
    .click();
  return page.getByRole("dialog");
}

test("the form offers coding CLIs, explains a disabled one and saves the choice", async ({
  page,
}) => {
  const state = await setup(page);
  state.handle = async ({ route, request, path, body }) => {
    if (path === "/api/mcp-servers" && request.method() === "POST") {
      state.servers.push(
        bound({
          name: body.name,
          transport: body.transport,
          url: body.url,
          clis: body.clis,
          cliStatus: { claude: { status: "written" } },
          users: { agents: [], clis: body.clis },
        }),
      );
      return route.fulfill({ status: 201, json: state.servers[0] });
    }
    return false;
  };
  await page.goto(baseURL + "/accounts");
  await expect(
    page.getByText("Running sessions see changes after a restart."),
  ).toBeVisible();
  const dialog = await openAdd(page);
  await dialog.getByLabel("Name", { exact: true }).fill("docs");
  await dialog.getByRole("radio", { name: "SSE", exact: true }).check();
  await dialog.getByLabel("Address").fill("https://mcp.example.test/sse");
  const codex = dialog.getByRole("checkbox", { name: "Codex" });
  await expect(codex).toBeDisabled();
  await expect(dialog.getByText("Codex does not support SSE servers.")).toBeVisible();
  await dialog.getByRole("checkbox", { name: "Claude Code" }).check();
  await dialog.getByRole("button", { name: "Save server" }).click();
  await expect(dialog).toHaveCount(0);
  const writes = state.requests.filter((r) => r.method !== "GET");
  expect(writes).toHaveLength(1);
  expect(writes[0].body).toMatchObject({
    name: "docs",
    transport: "sse",
    url: "https://mcp.example.test/sse",
    clis: ["claude"],
  });
  await expect(page.getByText("Claude Code: written")).toBeVisible();
  await expect(page.getByText("CLIs: Claude Code")).toBeVisible();
});

test("a working directory rules out Claude Code only", async ({ page }) => {
  await setup(page);
  await page.goto(baseURL + "/accounts");
  const dialog = await openAdd(page);
  await dialog.getByRole("radio", { name: "Local command (stdio)" }).check();
  const claude = dialog.getByRole("checkbox", { name: "Claude Code" });
  await claude.check();
  await dialog.getByLabel("Working directory").fill("/tmp");
  await expect(claude).toBeDisabled();
  await expect(claude).not.toBeChecked();
  await expect(claude).toHaveCSS("opacity", "0.5");
  await expect(dialog.getByText(/^Claude Code cannot start/)).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: "Codex" })).toBeEnabled();
  await expect(dialog.getByRole("checkbox", { name: "OpenCode" })).toBeEnabled();
});

test("a local command for a CLI is confirmed before anything is saved", async ({
  page,
}) => {
  const state = await setup(page);
  state.handle = async ({ route, request, path, body }) => {
    if (path === "/api/mcp-servers" && request.method() === "POST") {
      state.servers.push(
        header({
          name: body.name,
          transport: "stdio",
          url: undefined,
          command: body.command,
          args: [],
          headerNames: [],
          envNames: [],
        }),
      );
      return route.fulfill({ status: 201, json: state.servers[0] });
    }
    return false;
  };
  await page.goto(baseURL + "/accounts");
  const dialog = await openAdd(page);
  await dialog.getByLabel("Name", { exact: true }).fill("local");
  await dialog.getByRole("radio", { name: "Local command (stdio)" }).check();
  await dialog.getByRole("textbox", { name: /^Command/ }).fill("/usr/bin/true");
  await dialog.getByRole("checkbox", { name: "Codex" }).check();
  await dialog.getByRole("button", { name: "Save server" }).click();
  const confirm = dialog.getByRole("alertdialog", {
    name: "Give coding CLIs a local command?",
  });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  // Changing the CLI choice withdraws the question (C19).
  await dialog.getByRole("checkbox", { name: "OpenCode" }).check();
  await expect(confirm).toHaveCount(0);
  await dialog.getByRole("checkbox", { name: "OpenCode" }).uncheck();
  await dialog.getByRole("button", { name: "Save server" }).click();
  await expect(confirm).toBeVisible();
  expect(state.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
  await dialog.getByRole("button", { name: "Confirm and save" }).click();
  await expect(dialog).toHaveCount(0);
  const writes = state.requests.filter((r) => r.method !== "GET");
  expect(writes).toHaveLength(1);
  expect(writes[0].body).toMatchObject({ clis: ["codex"], confirmStdio: true });
});

const stdioServer = () =>
  bound({
    transport: "stdio",
    url: undefined,
    command: "/usr/bin/true",
    args: [],
    headerNames: [],
    envNames: [],
    cliStatus: { claude: { status: "written" }, codex: { status: "written" } },
  });

test("an edit that rules out a bound CLI saves both in one request", async ({ page }) => {
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
  await dialog.getByLabel("Working directory").fill("/tmp");
  await dialog.getByRole("button", { name: "Save server" }).click();
  await expect(dialog).toHaveCount(0);
  const writes = state.requests.filter((r) => r.method !== "GET");
  expect(writes.map((r) => `${r.method} ${r.path}`)).toEqual(["PUT /api/mcp-servers/s1"]);
  expect(writes[0].body).toMatchObject({ cwd: "/tmp", clis: ["codex"] });
});

test("a refused edit keeps the form and changes no CLI", async ({ page }) => {
  const state = await setup(page, { servers: [stdioServer()] });
  state.handle = async ({ route, request, path }) => {
    if (path === "/api/mcp-servers/s1" && request.method() === "PUT")
      return route.fulfill({
        status: 400,
        json: { error: "Das Arbeitsverzeichnis muss ein absoluter Pfad sein." },
      });
    return false;
  };
  await page.goto(baseURL + "/accounts");
  await page.getByRole("button", { name: "Edit docs" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Working directory").fill("relative");
  await dialog.getByRole("checkbox", { name: "Codex" }).uncheck();
  await dialog.getByRole("button", { name: "Save server" }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: "Claude Code" })).toBeDisabled();
  const writes = state.requests.filter((r) => r.method !== "GET");
  expect(writes.map((r) => `${r.method} ${r.path}`)).toEqual(["PUT /api/mcp-servers/s1"]);
  expect(writes[0].body.clis).toEqual([]);
});

test("a conflict offers both choices and an OAuth server the CLI's login command", async ({
  page,
}) => {
  const state = await setup(page, {
    servers: [
      bound(),
      header({
        id: "s2",
        name: "search",
        auth: "oauth",
        headerNames: [],
        clis: ["claude", "codex", "opencode"],
        cliSupport: {
          claude: { supported: true },
          codex: { supported: true },
          opencode: { supported: true },
        },
        cliStatus: {
          claude: { status: "written", oauth: { state: "unknown", command: "/mcp" } },
          codex: {
            status: "written",
            oauth: { state: "login-required", command: "codex mcp login search" },
          },
          opencode: {
            status: "name-taken",
            messageKey: "mcpServers.cliStatusNameTaken",
            oauth: { state: "unknown", command: "opencode mcp auth search" },
          },
        },
        users: { agents: [], clis: ["codex", "opencode"] },
      }),
    ],
  });
  state.handle = async ({ route, path }) => {
    if (path === "/api/mcp-servers/s1/clis/codex/resolve") {
      state.servers[0] = bound({
        cliStatus: { claude: { status: "written" }, codex: { status: "written" } },
      });
      return route.fulfill({ json: state.servers[0] });
    }
    return false;
  };
  await page.goto(baseURL + "/accounts");
  await expect(page.getByText("Agents: Home · CLIs: Claude Code, Codex")).toBeVisible();
  await expect(page.getByText("Codex: edited by hand in the CLI")).toBeVisible();
  await expect(
    page.getByText("Log in once in Codex: run codex mcp login search"),
  ).toBeVisible();
  // An unknown login state is neutral, not an error.
  await expect(
    page.getByText("If OpenCode asks for a login: run opencode mcp auth search"),
  ).toBeVisible();
  await expect(
    page.getByText("If Claude Code asks for a login: open /mcp in Claude Code"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Adopt search from OpenCode" }),
  ).toBeVisible();
  // Problems read differently from a written entry.
  await expect(page.getByText("Codex: edited by hand in the CLI")).toHaveClass(
    /mcp-oauth-login-required/,
  );
  await expect(
    page.locator(".mcp-item").first().getByText("Claude Code: written"),
  ).toHaveClass(/mcp-oauth-connected/);
  const docs = page
    .locator(".mcp-item")
    .filter({ has: page.getByText("docs", { exact: true }) });
  await page
    .getByRole("button", { name: "Write AgentPier's version of docs to Codex" })
    .click();
  await expect(docs.getByText("Codex: written")).toBeVisible();
  // The buttons are gone; focus lands on Codex's row, which a screen reader announces.
  await expect(
    docs.locator(".mcp-cli-status li").filter({ hasText: "Codex:" }),
  ).toBeFocused();
  await expect(docs.locator(".mcp-cli-status ul")).toHaveAttribute("aria-live", "polite");
  expect(state.requests.find((r) => r.path.endsWith("/resolve")).body).toEqual({
    choice: "overwrite",
  });
  await expect(
    page.getByRole("button", { name: "Adopt the change to docs from Codex" }),
  ).toHaveCount(0);
});

test("a CLI that cannot be written names the reason, a failed choice the server's", async ({
  page,
}) => {
  const state = await setup(page, {
    servers: [
      bound({
        cliStatus: {
          claude: {
            status: "error",
            reason: "layout",
            messageKey: "mcpServers.cliReasonLayout",
          },
          codex: { status: "conflict", messageKey: "mcpServers.cliStatusConflict" },
        },
      }),
    ],
  });
  state.handle = async ({ route, path }) => {
    if (path.endsWith("/resolve"))
      return route.fulfill({
        status: 409,
        json: {
          error: "Die Konfiguration der CLI lässt sich nicht schreiben.",
          code: "MCP_CLI_FILE_WRITE_FAILED",
          messageKey: "mcpServers.cliReasonWriteFailed",
        },
      });
    return false;
  };
  await page.goto(baseURL + "/accounts");
  await expect(
    page.getByText(
      "Claude Code: could not write: its configuration file cannot be edited in place without changing other entries",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Adopt the change to docs from Codex" }).click();
  await expect(
    page.getByText("The CLI's configuration cannot be written."),
  ).toBeVisible();
});

test("the CLI statuses read in German", async ({ page }) => {
  await setup(page, { language: "de", servers: [bound()] });
  await page.goto(baseURL + "/accounts");
  await expect(page.getByText("Codex: in der CLI von Hand geändert")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Änderung übernehmen: docs aus Codex" }),
  ).toBeVisible();
  await expect(page.getByText("Agenten: Home · CLIs: Claude Code, Codex")).toBeVisible();
});
