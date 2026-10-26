import { test, expect } from "@playwright/test";
import { accountDetail, openAccountItem, saveBar } from "../helpers/accounts-browser.js";
import { baseURL } from "../helpers/browser.js";
import { bound, finds, header, openAdd, setup, stdioServer } from "./mcp-cli-fixture.js";
import {
  chooseSource,
  commandToConnect,
  primary,
  wizardSetup,
  writes,
} from "./mcp-wizard-fixture.js";

const openStep = async (page, step) => {
  await page.goto(`${baseURL}/accounts?section=mcp-servers&item=s1&step=${step}`);
  return accountDetail(page);
};

test("the central MCP list is on Accounts without agents and offers no agent login", async ({
  page,
}) => {
  await setup(page, { servers: [header({ auth: "oauth", headerNames: [] })] });
  await page.goto(baseURL + "/connections?section=mcp-servers");
  await expect(
    page.getByRole("heading", { name: "MCP servers", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("docs", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /log in/i })).toHaveCount(0);
});

test("the wizard offers coding CLIs, explains a disabled one and saves the choice", async ({
  page,
}) => {
  const state = await wizardSetup(page);
  await page.goto(baseURL + "/connections?section=mcp-servers");
  await expect(
    page.getByText("Running sessions see changes after a restart."),
  ).toBeVisible();
  const wizard = await openAdd(page);
  await chooseSource(wizard, "Server on the internet");
  await wizard.getByLabel("Name", { exact: true }).fill("docs");
  await wizard
    .getByLabel("Address", { exact: true })
    .fill("https://mcp.example.test/sse");
  await wizard.getByLabel("Address", { exact: true }).blur();
  await expect(wizard.getByText("Connection: SSE")).toBeVisible();
  await primary(wizard).click();
  await expect(
    wizard.getByRole("heading", { level: 1, name: "Settings for docs" }),
  ).toBeFocused();
  await primary(wizard).click();
  await wizard.getByRole("button", { name: "Save server" }).click();
  const codex = wizard.getByRole("switch", { name: "Codex" });
  await expect(codex).toBeDisabled();
  await expect(wizard.getByText("Codex does not support SSE servers.")).toBeVisible();
  await wizard.getByRole("switch", { name: "Claude Code" }).check();
  await expect(primary(wizard)).toHaveText("Save and connect");
  await primary(wizard).click();
  await expect(page).toHaveURL(/step=done/);
  expect(writes(state)).toHaveLength(2);
  expect(writes(state)[0].body).toMatchObject({
    name: "docs",
    transport: "sse",
    url: "https://mcp.example.test/sse",
  });
  expect(writes(state)[0].body.clis).toBeUndefined();
  expect(writes(state)[1]).toEqual({
    method: "PUT",
    path: "/api/mcp-servers/s1",
    body: { revision: 1, clis: ["claude"] },
  });
  await expect(wizard.getByText("Claude Code: written")).toBeVisible();
});

test("a working directory rules out Claude Code only", async ({ page }) => {
  await wizardSetup(page);
  await page.goto(baseURL + "/connections?section=mcp-servers");
  const wizard = await openAdd(page);
  await chooseSource(wizard, /Own command/);
  await wizard.getByLabel("Name", { exact: true }).fill("tool");
  await wizard.getByLabel("Command").fill("uvx");
  await expect(primary(wizard)).toBeEnabled();
  await primary(wizard).click();
  await wizard.getByText(/^Arguments and working directory/).click();
  await wizard
    .getByLabel("Working directory (optional, absolute path or agent placeholder)")
    .fill("/w");
  await primary(wizard).click();
  await wizard.getByRole("button", { name: "Allow and save" }).click();
  const claude = wizard.getByRole("switch", { name: "Claude Code" });
  await expect(claude).toBeDisabled();
  await expect(claude).not.toBeChecked();
  await expect(wizard.getByText(/^Claude Code cannot start/)).toBeVisible();
  await expect(wizard.getByRole("switch", { name: "Codex" })).toBeEnabled();
  await expect(wizard.getByRole("switch", { name: "OpenCode" })).toBeEnabled();
});

test("a local command for a CLI is confirmed before anything is saved", async ({
  page,
}) => {
  const state = await wizardSetup(page);
  await page.goto(baseURL + "/connections?section=mcp-servers");
  const wizard = await openAdd(page);
  await commandToConnect(wizard);
  await wizard.getByRole("switch", { name: "Codex" }).check();
  const consent = wizard.getByRole("region", { name: "What this allows" });
  await expect(
    consent.getByText(/Runs on this computer with your user's rights/),
  ).toBeVisible();
  await expect(primary(wizard)).toHaveText("Allow and connect");
  expect(writes(state).filter((r) => r.method === "PUT")).toHaveLength(0);
  await primary(wizard).click();
  await expect(page).toHaveURL(/step=done/);
  const puts = writes(state).filter((r) => r.method === "PUT");
  expect(puts).toHaveLength(1);
  expect(puts[0].body).toEqual({ revision: 1, clis: ["codex"], confirmStdio: true });
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
  const view = await openStep(page, "setup");
  await view.getByLabel("Working directory").fill("/w");
  await expect(view.locator(".mcp-cli-notes")).toHaveText(
    "Saving removes docs from Claude Code.",
  );
  await saveBar(page).getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(/item=s1$/);
  const sent = state.requests.filter((r) => r.method !== "GET");
  expect(sent.map((r) => `${r.method} ${r.path}`)).toEqual(["PUT /api/mcp-servers/s1"]);
  expect(sent[0].body).toMatchObject({ cwd: "/w", clis: ["codex"] });
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
  const view = await openStep(page, "setup");
  await view.getByLabel("Working directory").fill("relative");
  await saveBar(page).getByRole("button", { name: "Save changes" }).click();
  await expect(saveBar(page).getByRole("alert")).toBeVisible();
  await expect(page).toHaveURL(/step=setup/);
  await expect(view.getByLabel("Working directory")).toHaveValue("relative");
  const sent = state.requests.filter((r) => r.method !== "GET");
  expect(sent.map((r) => `${r.method} ${r.path}`)).toEqual(["PUT /api/mcp-servers/s1"]);
  expect(sent[0].body.clis).toEqual(["codex"]);
  expect(state.servers[0].clis).toEqual(["claude", "codex"]);
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
  await page.goto(baseURL + "/connections?section=mcp-servers");
  await openAccountItem(page, "docs");
  await expect(page.getByText("Agents: Home · CLIs: Claude Code, Codex")).toBeVisible();
  await expect(page.getByText("Codex: edited by hand in the CLI")).toBeVisible();
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
  await openAccountItem(page, "search");
  // Codex status comes from the owner's profile; managed accounts are listed below it.
  await expect(
    page.getByText("Log in once in your Codex profile: codex mcp login search"),
  ).toBeVisible();
  await expect(
    page
      .getByRole("group", { name: "Codex accounts for search" })
      .getByText("No Codex accounts managed by AgentPier yet."),
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
  await page.goto(baseURL + "/connections?section=mcp-servers");
  await openAccountItem(page, "docs");
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
  await page.goto(baseURL + "/connections?section=mcp-servers");
  await openAccountItem(page, "docs");
  await expect(page.getByText("Codex: in der CLI von Hand geändert")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Änderung übernehmen: docs aus Codex" }),
  ).toBeVisible();
  await expect(page.getByText("Agenten: Home · CLIs: Claude Code, Codex")).toBeVisible();
});

test("entries found in the CLIs are adopted one by one or all at once, names only", async ({
  page,
}) => {
  const state = await setup(page, {
    finds,
    problems: [
      {
        cli: "claude",
        reason: "unreadable",
        messageKey: "mcpServers.cliReasonUnreadable",
      },
    ],
  });
  state.handle = async ({ route, path, body }) => {
    if (path !== "/api/mcp-servers/cli-finds/adopt") return false;
    const keys = body.all ? ["k1", "k2"] : body.keys;
    state.finds = state.finds.filter((find) => !keys.includes(find.key));
    return route.fulfill({
      json: {
        adopted: keys.map((key) => header({ id: key, name: body.names[key] })),
        failed: [],
      },
    });
  };
  await page.goto(baseURL + "/connections?section=mcp-servers");
  await openAccountItem(page, "Found in the CLIs");
  const found = page.getByRole("region", { name: "Found in the CLIs" });
  await expect(found.getByText("in Claude Code, Codex")).toBeVisible();
  await expect(found.getByText("Values: Authorization")).toBeVisible();
  await expect(found.getByText("Values: TOKEN")).toBeVisible();
  await expect(found.getByText("will be saved as /usr/bin/true")).toBeVisible();
  await expect(
    found.getByText("Claude Code: its configuration file cannot be read"),
  ).toBeVisible();
  await expect(
    found.getByText("Uses settings AgentPier does not manage; it stays in the CLI."),
  ).toBeVisible();
  await expect(found.getByLabel("Name in AgentPier")).toHaveValue("my-tool");
  await found.getByLabel("Name in AgentPier").fill("tool");
  await found.getByRole("button", { name: "Adopt my.tool" }).click();
  await expect(found.getByText("my.tool", { exact: true })).toHaveCount(0);
  expect(state.requests.find((r) => r.path.endsWith("/adopt")).body).toEqual({
    keys: ["k2"],
    names: { k2: "tool" },
  });
  await expect(found.getByRole("button", { name: "Adopt all" })).toHaveCount(0);
  state.finds = structuredClone(finds);
  await page.reload();
  await page
    .getByRole("region", { name: "Found in the CLIs" })
    .getByRole("button", { name: "Adopt all" })
    .click();
  await expect
    .poll(() => state.requests.filter((r) => r.path.endsWith("/adopt")).at(-1).body)
    .toEqual({ all: true, names: { k1: "docs", k2: "my-tool" } });
});

test("a found entry that fails to adopt is named; German copy", async ({ page }) => {
  const state = await setup(page, { language: "de", finds: [finds[1]] });
  state.handle = async ({ route, path }) =>
    path.endsWith("/adopt")
      ? route.fulfill({
          json: {
            adopted: [],
            failed: [{ key: "k2", name: "my.tool", error: "Befehl nicht gefunden." }],
          },
        })
      : false;
  await page.goto(baseURL + "/connections?section=mcp-servers");
  await openAccountItem(page, "In den CLIs gefunden");
  const found = page.getByRole("region", { name: "In den CLIs gefunden" });
  await expect(found.getByText("wird gespeichert als /usr/bin/true")).toBeVisible();
  await found.getByRole("button", { name: "my.tool übernehmen" }).click();
  await expect(found.getByRole("status")).toHaveText("my.tool: Befehl nicht gefunden.");
});

test("an adoption failure reads in English from its message key", async ({ page }) => {
  const state = await setup(page, {
    finds: [{ ...finds[1], resolvedCommand: null }],
  });
  state.handle = async ({ route, path }) =>
    path.endsWith("/adopt")
      ? route.fulfill({
          json: {
            adopted: [],
            failed: [
              {
                key: "k2",
                name: "my.tool",
                reason: "name-taken",
                error: "Dieser Servername ist bereits vergeben.",
                messageKey: "mcpServers.nameTaken",
              },
            ],
          },
        })
      : false;
  await page.goto(baseURL + "/connections?section=mcp-servers");
  await openAccountItem(page, "Found in the CLIs");
  const found = page.getByRole("region", { name: "Found in the CLIs" });
  await expect(found.getByText("Command not found on this computer.")).toBeVisible();
  await found.getByRole("button", { name: "Adopt my.tool" }).click();
  await expect(found.getByRole("status")).toHaveText(
    "my.tool: This server name is already in use.",
  );
});

test("the section reports when nothing else is found", async ({ page }) => {
  await setup(page);
  await page.goto(baseURL + "/accounts?section=mcp-servers");
  await expect(page).toHaveURL(/\/connections\?section=mcp-servers$/);
  await openAccountItem(page, "Found in the CLIs");
  const found = page.getByRole("region", { name: "Found in the CLIs" });
  await expect(found.getByText("Nothing else found in the CLIs.")).toBeVisible();
  // The finds open as their own view; the back arrow returns to the server list.
  await page.getByRole("button", { name: "Back to MCP servers" }).click();
  await expect(page.getByRole("region", { name: "MCP servers" })).toBeInViewport();
});
