import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";
import { fakeGateway, userAgent } from "../helpers/user-chats.js";
import { userRequestLog } from "../helpers/user-request-log.js";

// Owner and users end to end, against a real server of the spec's own (a scripted
// Gateway stands in for the agent service): private chats, the opt-in, several chats
// and deletion, at 390px in German and English.
test.describe.configure({ timeout: 120000 });

const password = "disposable-user-password";
const languages = {
  de: {
    signIn: "Anmelden",
    username: "Benutzername",
    password: "Passwort",
    add: "Benutzer anlegen",
    displayName: "Anzeigename",
    firstPassword: "Erstes Passwort",
    create: "Anlegen",
    greeting: "Hallo Anna",
    message: "Nachricht",
    send: "Senden",
    shared: "Geteilter Agent:",
    private: "Privat: Nur du siehst diesen Chat.",
    reads: /Der Besitzer kann deine Chats seit .+ lesen\./,
    ofUsers: "Agenten von Benutzern",
    openMyChat: "Meinen Chat öffnen",
    ownPrivate: /Privat für seinen Benutzer/,
    optIn: "Besitzer darf Chats lesen",
    userChat:
      "Dieser Chat gehört einem Benutzer: Du kannst ihn lesen, aber nicht darin schreiben.",
    chats: (name) => new RegExp(`Chats mit ${name}`),
    newChat: "Neuer Chat",
    actions: (title) => `Aktionen für ${title}`,
    rename: "Umbenennen",
    title: "Titel",
    save: "Speichern",
    archive: "Archivieren",
    archivedList: "Archivierte Chats",
    deleteUser: "Benutzer löschen",
    archiveAgents: "Archivieren",
    deleteNow: "Jetzt löschen",
  },
  en: {
    signIn: "Sign in",
    username: "Username",
    password: "Password",
    add: "Add user",
    displayName: "Display name",
    firstPassword: "First password",
    create: "Add",
    greeting: "Hello Anna",
    message: "Message",
    send: "Send",
    shared: "Shared agent:",
    private: "Private: only you see this chat.",
    reads: /The owner can read your chats since .+\./,
    ofUsers: "Agents of users",
    openMyChat: "Open my chat",
    ownPrivate: /Private to its user/,
    optIn: "Owner may read chats",
    userChat: "This chat belongs to a user: you can read it, but not write in it.",
    chats: (name) => new RegExp(`Chats with ${name}`),
    newChat: "New chat",
    actions: (title) => `Actions for ${title}`,
    rename: "Rename",
    title: "Title",
    save: "Save",
    archive: "Archive",
    archivedList: "Archived chats",
    deleteUser: "Delete user",
    archiveAgents: "Archive",
    deleteNow: "Delete now",
  },
};

