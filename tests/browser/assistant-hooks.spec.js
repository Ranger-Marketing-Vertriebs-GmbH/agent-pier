import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { saveBar, settingsPath } from "../helpers/agent-settings-page.js";
import { connectedChannel } from "../helpers/assistant-settings-browser.js";
import { fixture } from "./providers-fixture.js";

const hookId = "0f8b6a52-3c1d-4e2f-9a7b-5d6c8e9f0a1b";
// Obviously fake secrets: the fulfilled API never holds a real one.
const firstSecret = "aph_EXAMPLE_first_secret_not_real_000000000000";
const nextSecret = "aph_EXAMPLE_next_secret_not_real_1111111111111";
const ceiling = {
  telegram: true,
  research: false,
  webSearch: false,
  webFetch: false,
  coding: false,
  shell: "approval",
  sshHosts: ["ssh-1"],
  folders: { "project-1": "write" },
  memory: true,
  mcp: false,
};
const addresses = (id) => ({
  local: `http://127.0.0.1:4380/hooks/${id}`,
  tailscale: `https://pier.example.ts.net/hooks/${id}`,
  network: [],
});
const hookView = (input) => ({
  id: hookId,
  name: input.name,
  sender: input.sender,
  instruction: "",
  rights: {
    notify: true,
    telegram: false,
    research: false,
    coding: false,
    shell: "off",
    sshHosts: [],
    folders: {},
    memory: false,
    mcp: false,
    ...input.rights,
  },
  // What the agent holds caps every saved right live (agent-hook-rights.js).
  effective: { notify: true, shell: input.rights?.shell ?? "off" },
  ceiling: input.ceiling ?? ceiling,
  shellChoices: ["off", "approval"],
  hourlyLimit: 20,
  enabled: true,
  active: input.active ?? true,
  secretSet: input.secretSet ?? true,
  secretSetAt: null,
  revision: 1,
  createdAt: "2026-10-25T08:00:00.000Z",
  createdBy: "owner",
  addresses: addresses(hookId),
  lastEvent: null,
});

async function setup(
  page,
  { language = "en", hooks = [], reminders = true, userAccess } = {},
) {
  await fixture(page);
  await page.addInitScript(
    (value) => localStorage.setItem("agentpier-language", value),
    language,
  );
  const state = { hooks, patches: [], secrets: [], tests: 0, paused: !reminders };
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const path = new URL(route.request().url()).pathname,
      method = route.request().method();
    const hookPath = `/api/assistants/home/hooks/${hookId}`;
    let body = {};
    if (path === "/api/assistants")
      body = {
        assistants: [
          {
            id: "home",
            name: "Home",
            instructions: "Help",
            model: { connectionId: "router", modelId: "model" },
            revision: 1,
            capabilities: { reminders, memory: true },
            ...(userAccess && { userAccess }),
          },
        ],
        conversations: [],
        models: [{ id: "router", name: "Router", available: true }],
      };
    else if (path === "/api/assistant-runtime")
      body = { availability: "ready", sync: "current" };
    else if (path === "/api/assistant-events")
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'data: {"type":"connected"}\n\n',
      });
    else if (path === "/api/assistant-channels")
      body = { channels: [connectedChannel()] };
    else if (path === "/api/assistant-workspace-catalog")
      body = {
        projects: [{ id: "project-1", name: "Website", path: "/srv/site" }],
        pipelines: [],
        sshHosts: [{ id: "ssh-1", name: "web-1" }],
      };
    else if (path.endsWith("/routines")) body = { routines: [] };
    else if (path.endsWith("/reminders")) body = { reminders: [] };
    else if (path === "/api/assistants/home/hooks" && method === "POST") {
      const hook = hookView(route.request().postDataJSON());
      state.hooks = [hook];
      return route.fulfill({ status: 201, json: { hook, secret: firstSecret } });
    } else if (path === "/api/assistants/home/hooks")
      body = { hooks: state.hooks, ceiling, shellChoices: ["off", "approval"] };
    else if (path === hookPath && method === "PATCH") {
      const patch = route.request().postDataJSON();
      state.patches.push(patch);
      if (state.paused)
        return route.fulfill({
          status: 403,
          json: {
            error: "Hooks gibt es nur …",
            messageKey: "assistants.hookUnavailable",
          },
        });
      const [old] = state.hooks;
      const { revision: _revision, ...fields } = patch;
      state.hooks = [{ ...old, ...fields, revision: old.revision + 1 }];
      body = state.hooks[0];
    } else if (path === `${hookPath}/secret`) {
      state.secrets.push(route.request().postDataJSON());
      const [old] = state.hooks;
      state.hooks = [{ ...old, secretSet: true, revision: old.revision + 1 }];
      body = { hook: state.hooks[0], secret: nextSecret };
    } else if (path === `${hookPath}/test`) {
      state.tests += 1;
      return route.fulfill({
        status: 202,
        json: { eventId: "test-1", status: "accepted" },
      });
    } else if (path === hookPath && method === "DELETE") {
      state.hooks = [];
      body = { removed: true };
    }
    await route.fulfill({ json: body });
  });
  return state;
}

