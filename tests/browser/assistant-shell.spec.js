import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { agentTab, saveBar, settingsPath } from "../helpers/agent-settings-page.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";

const levels = ["off", "approval", "full"];
const profile = {
  id: "home",
  name: "Home",
  instructions: "Plan meals",
  revision: 1,
  effectiveRevision: 1,
  model: { connectionId: "router", modelId: "model" },
  capabilities: { memory: false, reminders: false },
};
const command = `/opt/homebrew/bin/gh pr list --limit 5 ${"--json title ".repeat(80)}`;
const execAction = (id, extra = {}) => ({
  id,
  revision: 1,
  assistantId: "home",
  state: "awaiting_approval",
  createdAt: "2026-10-11T10:00:00.000Z",
  expiresAt: "2026-10-11T10:30:00.000Z",
  payload: {
    action: "exec",
    command,
    cwd: "/Users/owner/Projects/demo",
    agentId: "agentpier-home",
    allowedDecisions: ["allow-once", "deny"],
  },
  allowAlwaysByAgentPier: true,
  allowAlwaysPlan: {
    kind: "paths",
    paths: ["/opt/homebrew/bin/gh"],
    writable: ["/opt/homebrew/bin/gh"],
  },
  ...extra,
});

// A stand-in for the server: raising the level needs confirmShell, full also
// confirmFull, lowering needs neither (server/features/assistants/shell-changes.js).
async function setup(page, options = {}) {
  await fixture(page);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const state = {
    agent: { ...profile, ...options.agent },
    patches: [],
    deletes: [],
    creates: [],
    decisions: [],
    actions: options.actions || [],
    entries: options.entries || [],
  };
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path === "/api/assistant-events")
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'data: {"type":"connected"}\n\n',
      });
    if (path === "/api/assistants/home" && method === "PATCH") {
      const body = request.postDataJSON();
      state.patches.push(body);
      const from = state.agent.shell || "off";
      if (body.shell && levels.indexOf(body.shell) > levels.indexOf(from)) {
        const required = [
          ...(body.confirmShell ? [] : ["confirmShell"]),
          ...(body.shell === "full" && !body.confirmFull ? ["confirmFull"] : []),
        ];
        if (required.length)
          return route.fulfill({
            status: 409,
            json: {
              code: "ASSISTANT_SHELL_CONFIRMATION_REQUIRED",
              error: "Bestätigung nötig",
              required,
            },
          });
      }
      state.agent = {
        ...state.agent,
        ...(body.shell ? { shell: body.shell } : {}),
        ...(options.pending ? { shellPending: true } : {}),
        revision: state.agent.revision + 1,
      };
      return route.fulfill({ json: { ...state.agent, pending: !!options.pending } });
    }
    if (path === "/api/assistants/home/shell-allowlist")
      return route.fulfill({ json: { entries: state.entries } });
    if (path.startsWith("/api/assistants/home/shell-allowlist/") && method === "DELETE") {
      const entry = decodeURIComponent(path.split("/").pop());
      state.deletes.push(entry);
      if (entry === "broken")
        return route.fulfill({
          status: 503,
          json: { code: "unavailable", error: "The agent service is not ready." },
        });
      state.entries = state.entries.filter((e) => e.id !== entry);
      return route.fulfill({ json: { removed: entry, entries: state.entries } });
    }
    if (path === "/api/assistants/home/actions")
      return route.fulfill({ json: { actions: state.actions } });
    if (path.endsWith("/decision")) {
      const id = path.split("/")[3];
      state.decisions.push([id, request.postDataJSON()]);
      state.actions = state.actions.filter((a) => a.id !== id);
      // Decided elsewhere or expired: the server refuses and drops it from the list.
      if (id === "stale")
        return route.fulfill({
          status: 409,
          json: { code: "conflict", error: "This request was already decided." },
        });
      return route.fulfill({ json: {} });
    }
    if (path === "/api/assistants" && method === "POST") {
      const body = request.postDataJSON();
      state.creates.push(body);
      if (body.shell && body.shell !== "off" && !body.confirmShell)
        return route.fulfill({
          status: 409,
          json: {
            code: "ASSISTANT_SHELL_CONFIRMATION_REQUIRED",
            error: "Bestätigung nötig",
            required: ["confirmShell"],
          },
        });
      return route.fulfill({ json: { ...profile, id: "fresh", shell: body.shell } });
    }
    if (path === "/api/assistants")
      return route.fulfill({
        json: {
          assistants: [state.agent],
          conversations: [{ id: "chat", assistantId: "home" }],
          models: [{ id: "router", name: "Router", available: true }],
        },
      });
    if (path === "/api/assistant-runtime")
      return route.fulfill({ json: { availability: "ready", sync: "current" } });
    if (path === "/api/assistant-web-search")
      return route.fulfill({
        json: { revision: 0, provider: "duckduckgo", ready: true },
      });
    if (path.endsWith("/messages"))
      return route.fulfill({ json: { messages: [], requests: [], stale: false } });
    if (path === "/api/assistant-channels")
      return route.fulfill({ json: { channels: [] } });
    return route.fulfill({ json: {} });
  });
  return state;
}
const save = (page) => saveBar(page).getByRole("button", { name: "Save agent" });
const shell = (page) => page.locator("#agent-shell");
const allowlist = (page) => page.locator("#agent-allowlist");
const header = (page) => page.locator(".assistant-header-name");