/** The spec's own application with a scripted Gateway; `close` disposes it. */
async function server() {
  const cleanups = [];
  const t = { after: (fn) => cleanups.push(fn) };
  const f = await applicationFixture(t, enabledAssistants);
  const gateway = fakeGateway(f);
  return {
    f,
    // Every turn sent so far ends with a reply in its transcript, so the next message
    // is sent, not queued.
    finishTurns: async () => {
      for (const [index, sent] of gateway.sent.entries()) {
        if (gateway.runs[sent.idempotencyKey]) continue;
        const runId = sent.idempotencyKey;
        (gateway.history[sent.key] ||= []).push(
          {
            role: "user",
            content: sent.message,
            timestamp: Date.now(),
            idempotencyKey: `${runId}:user`,
            __openclaw: { id: `u${index}`, runId },
          },
          {
            role: "assistant",
            content: `Noted (${index + 1}).`,
            timestamp: Date.now() + 1,
            __openclaw: { id: `a${index}`, runId },
          },
        );
        gateway.runs[runId] = { status: "ok" };
      }
      await f.application.assistants.reconcile();
    },
    close: async () => {
      for (const fn of cleanups.reverse()) await fn();
    },
  };
}
async function phone(browser, f, language, cookie) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    serviceWorkers: "block",
  });
  await context.addInitScript(
    (value) => localStorage.setItem("agentpier-language", value),
    language,
  );
  if (cookie) {
    const [name, value] = cookie.split("=");
    // WebKit drops a cookie given only a URL for 127.0.0.1: name its host and path.
    await context.addCookies([
      {
        name,
        value,
        domain: new URL(f.url).hostname,
        path: "/",
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
  }
  return { context, page: await context.newPage() };
}
async function signIn(page, f, copy, username) {
  await page.goto(f.url + "/");
  await page.getByLabel(copy.username, { exact: true }).fill(username);
  await page.getByLabel(copy.password, { exact: true }).fill(password);
  await page.getByRole("button", { name: copy.signIn, exact: true }).click();
}
let finishTurns;
async function say(page, copy, text) {
  await page.getByLabel(copy.message, { exact: true }).fill(text);
  await page.getByRole("button", { name: copy.send, exact: true }).click();
  await expect(page.getByRole("log").getByText(text)).toBeVisible();
  await finishTurns();
}
const fitsPhone = async (page) =>
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
const chatRows = (page) => page.locator(".agent-chat-list .list-row-main");

for (const [language, copy] of Object.entries(languages))
  test(`owner and users keep their chats apart (${language})`, async ({ browser }) => {
    const app = await server();
    const { f, close } = app;
    finishTurns = app.finishTurns;
    const contexts = [];
    try {
      // 1. The owner adds Anna in Settings › Users; Ben, the agents through his API.
      const owner = await phone(browser, f, language, f.cookie);
      contexts.push(owner.context);
      const po = owner.page;
      await po.goto(f.url + "/settings/users");
      await po.getByRole("button", { name: copy.add }).click();
      const dialog = po.getByRole("dialog", { name: copy.add });
      await dialog.getByLabel(copy.displayName).fill("Anna");
      await dialog.getByLabel(copy.username).fill("anna");
      await dialog.getByLabel(copy.firstPassword).fill(password);
      await dialog.getByRole("button", { name: copy.create, exact: true }).click();
      await expect(po.getByRole("heading", { name: "Anna" })).toBeVisible();
      await fitsPhone(po);
      const ben = await (
        await f.request("/api/users", {
          method: "POST",
          body: { username: "ben", displayName: "Ben", password },
        })
      ).json();
      const anna = (await (await f.request("/api/users")).json()).find(
        (user) => user.username === "anna",
      );
      const own = await userAgent(
        f,
        { mode: "own", members: [{ userId: anna.id, level: "personalize" }] },
        { name: "Lotta", capabilities: { memory: true, reminders: false } },
      );
      // A note of Lotta's that only Anna may read while the opt-in is off.
      const diary = "Anna's diary: dentist on Friday";
      const note = path.join(
        f.application.assistants.config.workspaces,
        own.id,
        "memory",
      );
      fs.mkdirSync(note, { recursive: true });
      fs.writeFileSync(path.join(note, "diary.md"), diary);
      const diaryName = encodeURIComponent("memory/diary.md");
      const family = await userAgent(
        f,
        {
          mode: "shared",
          members: [
            { userId: anna.id, level: "chat" },
            { userId: ben.id, level: "chat" },
          ],
        },
        { name: "Family" },
      );
      await userAgent(
        f,
        { mode: "own", members: [{ userId: ben.id, level: "chat" }] },
        { name: "Bens helper" },
      );

      // 2. Anna signs in on her phone and chats with both agents.
      const annaPhone = await phone(browser, f, language);
      contexts.push(annaPhone.context);
      const pa = annaPhone.page;
      const annaLog = userRequestLog(pa);
      await signIn(pa, f, copy, "anna");
      await expect(pa.getByRole("heading", { name: copy.greeting })).toBeVisible();
      await pa.getByRole("button", { name: /Family/ }).click();
      await expect(pa.getByText(copy.shared)).toBeVisible();
      await say(pa, copy, "Anna's surprise plan");
      await fitsPhone(pa);
      const annaRequest = (endpoint) =>
        pa.request.get(f.url + endpoint, { headers: { origin: f.url } });
      const annaAgents = await (await annaRequest("/api/me/agents")).json();
      const annaFamilyChat = annaAgents.find((a) => a.id === family.id).conversationId;
      const annaNote = await annaRequest(`/api/me/agents/${own.id}/memory/${diaryName}`);
      expect((await annaNote.json()).content).toBe(diary);
      await pa.goto(f.url + "/");
      await pa.getByRole("button", { name: /Lotta/ }).click();
      await expect(pa.getByText(copy.private)).toBeVisible();
      await say(pa, copy, "Lotta, keep my diary");

      // 3. The owner sees no chat of Anna's, nor her own agent's memory.
      await po.goto(f.url + "/agents");
      await expect(po.getByRole("heading", { name: copy.ofUsers })).toBeVisible();
      await po.getByRole("button", { name: copy.openMyChat }).click();
      await expect(po.getByLabel(copy.message, { exact: true })).toBeVisible();
      await expect(po.getByText("Anna's surprise plan")).toHaveCount(0);
      await po.goto(f.url + `/agents/${own.id}/settings?tab=capabilities`);
      await expect(po.getByText(copy.ownPrivate)).toBeVisible();
      await expect(po.getByText("Lotta, keep my diary")).toHaveCount(0);
      await expect(po.getByText(diary)).toHaveCount(0);
      const ownerGet = (endpoint) =>
        po.request.get(f.url + endpoint, { headers: { origin: f.url } });
      for (const endpoint of [
        `/api/assistants/${own.id}/memory?name=${diaryName}`,
        `/api/assistants/${own.id}/memory/files`,
        `/api/assistants/${own.id}/memory/search?q=dentist`,
      ])
        expect((await ownerGet(endpoint)).status(), endpoint).toBe(404);
      expect(
        (
          await ownerGet(`/api/assistant-conversations/${annaFamilyChat}/messages`)
        ).status(),
      ).toBe(404);

      // 4. Ben sees only his own chat with the shared agent.
      const benPhone = await phone(browser, f, language);
      contexts.push(benPhone.context);
      const pb = benPhone.page;
      const benLog = userRequestLog(pb);
      await signIn(pb, f, copy, "ben");
      await pb.getByRole("button", { name: /Family/ }).click();
      await expect(pb.getByText(copy.shared)).toBeVisible();
      await expect(pb.getByText("Anna's surprise plan")).toHaveCount(0);
      const benGet = (endpoint) =>
        pb.request.get(f.url + endpoint, { headers: { origin: f.url } });
      expect(
        (await benGet(`/api/me/conversations/${annaFamilyChat}/messages`)).status(),
      ).toBe(404);

      // 5. Anna starts a second chat, renames and archives it: hers alone.
      await pa.goto(f.url + `/agents/${family.id}/chats/${annaFamilyChat}`);
      await pa.getByRole("button", { name: copy.chats("Family") }).click();
      await pa.getByRole("button", { name: copy.newChat, exact: true }).click();
      await expect(pa).not.toHaveURL(new RegExp(`${annaFamilyChat}$`));
      const party = new URL(pa.url()).pathname.split("/").pop();
      await say(pa, copy, "Party for Ben");
      await pa.getByRole("button", { name: copy.chats("Family") }).click();
      await pa.getByRole("button", { name: copy.actions("Party for Ben") }).click();
      await pa.getByRole("button", { name: copy.rename, exact: true }).click();
      await pa.getByLabel(copy.title, { exact: true }).fill("Party");
      await pa.getByRole("button", { name: copy.save, exact: true }).click();
      await expect(chatRows(pa).filter({ hasText: "Party" })).toBeVisible();
      await pa.getByRole("button", { name: copy.actions("Party") }).click();
      await pa.getByRole("button", { name: copy.archive, exact: true }).click();
      await pb.reload();
      await pb.getByRole("button", { name: copy.chats("Family") }).click();
      await expect(chatRows(pb)).toHaveCount(1);
      await expect(chatRows(pb).filter({ hasText: "Party" })).toHaveCount(0);
      await pb.getByRole("button", { name: copy.archivedList }).click();
      await expect(pb.getByText("Party", { exact: true })).toHaveCount(0);
      await pb.keyboard.press("Escape");
      expect((await benGet(`/api/me/conversations/${party}/messages`)).status()).toBe(
        404,
      );
      expect(
        (await ownerGet(`/api/assistant-conversations/${party}/messages`)).status(),
      ).toBe(404);
      await po.goto(f.url + "/agents");
      await po.getByRole("button", { name: copy.openMyChat }).click();
      await po.getByRole("button", { name: copy.chats("Family") }).click();
      await expect(chatRows(po)).toHaveCount(1);
      await expect(chatRows(po).filter({ hasText: "Party" })).toHaveCount(0);

      // 6. The owner turns on "Owner may read chats": from now on, never earlier.
      await po.goto(f.url + `/settings/users?user=${anna.id}`);
      await po.getByRole("switch", { name: copy.optIn }).click();
      await expect(po.getByRole("switch", { name: copy.optIn })).toBeChecked();
      await pa.goto(f.url + `/agents/${family.id}/chats/${annaFamilyChat}`);
      await expect(pa.getByText(copy.reads)).toBeVisible();
      await say(pa, copy, "Dinner at eight");
      await po.goto(f.url + `/agents/${family.id}/chats/${annaFamilyChat}`);
      await expect(po.getByText(copy.userChat)).toBeVisible();
      await expect(po.getByRole("log").getByText("Dinner at eight")).toBeVisible();
      await expect(po.getByText("Anna's surprise plan")).toHaveCount(0);
      // Her own agent's memory is readable once the opt-in is on.
      const opened = await ownerGet(`/api/assistants/${own.id}/memory?name=${diaryName}`);
      expect((await opened.json()).content).toBe(diary);
      await fitsPhone(po);

      // 7. The owner deletes Ben and archives his agent: Ben is back at the sign-in.
      await pb.goto(f.url + `/agents/${family.id}`);
      await po.goto(f.url + `/settings/users?user=${ben.id}`);
      await po.getByRole("button", { name: copy.deleteUser }).click();
      await po.getByRole("radio", { name: copy.archiveAgents }).check();
      await po.getByRole("button", { name: copy.deleteNow }).click();
      await expect(po).toHaveURL(/\/settings\/users$/);
      await expect(
        pb.getByRole("heading", { name: copy.signIn, exact: true }),
      ).toBeVisible();

      // Her app made HTTP requests only to /auth and /api/me and opened only the chat,
      // browser-view and dictation sockets docs/users.md names; his neither.
      expect(annaLog.http.length).toBeGreaterThan(0);
      expect(annaLog.violations()).toEqual([]);
      expect(benLog.violations()).toEqual([]);
    } finally {
      for (const context of contexts) await context.close();
      await close();
    }
  });
