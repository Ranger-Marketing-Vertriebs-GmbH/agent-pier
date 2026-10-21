import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { operationsFixture } from "./operations-fixture.js";

// The owner's Settings › Access › Users at 390px in German and English.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const languages = {
  de: {
    add: "Benutzer anlegen",
    displayName: "Anzeigename",
    username: "Benutzername",
    password: "Erstes Passwort",
    create: "Anlegen",
    signIn: "Anmelden erlaubt",
    disabled: "Deaktiviert",
    delete: "Benutzer löschen",
    deleteNow: "Jetzt löschen",
    keep: "Unter meinem Konto behalten",
    level: (name) => `Stufe für ${name}`,
    personalize: "Personalisieren",
    optIn: "Besitzer darf Chats lesen",
    since: /An seit/,
    empty: "Noch keine Benutzer. Lege den ersten an.",
    users: "Benutzer",
  },
  en: {
    add: "Add user",
    displayName: "Display name",
    username: "Username",
    password: "First password",
    create: "Add",
    signIn: "Sign-in allowed",
    disabled: "Disabled",
    delete: "Delete user",
    deleteNow: "Delete now",
    keep: "Keep under my account",
    level: (name) => `Level for ${name}`,
    personalize: "Personalize",
    optIn: "Owner may read chats",
    since: /On since/,
    empty: "No users yet. Add the first one.",
    users: "Users",
  },
};

async function setup(page, language, { users = [], assistants = [] } = {}) {
  await operationsFixture(page);
  await page.addInitScript(
    (value) => localStorage.setItem("agentpier-language", value),
    language,
  );
  const state = { users: [...users], assistants: [...assistants], calls: [] };
  const json = (route, body, status = 200) => route.fulfill({ status, json: body });
  await page.route(/\/api\/(?:users|user-agents|assistants$)/, async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;
    const body = request.postDataJSON?.() ?? null;
    state.calls.push({ method, path, body });
    if (path === "/api/assistants")
      return json(route, { assistants: state.assistants, conversations: [], models: [] });
    if (path === "/api/users" && method === "GET") return json(route, state.users);
    if (path === "/api/users" && method === "POST") {
      const user = {
        id: `u-${state.users.length + 1}`,
        username: body.username,
        displayName: body.displayName,
        disabled: false,
        ownerMayRead: { enabled: false, since: null },
      };
      state.users.push(user);
      return json(route, user, 201);
    }
    let m = /^\/api\/users\/([^/]+)(\/.*)?$/.exec(path);
    if (m) {
      const user = state.users.find((u) => u.id === m[1]);
      if (method === "DELETE") {
        state.users = state.users.filter((u) => u.id !== m[1]);
        return route.fulfill({ status: 204, body: "" });
      }
      if (m[2] === "/owner-may-read")
        user.ownerMayRead = body.enabled
          ? { enabled: true, since: "2026-10-21T08:00:00.000Z" }
          : { enabled: false, since: null };
      else if (!m[2]) Object.assign(user, body);
      return json(route, user);
    }
    m = /^\/api\/user-agents\/([^/]+)\/access$/.exec(path);
    if (m) {
      const agent = state.assistants.find((a) => a.id === m[1]);
      agent.userAccess = body.userAccess;
      agent.revision++;
      return json(route, agent);
    }
    return route.fallback();
  });
  return state;
}

for (const [language, copy] of Object.entries(languages))
  test.describe(language, () => {
    test("owner creates, disables and deletes a user", async ({ page }) => {
      const state = await setup(page, language);
      await page.goto(baseURL + "/settings?tab=access");
      await page.getByRole("link", { name: new RegExp(copy.users) }).click();
      await expect(page).toHaveURL(/\/settings\/users$/);
      await expect(page.getByText(copy.empty)).toBeVisible();
      await page.getByRole("button", { name: copy.add }).click();
      const dialog = page.getByRole("dialog", { name: copy.add });
      await dialog.getByLabel(copy.displayName).fill("Anna");
      await dialog.getByLabel(copy.username).fill("anna");
      await dialog.getByLabel(copy.password).fill("first-password-1");
      await dialog.getByRole("button", { name: copy.create, exact: true }).click();
      await expect(page).toHaveURL(/\/settings\/users\?user=u-1$/);
      await expect(page.getByRole("heading", { name: "Anna" })).toBeVisible();
      await page.getByRole("switch", { name: copy.signIn }).click();
      await expect(page.getByRole("switch", { name: copy.signIn })).not.toBeChecked();
      expect(state.users[0].disabled).toBe(true);
      await page.getByRole("button", { name: copy.delete }).click();
      await page.getByRole("button", { name: copy.deleteNow }).click();
      await expect(page).toHaveURL(/\/settings\/users$/);
      await expect(page.getByText(copy.empty)).toBeVisible();
      expect(state.calls.find((c) => c.method === "DELETE").body).toEqual({});
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(390);
    });

    test("owner sets a level", async ({ page }) => {
      const anna = {
        id: "u-1",
        username: "anna",
        displayName: "Anna",
        disabled: false,
        ownerMayRead: { enabled: false, since: null },
      };
      const lotta = {
        id: "lotta",
        name: "Lotta",
        revision: 3,
        userAccess: {
          mode: "own",
          members: [{ userId: "u-1", level: "chat" }],
          released: [],
        },
      };
      const state = await setup(page, language, { users: [anna], assistants: [lotta] });
      await page.goto(baseURL + "/settings/users?user=u-1");
      const level = page.getByRole("radiogroup", { name: copy.level("Lotta") });
      await level.getByRole("radio", { name: copy.personalize }).click();
      await expect(level.getByRole("radio", { name: copy.personalize })).toBeChecked();
      const assign = state.calls.find((c) => c.path === "/api/user-agents/lotta/access");
      expect(assign.body).toEqual({
        userAccess: {
          mode: "own",
          members: [{ userId: "u-1", level: "personalize" }],
          released: [],
        },
        revision: 3,
      });
      // Her own agent asks what happens to it when she is deleted.
      await page.getByRole("button", { name: copy.delete }).click();
      await page.getByRole("radio", { name: copy.keep }).check();
      await page.getByRole("button", { name: copy.deleteNow }).click();
      await expect(page).toHaveURL(/\/settings\/users$/);
      expect(state.calls.find((c) => c.method === "DELETE").body).toEqual({
        agents: "keep",
      });
    });

    test("owner turns on the opt-in", async ({ page }) => {
      const state = await setup(page, language, {
        users: [
          {
            id: "u-1",
            username: "anna",
            displayName: "Anna",
            disabled: false,
            ownerMayRead: { enabled: false, since: null },
          },
        ],
      });
      await page.goto(baseURL + "/settings/users?user=u-1");
      await page.getByRole("switch", { name: copy.optIn }).click();
      await expect(page.getByRole("switch", { name: copy.optIn })).toBeChecked();
      await expect(page.getByText(copy.since)).toBeVisible();
      expect(state.users[0].ownerMayRead.enabled).toBe(true);
    });
  });