const hooksGroup = (page, name = "Hooks") => page.getByRole("region", { name });
const detailPath = `${settingsPath("routines", "hook")}&hook=${hookId}`;

test("creating a hook reveals its secret and curl sample once", async ({ page }) => {
  await setup(page);
  await page.goto(baseURL + settingsPath("routines"));
  const group = hooksGroup(page);
  await expect(group.getByText("No hooks yet.")).toBeVisible();
  await group.getByRole("button", { name: "+ Add" }).click();
  const form = page.getByRole("dialog", { name: "Add hook" });
  await form.getByLabel("Hook name").fill("Uptime");
  await form.getByLabel("Sender").fill("Uptime Kuma");
  await form.getByRole("button", { name: "Create hook" }).click();
  const reveal = page.getByRole("dialog", { name: "Hook secret" });
  await expect(reveal.getByText("AgentPier shows it only this once")).toBeVisible();
  await expect(reveal.locator("pre").first()).toHaveText(firstSecret);
  // One control copies the secret, one the sample.
  await expect(reveal.getByRole("button", { name: "Copy secret" })).toHaveCount(1);
  await expect(reveal.locator("pre").nth(1)).toHaveText(
    `curl -X POST -H "Authorization: Bearer ${firstSecret}" -H "Content-Type: application/json" -d '{"id":"1","message":"test"}' https://pier.example.ts.net/hooks/${hookId}`,
  );
  // The long sample wraps on a phone instead of widening the sheet.
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await reveal.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await reveal.getByRole("button", { name: "Done" }).click();
  await expect(reveal).toBeHidden();
  await group.getByRole("link", { name: /Uptime Uptime Kuma · Active/ }).click();
  await expect(page).toHaveURL(new RegExp(`page=hook&hook=${hookId}`));
  await expect(page.getByRole("heading", { name: "Uptime" })).toBeVisible();
  await expect(page.getByText(`http://127.0.0.1:4380/hooks/${hookId}`)).toBeVisible();
  await expect(page.getByText(firstSecret)).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Uptime" })).toBeVisible();
  await expect(page.getByText(firstSecret)).toHaveCount(0);
  await expect(page.getByText("Network mode is off")).toBeVisible();
});

