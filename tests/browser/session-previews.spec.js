import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";

const preview = {
  id: "pv1",
  slot: 47100,
  target: 5173,
  label: "Shop start page",
  path: "/",
  owner: { kind: "session", sessionId: "with" },
  createdAt: "2026-11-01T10:00:00.000Z",
  lastUsedAt: "2026-11-01T10:00:00.000Z",
};
const copy = {
  en: { title: "Previews", open: "Open preview", stop: "Stop", port: "Port 5173" },
  de: {
    title: "Vorschauen",
    open: "Vorschau öffnen",
    stop: "Beenden",
    port: "Port 5173",
  },
};

async function fixture(context, language) {
  const state = { previews: [preview], deletes: [] };
  await context.addInitScript(
    (value) => localStorage.setItem("agentpier-language", value),
    language,
  );
  await context.route("**/api/**", (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (pathname === "/api/previews/pv1" && request.method() === "DELETE") {
      state.deletes.push(pathname);
      state.previews = [];
      return route.fulfill({ status: 204, body: "" });
    }
    let json = {};
    if (pathname === "/api/state")
      json = {
        tools: [{ id: "claude", name: "Claude Code", installed: true }],
        accounts: [],
        home: "/fixture",
        sessions: ["with", "without"].map((id) => ({
          id,
          name: `Session ${id}`,
          tool: "claude",
          cwd: "/fixture/shop",
          status: "stopped",
        })),
      };
    else if (pathname === "/api/previews")
      json = { settings: {}, previews: state.previews, slots: [], serve: null };
    else if (pathname === "/api/artifacts") json = { items: [], total: 0, page: 1 };
    else if (pathname.endsWith("/chat"))
      json = { availability: "ready", tasks: [], messages: [] };
    return route.fulfill({ json });
  });
  return state;
}

for (const language of ["en", "de"])
  test(`the session view lists its previews and stops one (${language})`, async ({
    page,
    context,
  }) => {
    const text = copy[language];
    const state = await fixture(context, language);
    await page.goto(`${baseURL}/sessions/with/chat`);
    const section = page.locator(".session-previews");
    await expect(section.locator("summary")).toHaveText(text.title);
    await section.locator("summary").click();
    await expect(section).toContainText("Shop start page");
    await expect(section).toContainText(text.port);
    const link = section.getByRole("link", { name: text.open });
    await expect(link).toHaveAttribute("href", "http://127.0.0.1:47100/");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /noopener/);
    if (language === "en" && process.env.PREVIEWS_SCREENSHOT)
      await page.screenshot({ path: process.env.PREVIEWS_SCREENSHOT });
    await section.getByRole("button", { name: text.stop }).click();
    await expect.poll(() => state.deletes).toEqual(["/api/previews/pv1"]);
    await expect(page.locator(".session-previews")).toHaveCount(0);
  });

test("a session without previews shows no Previews section", async ({
  page,
  context,
}) => {
  await fixture(context, "en");
  await page.goto(`${baseURL}/sessions/without/chat`);
  await expect(page.getByRole("heading", { name: "Session without" })).toBeVisible();
  await expect(page.locator(".session-artifacts summary")).toBeVisible();
  await expect(page.locator(".session-previews")).toHaveCount(0);
});
