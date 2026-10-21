import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import {
  connectedChannel,
  home,
  setupAssistantSettings,
} from "../helpers/assistant-settings-browser.js";
import { chatAssistant, chatFixture, emit } from "../helpers/assistant-chat-fixture.js";

// Agents of users in the owner's agent pages: the hard lock explained, folders only,
// no user chat in his views, and his own chat with a shared agent.
const anna = { id: "u-1", username: "anna", displayName: "Anna", disabled: false };
const shared = (extra = {}) =>
  home({
    userAccess: {
      mode: "shared",
      members: [{ userId: "u-1", level: "chat" }],
      released: [],
    },
    ...extra,
  });
const languages = {
  de: {
    locked: /Für Agenten von Benutzern gesperrt: Sie können keine Programme/,
    shell: "Shell",
    visible: "Sichtbarer Browser",
    visibleLocked: /Sichtbares Browserfenster/,
    sessionsLocked: /Zugriff auf seine anderen Chats \(Session-Tools\)/,
    projects: "Projekte",
    foldersIntro:
      /Agenten von Benutzern bekommen weder Projektwissen noch Coding-Aufträge/,
    sharedIntro: /stehen für Projektwissen und Coding-Aufträge bereit/,
    access: "Benutzer dieses Agenten",
    released: "Freigegebene Fähigkeiten",
    browser: "Browser",
    restartTitle: "Agentendienst neu starten?",
    restartConfirm: "Speichern und neu starten",
    lockedCoding: /Gesperrt: Coding\./,
    read: "Lesen",
    save: "Speichern",
    openMyChat: "Meinen Chat öffnen",
    options: "Optionen",
    attach: "Datei, Bild oder Video anhängen",
    team: "Ein Team für diese Nachricht erlauben",
    ofUsers: "Agenten von Benutzern",
    chats: /Chats mit Home/,
    openNavigation: "Navigation öffnen",
    userChat:
      "Dieser Chat gehört einem Benutzer: Du kannst ihn lesen, aber nicht darin schreiben.",
    unavailable: "Dieser Chat gehört einem Benutzer, und du darfst ihn nicht mehr lesen.",
    newChat: "Neuer Chat",
    actionsFor: /Aktionen für/,
    ownRoutines: "Erinnerungen und Routinen verwaltet sein Benutzer in seiner App.",
    ownTelegram: /Seinen Telegram-Bot verbindet sein Benutzer in seiner App/,
    ownTelegramBelowExtended: /sobald du ihm „Erweitert“ gibst/,
    ownRoutinesChatOnly:
      /Bei „Nur chatten“ kann er sie noch ansehen, pausieren und löschen/,
    sendersLocked: /gesperrt: ein eigener Telegram-Bot für andere Personen/,
    senders: "Telegram für andere Personen",
    ownReadOnly: /Du kannst Notizen lesen/,
    ownPrivate: /Privat für seinen Benutzer/,
    notes: "Gespeicherte Notizen",
    clear: /leeren/,
    forUser: "Für",
    forMe: "Für mich",
    unknownUser: "Unbekannter Benutzer",
    name: "Name",
    connection: "Provider-Zugang",
    model: "Modell-ID",
    create: "Agent anlegen",
  },
  en: {
    locked: /Locked for agents of users: they cannot run programs/,
    shell: "Shell",
    visible: "Visible browser",
    visibleLocked: /Visible browser window/,
    sessionsLocked: /Access to its other chats \(session tools\)/,
    projects: "Projects",
    foldersIntro: /Agents of users get no project memory and no coding tasks/,
    sharedIntro: /can be used for project memory and coding tasks/,
    access: "Users of this agent",
    released: "Released capabilities",
    browser: "Browser",
    restartTitle: "Restart the agent service?",
    restartConfirm: "Save and restart",
    lockedCoding: /Locked: Coding\./,
    read: "Read",
    save: "Save",
    openMyChat: "Open my chat",
    options: "Options",
    attach: "Attach file, image or video",
    team: "Allow a team for this message",
    ofUsers: "Agents of users",
    chats: /Chats with Home/,
    openNavigation: "Open navigation",
    userChat: "This chat belongs to a user: you can read it, but not write in it.",
    unavailable: "This chat belongs to a user and you may no longer read it.",
    newChat: "New chat",
    actionsFor: /Actions for/,
    ownRoutines: "Its user manages its reminders and routines in their app.",
    ownTelegram: /Its user connects its Telegram bot in their app/,
    ownTelegramBelowExtended: /once you give them Extended/,
    ownRoutinesChatOnly: /At Chat only they can still see, pause and delete them/,
    sendersLocked: /Locked for agents of users: its own Telegram bot for other people/,
    senders: "Telegram for other people",
    ownReadOnly: /you can read its notes/,
    ownPrivate: /Private to its user/,
    notes: "Saved notes",
    clear: /Clear/,
    forUser: "For",
    forMe: "For me",
    unknownUser: "Unknown user",
    name: "Name",
    connection: "Model connection",
    model: "Model ID",
    create: "Create agent",
  },
};