test("a right the agent lost shows its reason and is kept on save", async ({ page }) => {
  // Research was saved before the agent lost web access (R30).
  const state = await setup(page, {
    hooks: [hookView({ name: "Uptime", sender: "Kuma", rights: { research: true } })],
  });
  await page.goto(baseURL + detailPath);
  const research = page.getByRole("switch", { name: "Research" });
  // Stored on, so it may still be switched off; a right never held cannot go on.
  await expect(research).toBeChecked();
  await expect(research).toBeEnabled();
  await expect(
    page.getByText("The agent has neither web search nor web pages."),
  ).toBeVisible();
  await expect(page.getByRole("switch", { name: "Coding CLI" })).toBeDisabled();
  await expect(page.getByRole("switch", { name: "Write memory" })).toBeEnabled();
  await page.getByRole("switch", { name: "Write memory" }).check();
  await page.getByRole("combobox", { name: "Website" }).selectOption("read");
  await page.getByLabel("Hook name").fill("Uptime checks");
  await saveBar(page).getByRole("button", { name: "Save" }).click();
  await expect.poll(() => state.patches.length).toBe(1);
  expect(state.patches[0]).toMatchObject({
    revision: 1,
    name: "Uptime checks",
    rights: { research: true, memory: true, folders: { "project-1": "read" } },
  });
  await expect(page.getByRole("heading", { name: "Uptime checks" })).toBeVisible();
});

test("Secrets start off and switch on only while the agent receives secrets", async ({
  page,
}) => {
  // A hook stored before the switch existed has no secrets field.
  await setup(page, { hooks: [hookView({ name: "Uptime", sender: "Kuma" })] });
  await page.goto(baseURL + detailPath);
  const secrets = page.getByRole("switch", { name: "Secrets" });
  await expect(secrets).not.toBeChecked();
  await expect(secrets).toBeDisabled();
  await expect(page.getByText("The agent receives no secrets.")).toBeVisible();
});

test("the owner lets a hook's runs read the agent's secrets", async ({ page }) => {
  const state = await setup(page, {
    hooks: [
      hookView({
        name: "Uptime",
        sender: "Kuma",
        ceiling: { ...ceiling, secrets: true },
      }),
    ],
  });
  await page.goto(baseURL + detailPath);
  const secrets = page.getByRole("switch", { name: "Secrets" });
  await expect(secrets).not.toBeChecked();
  await expect(page.getByText("Reads the agent's secrets file.")).toBeVisible();
  await secrets.check();
  await saveBar(page).getByRole("button", { name: "Save" }).click();
  await expect.poll(() => state.patches.length).toBe(1);
  expect(state.patches[0].rights).toMatchObject({ secrets: true, research: false });
  await expect(secrets).toBeChecked();
});

test("a stale right can be switched off and saved, then stays off", async ({ page }) => {
  const state = await setup(page, {
    hooks: [
      hookView({
        name: "Uptime",
        sender: "Kuma",
        rights: { research: true, sshHosts: ["ssh-gone"] },
      }),
    ],
  });
  await page.goto(baseURL + detailPath);
  const research = page.getByRole("switch", { name: "Research" });
  await research.uncheck();
  await expect(research).toBeDisabled();
  await expect(
    page.getByText("The agent has neither web search nor web pages."),
  ).toBeVisible();
  const gone = page.getByRole("checkbox", { name: "ssh-gone" });
  await expect(gone).toBeEnabled();
  await gone.uncheck();
  await expect(gone).toBeDisabled();
  await saveBar(page).getByRole("button", { name: "Save" }).click();
  await expect.poll(() => state.patches.length).toBe(1);
  expect(state.patches[0].rights).toMatchObject({ research: false, sshHosts: [] });
  await expect(research).toBeDisabled();
  await expect(research).not.toBeChecked();
});

test("regenerating a secret asks first and a test event shows its status", async ({
  page,
}) => {
  const state = await setup(page, {
    hooks: [hookView({ name: "Uptime", sender: "Kuma" })],
  });
  await page.goto(baseURL + detailPath);
  await page.getByRole("button", { name: "Regenerate secret" }).click();
  const confirm = page.getByRole("dialog", {
    name: "Regenerate the secret of “Uptime”?",
  });
  await expect(confirm.getByText("The old secret stops working at once.")).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  expect(state.secrets).toHaveLength(0);
  await page.getByRole("button", { name: "Regenerate secret" }).click();
  await confirm.getByRole("button", { name: "Regenerate secret" }).click();
  const reveal = page.getByRole("dialog", { name: "Hook secret" });
  await expect(reveal.locator("pre").first()).toHaveText(nextSecret);
  expect(state.secrets).toEqual([{ revision: 1 }]);
  await reveal.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Send test event" }).click();
  await expect(
    page.getByText("Test event accepted. The agent is working on it."),
  ).toBeVisible();
  expect(state.tests).toBe(1);
  // A save after the page's own new secret follows its revision.
  await page.getByLabel("Sender").fill("Uptime Kuma");
  await saveBar(page).getByRole("button", { name: "Save" }).click();
  await expect
    .poll(() => state.patches[0])
    .toEqual({ revision: 2, sender: "Uptime Kuma" });
});