async function fitsPhone(page) {
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

    test("shell is off by default and says what does not work", async ({ page }) => {
      await setup(page);
      await page.goto(baseURL + settingsPath("capabilities"));
      await expect(shell(page).getByRole("radio", { name: /^Off/ })).toBeChecked();
      await expect(shell(page)).toContainText("gh, git or mail programs");
      await expect(header(page).getByText(/^Shell:/)).toHaveCount(0);
      await shell(page)
        .getByRole("link", { name: /^Always allowed commands/ })
        .click();
      await expect(
        allowlist(page).getByText("No always allowed commands."),
      ).toBeVisible();
      if (label === "phone") await fitsPhone(page);
    });

    test("the Capabilities tab leads to the shell group", async ({ page }) => {
      await setup(page);
      await page.goto(baseURL + "/agents/home/settings");
      await agentTab(page, "Capabilities").click();
      await expect(
        shell(page).getByRole("heading", { name: "Shell access", exact: true }),
      ).toBeVisible();
    });

    test("raising the level shows the warning and resubmits with confirmShell", async ({
      page,
    }) => {
      const state = await setup(page);
      await page.goto(baseURL + settingsPath("capabilities"));
      await shell(page)
        .getByRole("radio", { name: /^With approval/ })
        .check();
      await expect(shell(page)).toContainText("can read AgentPier's own data");
      await save(page).click();
      const dialog = page.getByRole("dialog", { name: "Turn on shell access?" });
      await expect(dialog).toContainText("team write guard does not cover shell");
      expect(state.patches).toHaveLength(1);
      expect(state.patches[0].confirmShell).toBeUndefined();
      await dialog.getByRole("button", { name: "Turn on shell access" }).click();
      await expect.poll(() => state.patches.length).toBe(2);
      expect(state.patches[1]).toMatchObject({ shell: "approval", confirmShell: true });
      expect(state.patches[1].confirmFull).toBeUndefined();
      await expect(dialog).toHaveCount(0);
      await expect(header(page).getByText("Shell: approval")).toBeVisible();
    });

    test("a new agent with shell is confirmed before it is created", async ({ page }) => {
      const state = await setup(page);
      await page.goto(baseURL + "/agents");
      await page.getByRole("button", { name: "New agent" }).click();
      await page.getByLabel("Name", { exact: true }).fill("Fresh");
      await page.getByLabel("Model connection").selectOption("router");
      await page.getByRole("textbox", { name: "Model ID" }).fill("model");
      await agentTab(page, "Capabilities").click();
      await shell(page)
        .getByRole("radio", { name: /^With approval/ })
        .check();
      await expect(shell(page).getByText("Always allowed commands")).toHaveCount(0);
      await saveBar(page).getByRole("button", { name: "Create agent" }).click();
      await page
        .getByRole("dialog", { name: "Turn on shell access?" })
        .getByRole("button", { name: "Turn on shell access" })
        .click();
      await expect.poll(() => state.creates.length).toBe(2);
      expect(state.creates[0].confirmShell).toBeUndefined();
      expect(state.creates[1]).toMatchObject({ shell: "approval", confirmShell: true });
    });

    test("full access asks twice before it is saved", async ({ page }) => {
      const state = await setup(page);
      await page.goto(baseURL + settingsPath("capabilities"));
      await shell(page)
        .getByRole("radio", { name: /^Full access/ })
        .check();
      await save(page).click();
      await page
        .getByRole("dialog", { name: "Turn on shell access?" })
        .getByRole("button", { name: "Turn on shell access" })
        .click();
      const full = page.getByRole("dialog", {
        name: "Run every command without asking?",
      });
      await expect(full).toContainText("no prompts at all");
      expect(state.patches.map((p) => [p.confirmShell, p.confirmFull])).toEqual([
        [undefined, undefined],
        [true, undefined],
      ]);
      await full.getByRole("button", { name: "Allow without prompts" }).click();
      await expect.poll(() => state.patches.length).toBe(3);
      expect(state.patches[2]).toMatchObject({
        shell: "full",
        confirmShell: true,
        confirmFull: true,
      });
      await expect(header(page).getByText("Shell: full")).toBeVisible();
      if (label === "phone") await fitsPhone(page);
    });

    test("lowering needs no confirmation and reports a pending apply", async ({
      page,
    }) => {
      const state = await setup(page, { agent: { shell: "full" }, pending: true });
      await page.goto(baseURL + settingsPath("capabilities"));
      await expect(header(page).getByText("Shell: full")).toBeVisible();
      await shell(page).getByRole("radio", { name: /^Off/ }).check();
      await save(page).click();
      await expect.poll(() => state.patches.length).toBe(1);
      expect(state.patches[0]).toMatchObject({ shell: "off" });
      expect(state.patches[0].confirmShell).toBeUndefined();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.goto(baseURL + settingsPath("capabilities"));
      await expect(shell(page).getByRole("status")).toHaveText(
        "The new shell level applies as soon as the agent service is back.",
      );
    });

    test("allowed commands are listed and deleted with their linked entries", async ({
      page,
    }) => {
      const state = await setup(page, {
        agent: { shell: "approval" },
        entries: [
          {
            id: "e1",
            pattern: "/opt/homebrew/bin/gh",
            source: "agentpier",
            kind: "program",
            command: "gh pr list",
            cwd: "/Users/owner/Projects/demo",
            lastUsedAt: Date.parse("2026-10-11T09:00:00Z"),
          },
          {
            id: "e2",
            pattern: "/usr/bin/git",
            argPattern: "sha256:cwd-argv:v1:abc",
            source: "openclaw",
            kind: "program",
            companions: ["c1"],
          },
          {
            id: "c9",
            pattern: "=node-command:0123",
            source: "openclaw",
            kind: "command",
          },
        ],
      });
      await page.goto(baseURL + settingsPath("capabilities", "allowlist"));
      const list = allowlist(page).locator(".assistant-shell-entry");
      await expect(list).toHaveCount(3);
      await expect(list.nth(0)).toContainText("Added by AgentPier");
      await expect(list.nth(0)).toContainText("With any arguments");
      await expect(list.nth(0)).toContainText("gh pr list");
      await expect(list.nth(1)).toContainText("Only with the approved arguments");
      await expect(list.nth(1)).toContainText("Linked command entries: 1");
      await expect(list.nth(2)).toContainText("Exact command");
      await expect(allowlist(page).getByText("=node-command:0123")).toHaveCount(0);
      await allowlist(page)
        .getByRole("button", { name: "Delete entry /usr/bin/git" })
        .click();
      await expect(list).toHaveCount(2);
      expect(state.deletes).toEqual(["e2"]);
      if (label === "phone") await fitsPhone(page);
    });

    test("task-bound members show the selector disabled with the reason", async ({
      page,
    }) => {
      await setup(page, {
        agent: { teamMemberId: "m1", lifetime: "task", shell: "approval" },
      });
      await page.goto(baseURL + settingsPath("capabilities"));
      await expect(shell(page)).toContainText(
        "Task-bound team members never get shell access.",
      );
      for (const name of [/^Off/, /^With approval/, /^Full access/])
        await expect(shell(page).getByRole("radio", { name })).toBeDisabled();
      await expect(shell(page).getByRole("radio", { name: /^Off/ })).toBeChecked();
      await expect(header(page).getByText(/^Shell:/)).toHaveCount(0);
      await expect(shell(page).getByText("Always allowed commands")).toHaveCount(0);
    });

    test("exec approvals are decided once, always or denied", async ({ page }) => {
      const state = await setup(page, {
        agent: { shell: "approval" },
        actions: [
          execAction("always"),
          execAction("once", {
            allowAlwaysPlan: { kind: "once", reason: "interpreter", program: "node" },
            payload: { ...execAction("x").payload, command: "node build.js" },
          }),
          execAction("native", {
            allowAlwaysByAgentPier: false,
            allowAlwaysPlan: undefined,
            payload: { ...execAction("x").payload, command: "ls -la" },
          }),
          execAction("deny", {
            payload: { ...execAction("x").payload, command: "rm x" },
          }),
        ],
      });
      await page.goto(baseURL + "/agents/home/chats/chat");
      const cards = page.getByRole("article", {
        name: "Shell command awaiting approval",
      });
      await expect(cards).toHaveCount(4);
      // Exec cards are pending approval cards: the approval strip can jump to them.
      await expect(cards.nth(0)).toHaveAttribute("data-pending", "");
      await expect(cards.nth(0)).toHaveClass(/assistant-approval-card/);
      const first = cards.nth(0);
      await expect(first).toContainText("/Users/owner/Projects/demo");
      await expect(first).toContainText("Home");
      await expect(first).toContainText("Expires");
      await expect(
        first.getByRole("button", { name: "Show full command" }),
      ).toBeVisible();
      const text = first.locator(".exec-approval-command");
      await expect(text).toHaveClass(/clamped/);
      const clamped = (await text.boundingBox()).height;
      await first.getByRole("button", { name: "Show full command" }).click();
      await expect(first.getByRole("button", { name: "Show less" })).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      await expect(text).not.toHaveClass(/clamped/);
      expect((await text.boundingBox()).height).toBeGreaterThan(clamped);
      await expect(text).toContainText(command.trim());
      if (label === "phone") await fitsPhone(page);
      // AgentPier writes the entry itself: the owner reads what it allows first.
      await first.getByRole("button", { name: "Always allow" }).click();
      const confirm = first.getByRole("alertdialog");
      await expect(confirm).toContainText("/opt/homebrew/bin/gh");
      await expect(confirm).toContainText("with any arguments");
      await expect(confirm).toContainText("git hooks");
      await expect(confirm).toContainText("In folders you can write to");
      expect(state.decisions).toEqual([]);
      await confirm.getByRole("button", { name: "Always allow these programs" }).click();
      await expect
        .poll(() => state.decisions)
        .toEqual([["always", { revision: 1, decision: "allow-always" }]]);
      await expect(cards).toHaveCount(3);
      // An interpreter is only ever allowed once; the button says so.
      const once = cards.filter({ hasText: "node build.js" });
      await expect(
        once.getByRole("button", { name: "Always allow" }),
      ).toHaveAccessibleDescription(
        /allows this command only once: node is an interpreter, shell or launcher/,
      );
      await once.getByRole("button", { name: "Always allow" }).click();
      await expect.poll(() => state.decisions.length).toBe(2);
      expect(state.decisions[1]).toEqual([
        "once",
        { revision: 1, decision: "allow-always" },
      ]);
      const native = cards.filter({ hasText: "ls -la" });
      await expect(native.getByRole("button", { name: "Show full command" })).toHaveCount(
        0,
      );
      await native.getByRole("button", { name: "Allow once" }).click();
      await expect.poll(() => state.decisions.length).toBe(3);
      expect(state.decisions[2]).toEqual([
        "native",
        { revision: 1, decision: "allow-once" },
      ]);
      await cards
        .filter({ hasText: "rm x" })
        .getByRole("button", { name: "Deny" })
        .click();
      await expect.poll(() => state.decisions.length).toBe(4);
      expect(state.decisions[3]).toEqual(["deny", { revision: 1, decision: "deny" }]);
      await expect(cards).toHaveCount(0);
    });

    test("an exec request decided elsewhere leaves the list with the error", async ({
      page,
    }) => {
      const state = await setup(page, {
        agent: { shell: "approval" },
        actions: [
          execAction("stale", { payload: { ...execAction("x").payload, command: "ls" } }),
        ],
      });
      await page.goto(baseURL + "/agents/home/chats/chat");
      const cards = page.getByRole("article", {
        name: "Shell command awaiting approval",
      });
      await expect(cards).toHaveCount(1);
      await cards.getByRole("button", { name: "Allow once" }).click();
      const approvals = page.getByRole("region", { name: "Waiting for your approval" });
      await expect(approvals.getByRole("alert")).toHaveText(
        "This request was already decided.",
      );
      await expect(cards).toHaveCount(0);
      expect(state.decisions).toEqual([
        ["stale", { revision: 1, decision: "allow-once" }],
      ]);
    });

    test("a failed allowlist delete keeps the entry and shows the error", async ({
      page,
    }) => {
      const state = await setup(page, {
        agent: { shell: "approval" },
        entries: [
          { id: "broken", pattern: "/usr/bin/git", source: "agentpier", kind: "program" },
        ],
      });
      await page.goto(baseURL + settingsPath("capabilities", "allowlist"));
      await allowlist(page)
        .getByRole("button", { name: "Delete entry /usr/bin/git" })
        .click();
      await expect(allowlist(page).getByRole("alert")).toHaveText(
        "The agent service is not ready.",
      );
      await expect(allowlist(page).locator(".assistant-shell-entry")).toHaveCount(1);
      await expect(
        allowlist(page).getByRole("button", { name: "Delete entry /usr/bin/git" }),
      ).toBeEnabled();
      expect(state.deletes).toEqual(["broken"]);
    });

    test("cancelling the warning returns to the saved level", async ({ page }) => {
      const state = await setup(page);
      await page.goto(baseURL + settingsPath("capabilities"));
      await shell(page)
        .getByRole("radio", { name: /^Full access/ })
        .check();
      await save(page).click();
      const dialog = page.getByRole("dialog", { name: "Turn on shell access?" });
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(shell(page).getByRole("radio", { name: /^Off/ })).toBeChecked();
      expect(state.patches).toHaveLength(1);
    });
  });
}