async function users(page) {
  await page.route(/\/api\/users$/, (route) => route.fulfill({ json: [anna] }));
}

for (const [language, copy] of Object.entries(languages))
  test.describe(language, () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test("locked groups explain why", async ({ page }) => {
      await setupAssistantSettings(page, {
        language,
        assistants: [shared({ capabilities: { memory: false, browser: true } })],
      });
      await users(page);
      await page.goto(baseURL + "/agents/home/settings?tab=capabilities");
      await expect(page.getByText(copy.locked)).toBeVisible();
      // Headless only: no window switch, and the lock names it.
      await expect(page.getByText(copy.visibleLocked)).toBeVisible();
      // The session tools reach this agent's other chats: on a shared agent, theirs.
      await expect(page.getByText(copy.sessionsLocked)).toBeVisible();
      await expect(
        page.getByRole("switch", { name: copy.visible, exact: true }),
      ).toHaveCount(0);
      await expect(page.locator("#agent-shell, [data-shell-group]")).toHaveCount(0);
      await page.goto(baseURL + "/agents/home/settings?tab=work");
      await expect(page.getByText(copy.locked)).toBeVisible();
      await expect(page.getByText("GitHub", { exact: false })).toHaveCount(1);
      // A link to a locked Work page shows the lock, never its grants.
      for (const locked of ["ssh", "github", "pipelines"]) {
        await page.goto(baseURL + `/agents/home/settings?tab=work&page=${locked}`);
        await expect(page.getByText(copy.locked)).toBeVisible();
        await expect(page.getByRole("checkbox")).toHaveCount(0);
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(390);
    });

    test("owner assigns a project folder read-only", async ({ page }) => {
      const state = await setupAssistantSettings(page, {
        language,
        assistants: [shared()],
        access: { revision: 1, projectIds: [], projectFiles: {} },
        catalog: {
          projects: [{ id: "p1", name: "Household", path: "/home/household" }],
          pipelines: [],
        },
      });
      await users(page);
      await page.goto(baseURL + "/agents/home/settings?tab=work&page=projects");
      // Folders only: the page says coding and project memory stay locked.
      await expect(page.getByText(copy.foldersIntro)).toBeVisible();
      await expect(page.getByText(copy.lockedCoding)).toBeVisible();
      await expect(page.getByText(copy.sharedIntro)).toHaveCount(0);
      await page.getByRole("checkbox", { name: /Household/ }).check();
      await expect(
        page.getByRole("radio", { name: copy.read, exact: true }),
      ).toBeChecked();
      await expect(page.getByRole("radio")).toHaveCount(2);
      await page.getByRole("button", { name: copy.save, exact: true }).click();
      await expect.poll(() => state.work.length).toBe(1);
      expect(state.work[0].access.projectFiles).toEqual({ p1: "read" });
      expect(state.work[0].access.projectIds).toEqual([]);
    });

    for (const mode of ["shared", "own"])
      test(`Users of this agent releases capabilities only on a user's own agent (${mode})`, async ({
        page,
      }) => {
        await setupAssistantSettings(page, {
          language,
          assistants: [
            home({
              userAccess: {
                mode,
                members: [{ userId: "u-1", level: "extended" }],
                released: [],
              },
            }),
          ],
        });
        await users(page);
        await page.goto(baseURL + "/agents/home/settings?tab=profile");
        await expect(page.getByText(copy.access, { exact: true })).toBeVisible();
        // A shared agent's capabilities stay the owner's at every level.
        await expect(page.getByText(copy.released, { exact: true })).toHaveCount(
          mode === "own" ? 1 : 0,
        );
      });

    test("releasing a capability that restarts the agent service asks first", async ({
      page,
    }) => {
      const access = {
        mode: "own",
        members: [{ userId: "u-1", level: "extended" }],
        released: [],
      };
      await setupAssistantSettings(page, {
        language,
        assistants: [home({ userAccess: access })],
      });
      await users(page);
      const sent = [];
      await page.route(/\/api\/user-agents\/home\/access$/, (route) => {
        const body = route.request().postDataJSON();
        sent.push(body);
        if (!body.confirmRestart)
          return route.fulfill({
            status: 409,
            json: {
              code: "ASSISTANT_RESTART_REQUIRED",
              error: "restart",
              affected: { agents: [{ id: "home", name: "Home" }], teamMembers: 0 },
            },
          });
        return route.fulfill({ json: home({ userAccess: body.userAccess }) });
      });
      await page.goto(baseURL + "/agents/home/settings?tab=profile");
      await page.getByRole("checkbox", { name: copy.browser, exact: true }).click();
      const dialog = page.getByRole("dialog", { name: copy.restartTitle });
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: copy.restartConfirm }).click();
      await expect(dialog).toHaveCount(0);
      await expect.poll(() => sent.length).toBe(2);
      expect(
        sent.map((body) => [body.userAccess.released, !!body.confirmRestart]),
      ).toEqual([
        [["browser"], false],
        [["browser"], true],
      ]);
    });

    test("owner opens his own chat with a shared agent", async ({ page }) => {
      const state = await setupAssistantSettings(page, {
        language,
        assistants: [shared()],
        // Anna's chat with it never opens for him; "c1" is the one he opens.
        conversations: [
          { id: "annas", assistantId: "home", userId: "u-1", main: true },
          { id: "c1", assistantId: "home" },
        ],
      });
      await users(page);
      await page.goto(baseURL + "/agents");
      await expect(page.getByRole("heading", { name: copy.ofUsers })).toBeVisible();
      await page.getByRole("button", { name: copy.openMyChat }).click();
      await expect(page).not.toHaveURL(/chats\/annas/);
      expect(state.opened).toBe(1);
      // A user's agent never leads a team, so his composer offers none.
      await page.getByRole("button", { name: copy.options, exact: true }).click();
      await expect(page.getByRole("button", { name: copy.attach })).toBeVisible();
      await expect(page.getByRole("switch", { name: copy.team })).toHaveCount(0);
    });
    test("owner sees no user chat in the sidebar", async ({ page }) => {
      const state = await setupAssistantSettings(page, {
        language,
        assistants: [home({ id: "mine", name: "Mine" }), shared({ name: "Family" })],
        conversations: [
          { id: "annas", assistantId: "home", userId: "u-1", main: true },
          { id: "own", assistantId: "mine", main: true },
        ],
      });
      await users(page);
      await page.goto(baseURL + "/agents");
      await page.getByRole("button", { name: copy.openNavigation, exact: true }).click();
      await expect(
        page.locator(".assistant-sidebar-section", { hasText: copy.ofUsers }),
      ).toBeVisible();
      await page.locator(".assistant-sidebar-item", { hasText: "Family" }).click();
      // His own chat opens (a new one), never Anna's.
      await expect(page).not.toHaveURL(/chats\/annas/);
      expect(state.opened).toBe(1);
    });

    test("owner's chat list shows no user chats without opt-in", async ({ page }) => {
      await setupAssistantSettings(page, {
        language,
        assistants: [shared()],
        conversations: [{ id: "mine", assistantId: "home", main: true, title: "Mine" }],
      });
      await users(page);
      await page.route(/\/api\/assistants\/home\/chats/, (route) =>
        route.fulfill({
          json: [
            { id: "mine", title: "Mine", main: true, archivedAt: null, userId: null },
            { id: "annas", title: "Anna's", main: true, archivedAt: null, userId: "u-1" },
          ],
        }),
      );
      await page.goto(baseURL + "/agents/home/chats/mine");
      await page.getByRole("button", { name: copy.chats }).click();
      const list = page.locator(".agent-chat-list .list-row-main");
      await expect(list).toHaveCount(1);
      await expect(list).toContainText("Mine");
    });

    test("owner reads a user's own-agent chat without composer or chat actions", async ({
      page,
    }) => {
      await setupAssistantSettings(page, {
        language,
        assistants: [
          home({
            userAccess: {
              mode: "own",
              members: [{ userId: "u-1", level: "chat" }],
              released: [],
            },
          }),
        ],
        conversations: [{ id: "annas", assistantId: "home", userId: "u-1", main: true }],
      });
      await users(page);
      await page.route(/\/api\/assistants\/home\/chats/, (route) =>
        route.fulfill({
          json: [
            { id: "annas", title: "Anna's", main: true, archivedAt: null, userId: "u-1" },
          ],
        }),
      );
      await page.goto(baseURL + "/agents/home/chats/annas");
      await expect(page.getByText(copy.userChat)).toBeVisible();
      await expect(page.locator(".assistant-chat textarea")).toHaveCount(0);
      await expect(page.getByRole("button", { name: copy.newChat })).toHaveCount(0);
      await page.getByRole("button", { name: copy.chats }).click();
      await expect(page.locator(".agent-chat-list .list-row-main")).toHaveCount(1);
      await expect(page.getByRole("button", { name: copy.actionsFor })).toHaveCount(0);
    });

    for (const mode of ["shared", "own"])
      test(`the Telegram tab of a ${mode} user agent offers no locked or foreign bot`, async ({
        page,
      }) => {
        await setupAssistantSettings(page, {
          language,
          assistants: [
            home({
              userAccess: {
                mode,
                members: [{ userId: "u-1", level: "extended" }],
                released: [],
              },
            }),
          ],
          // On her own agent this is her bot, connected in her app.
          channel: connectedChannel({ username: "her_bot" }),
        });
        await users(page);
        await page.goto(baseURL + "/agents/home/settings?tab=telegram");
        await expect(page.getByText(copy.sendersLocked)).toBeVisible();
        await expect(page.getByText(copy.senders, { exact: true })).toHaveCount(0);
        if (mode === "own") {
          await expect(page.getByText(copy.ownTelegram)).toBeVisible();
          await expect(page.getByText(/@her_bot/)).toHaveCount(0);
          // A link to her bot's subpage falls back to the tab.
          await page.goto(
            baseURL + "/agents/home/settings?tab=telegram&page=telegram-connection",
          );
          await expect(page.getByText(copy.ownTelegram)).toBeVisible();
          await expect(page.getByText(/@her_bot/)).toHaveCount(0);
        } else await expect(page.getByText(/@her_bot/).first()).toBeVisible();
      });

    test("the Telegram tab of a user's own agent below Extended says what her bot needs", async ({
      page,
    }) => {
      await setupAssistantSettings(page, {
        language,
        assistants: [
          home({
            userAccess: {
              mode: "own",
              members: [{ userId: "u-1", level: "personalize" }],
              released: [],
            },
          }),
        ],
      });
      await users(page);
      await page.goto(baseURL + "/agents/home/settings?tab=telegram");
      await expect(page.getByText(copy.ownTelegramBelowExtended)).toBeVisible();
      await expect(page.getByText(copy.ownTelegram)).toHaveCount(0);
    });

    for (const ownerReads of [false, true])
      test(`a user's own agent's notes and routines are hers (owner reads: ${ownerReads})`, async ({
        page,
      }) => {
        const state = await setupAssistantSettings(page, {
          language,
          assistants: [
            home({
              capabilities: { memory: true, reminders: true },
              userAccess: {
                mode: "own",
                members: [{ userId: "u-1", level: "chat" }],
                released: [],
              },
              ownerReads,
            }),
          ],
          memory: {
            "MEMORY.md": { name: "MEMORY.md", content: "Likes tea", hash: "h1" },
          },
        });
        await users(page);
        await page.goto(baseURL + "/agents/home/settings?tab=routines");
        // At Chat only she cannot manage them yet: the note says what it takes.
        await expect(page.getByText(copy.ownRoutinesChatOnly)).toBeVisible();
        await page.goto(baseURL + "/agents/home/settings?tab=capabilities");
        await expect(
          page.getByText(ownerReads ? copy.ownReadOnly : copy.ownPrivate),
        ).toBeVisible();
        await expect(page.getByText(copy.notes, { exact: true })).toHaveCount(
          ownerReads ? 1 : 0,
        );
        await page.goto(baseURL + "/agents/home/settings?tab=capabilities&page=memory");
        if (!ownerReads) {
          // A link to her notes shows the tab and its notice, never her notes.
          await expect(page.getByText(copy.ownPrivate)).toBeVisible();
          await expect(page.locator("textarea")).toHaveCount(0);
          return;
        }
        const notes = page.locator("textarea");
        await expect(notes).toHaveValue("Likes tea");
        await expect(notes).toHaveAttribute("readonly", "");
        await expect(page.getByRole("button", { name: copy.clear })).toHaveCount(0);
        expect(state.memorySaves).toEqual([]);
      });

    test("'Add agent' for a disabled user shows whom the agent is for", async ({
      page,
    }) => {
      await setupAssistantSettings(page, { language, assistants: [home()] });
      await page.route(/\/api\/users$/, (route) =>
        route.fulfill({
          json: [
            anna,
            { id: "u-2", username: "ben", displayName: "Ben", disabled: true },
          ],
        }),
      );
      await page.goto(baseURL + "/agents?new=1&user=u-2");
      const pick = page.getByRole("combobox", { name: copy.forUser, exact: true });
      await expect(pick).toHaveValue("u-2");
      await expect(pick.locator("option:checked")).toHaveText("Ben");
      // Other disabled users stay out of the list.
      await page.goto(baseURL + "/agents?new=1");
      await expect(
        page.getByRole("combobox", { name: copy.forUser, exact: true }),
      ).toHaveValue("");
      await expect(
        page.getByRole("combobox", { name: copy.forUser, exact: true }).locator("option"),
      ).toHaveText([copy.forMe, "Anna"]);
    });

    test("'Add agent' for a user stays hers when the user list fails", async ({
      page,
    }) => {
      await setupAssistantSettings(page, { language, assistants: [home()] });
      const created = [];
      await page.route(/\/api\/users$/, (route) =>
        route.fulfill({ status: 500, json: { error: "Users unavailable" } }),
      );
      await page.route(/\/api\/user-agents$/, (route) => {
        created.push(route.request().postDataJSON());
        return route.fulfill({ status: 201, json: home() });
      });
      await page.goto(baseURL + "/agents?new=1&user=u-1");
      const pick = page.getByRole("combobox", { name: copy.forUser, exact: true });
      await expect(pick).toHaveValue("u-1");
      await expect(pick.locator("option:checked")).toHaveText(copy.unknownUser);
      await expect(page.getByText("Users unavailable")).toBeVisible();
      await page.getByLabel(copy.name, { exact: true }).fill("Helper");
      await page.getByLabel(copy.connection).selectOption({ label: "Router" });
      await page.getByLabel(copy.model).fill("model");
      await page.getByRole("button", { name: copy.create, exact: true }).click();
      await expect.poll(() => created.length).toBe(1);
      expect(created[0].userAccess.members).toEqual([{ userId: "u-1", level: "chat" }]);
    });

    test("owner's open chat of a user's own agent closes when her opt-in ends", async ({
      page,
    }) => {
      const state = await chatFixture(page, {
        language,
        assistants: [
          chatAssistant({
            userAccess: {
              mode: "own",
              members: [{ userId: "u-1", level: "chat" }],
              released: [],
            },
          }),
        ],
        conversations: [{ id: "annas", assistantId: "home", userId: "u-1", main: true }],
        history: {
          messages: [{ id: "q", role: "user", text: "Anna's private plan" }],
          requests: [],
          stale: false,
        },
      });
      await users(page);
      await page.goto(baseURL + "/agents/home/chats/annas");
      await expect(page.getByText("Anna's private plan")).toBeVisible();
      // Leave in the app, so its cache of the chat survives, then her opt-in ends.
      await page.evaluate(() => {
        history.pushState({}, "", "/agents");
        dispatchEvent(new PopStateEvent("popstate"));
      });
      state.conversations = [];
      await emit(page, { type: "change" });
      await page.goBack();
      await expect(page).toHaveURL(/chats\/annas/);
      await expect(page.getByText(copy.unavailable)).toBeVisible();
      await expect(page.getByText("Anna's private plan")).toHaveCount(0);
    });
  });