test("a proposal-created hook offers Create secret; deleting confirms", async ({
  page,
}) => {
  const state = await setup(page, {
    hooks: [hookView({ name: "Backup", sender: "Restic", secretSet: false })],
  });
  await page.goto(baseURL + settingsPath("routines"));
  await expect(hooksGroup(page).getByText("Restic · No secret yet")).toBeVisible();
  await page.goto(baseURL + detailPath);
  await expect(page.getByText("This hook has no secret yet")).toBeVisible();
  await page.getByRole("button", { name: "Create secret" }).click();
  await expect(
    page.getByRole("dialog", { name: "Hook secret" }).locator("pre").first(),
  ).toHaveText(nextSecret);
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Delete hook" }).click();
  const confirm = page.getByRole("dialog", { name: "Delete hook “Backup”?" });
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(hooksGroup(page).getByText("No hooks yet.")).toBeVisible();
  expect(state.hooks).toHaveLength(0);
});

test("inactive hooks stay listed and a refused save names the reason", async ({
  page,
}) => {
  await setup(page, {
    reminders: false,
    hooks: [hookView({ name: "Uptime", sender: "Kuma", active: false })],
  });
  await page.goto(baseURL + settingsPath("routines"));
  const group = hooksGroup(page);
  await expect(group.getByText("Hooks are inactive while")).toBeVisible();
  await expect(group.getByRole("button", { name: "+ Add" })).toBeDisabled();
  await group.getByRole("link", { name: /Uptime Kuma · Inactive/ }).click();
  await page.getByLabel("Hook name").fill("Uptime 2");
  await saveBar(page).getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByText("Hooks are only available for your own agents"),
  ).toBeVisible();
});

test("the hook flow renders German labels", async ({ page }) => {
  await setup(page, { language: "de" });
  await page.goto(baseURL + settingsPath("routines"));
  const group = hooksGroup(page);
  await expect(group.getByText("Noch keine Hooks.")).toBeVisible();
  await group.getByRole("button", { name: "+ Hinzufügen" }).click();
  const form = page.getByRole("dialog", { name: "Hook hinzufügen" });
  await form.getByLabel("Name des Hooks").fill("Uptime");
  await form.getByLabel("Absender").fill("Uptime Kuma");
  await form.getByRole("button", { name: "Hook erstellen" }).click();
  const reveal = page.getByRole("dialog", { name: "Hook-Geheimnis" });
  await expect(reveal.getByText("nur dieses eine Mal")).toBeVisible();
  await reveal.getByRole("button", { name: "Fertig" }).click();
  await group.getByRole("link", { name: /Uptime Kuma · Aktiv/ }).click();
  await expect(page.getByRole("switch", { name: "Benachrichtigen" })).toBeChecked();
  await expect(page.getByRole("button", { name: "Testereignis senden" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Geheimnis neu erzeugen" }),
  ).toBeVisible();
});

test("an agent of a user says that it has no hooks", async ({ page }) => {
  await setup(page, {
    userAccess: { mode: "own", members: [{ id: "user-1", level: "extended" }] },
  });
  await page.goto(baseURL + settingsPath("routines"));
  await expect(
    page.getByText("Hooks are not available for shared agents or agents of users."),
  ).toBeVisible();
  await expect(hooksGroup(page)).toHaveCount(0);
});
