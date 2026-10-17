import { test, expect } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";
import { artifactsFixture, now, remoteProbe } from "./artifacts-fixture.js";

test.use({ timezoneId: "Europe/Berlin" });

const labels = {
  en: {
    title: "Artifacts",
    all: "All",
    pinned: "Pinned",
    today: "Today",
    yesterday: "Yesterday",
    earlier: "Earlier",
    source: "Settings redesign QA · agent-pier",
    deleted: "Session deleted · agent-pier",
    ago: "18 minutes ago",
    meta: "Web page · 18 minutes ago",
    image: "Image · PNG",
    open: (title) => `Open ${title}`,
    copyLink: "Copy link",
    copied: "Link copied.",
    linkHint: "The link only works when signed in to AgentPier.",
    session: "Session · Claude Code",
    ended: "Ended",
    pinSwitch: "Pinned",
    details: "Details",
    sizeFiles: "2.3 MB · 3 files",
    deleteRow: "Delete artifact",
    deleteTitle: "Delete artifact?",
    remove: "Delete",
    unpinTitle: "Unpin artifact?",
    unpinAndDelete: "Unpin and delete",
    search: "Search artifacts",
    project: "Project",
    noMatch: "No artifact matches “zzz”.",
    clear: "Clear filters",
    emptyNone: "No artifacts yet.",
    how: "How publishing works",
    howText: "artifact_publish",
    emptyPinned: "Nothing pinned.",
    gone: "This artifact is no longer available.",
    back: "Back",
    preview: (title) => `Preview of ${title}`,
  },
  de: {
    title: "Artifacts",
    all: "Alle",
    pinned: "Angepinnt",
    today: "Heute",
    yesterday: "Gestern",
    earlier: "Früher",
    source: "Settings redesign QA · agent-pier",
    deleted: "Sitzung gelöscht · agent-pier",
    ago: "vor 18 Minuten",
    meta: "Webseite · vor 18 Minuten",
    image: "Bild · PNG",
    open: (title) => `${title} öffnen`,
    copyLink: "Link kopieren",
    copied: "Link kopiert.",
    linkHint: "Der Link funktioniert nur, wenn du bei AgentPier angemeldet bist.",
    session: "Sitzung · Claude Code",
    ended: "Beendet",
    pinSwitch: "Angepinnt",
    details: "Details",
    sizeFiles: "2,3 MB · 3 Dateien",
    deleteRow: "Artifact löschen",
    deleteTitle: "Artifact löschen?",
    remove: "Löschen",
    unpinTitle: "Pin lösen?",
    unpinAndDelete: "Lösen und löschen",
    search: "Artifacts durchsuchen",
    project: "Projekt",
    noMatch: "Kein Artifact passt zu „zzz“.",
    clear: "Filter zurücksetzen",
    emptyNone: "Noch keine Artifacts.",
    how: "So funktioniert das Veröffentlichen",
    howText: "artifact_publish",
    emptyPinned: "Nichts angepinnt.",
    gone: "Dieses Artifact ist nicht mehr verfügbar.",
    back: "Zurück",
    preview: (title) => `Vorschau von ${title}`,
  },
};

const shots = process.env.ARTIFACT_SCREENSHOT_DIR;
const row = (page, title) =>
  page.locator(".artifacts-list .list-row").filter({ hasText: title });
const tab = (page, name) => page.getByRole("tab", { name: new RegExp(`^${name}`) });

async function start(page, context, language, options) {
  await page.clock.setFixedTime(now);
  const state = await artifactsFixture(context, { language, ...options });
  return state;
}

for (const language of ["en", "de"]) {
  const t = labels[language];

  test(`artifact list and detail show where results came from (${language})`, async ({
    page,
    context,
  }) => {
    // Clipboard permissions differ per engine; record what the page copies instead.
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (text) => void (window.copiedText = text) },
      });
    });
    await start(page, context, language);
    const remote = [];
    page.on("requestfailed", (request) => {
      if (request.url().includes(remoteProbe))
        remote.push(`failed ${request.failure()?.errorText}`);
    });
    await context.route(`**${remoteProbe}`, (route) => {
      remote.push(`reached ${route.request().frame()?.url()}`);
      return route.fulfill({ status: 404, body: "" });
    });
    await page.goto(`${base}/artifacts`);
    await expect(page.getByRole("heading", { level: 1, name: t.title })).toBeVisible();
    await expect(tab(page, t.all)).toContainText("4");
    await expect(tab(page, t.pinned)).toContainText("2");
    for (const group of [t.today, t.yesterday, t.earlier])
      await expect(page.getByRole("heading", { name: group, exact: true })).toBeVisible();
    await expect(row(page, "Settings QA report")).toContainText(t.source);
    await expect(row(page, "Settings QA report")).toContainText(t.ago);
    await expect(row(page, "Dependency upgrade summary")).toContainText(t.deleted);
    await expect(page.locator(".artifacts-list")).not.toContainText("text/html");

    // Desktop preselects the newest artifact; its preview is inert and scriptless.
    const detail = page.locator(".artifact-detail");
    await expect(
      detail.getByRole("heading", { name: "Settings QA report" }),
    ).toBeVisible();
    await expect(detail).toContainText(t.meta);
    const frame = detail.locator(".artifact-preview iframe");
    await expect(frame).toHaveAttribute("sandbox", "");
    await expect(frame).toHaveAttribute("inert", "");
    await expect(frame).toHaveAttribute("title", t.preview("Settings QA report"));
    const preview = page.frameLocator(".artifact-preview iframe");
    await expect(preview.getByRole("heading", { name: "Private report" })).toHaveCSS(
      "color",
      "rgb(1, 2, 3)",
    );
    await expect(preview.locator("body")).not.toContainText("SCRIPT RAN");
    // The artifact's own policy stays first; inlined CSS cannot close its element and
    // remote image-set loads never leave the page.
    await expect(
      preview.locator('head > meta[http-equiv="Content-Security-Policy"]').first(),
    ).toHaveAttribute("content", /default-src 'none'/);
    await expect(preview.locator("#breakout")).toHaveCount(0);
    await expect(preview.locator("p")).toHaveText("Body");
    // Chromium reports the attempt as failed by CSP; it must never reach the network.
    await preview
      .locator("body")
      .evaluate(
        (body) =>
          body.ownerDocument.readyState === "complete" ||
          new Promise((resolve) =>
            body.ownerDocument.defaultView.addEventListener("load", resolve),
          ),
      );
    expect(remote.filter((entry) => entry.startsWith("reached"))).toEqual([]);
    await expect(detail.getByText(t.session)).toBeVisible();
    await expect(detail.getByText(t.ended)).toBeVisible();
    if (shots && language === "en")
      await page.screenshot({ path: `${shots}/artifacts-desktop-list.png` });
    await detail.getByRole("button", { name: t.details }).click();
    await expect(detail).toContainText(t.sizeFiles);

    // Selecting another row puts it into the address and the viewer's return link.
    await row(page, "Release notes preview").click();
    await expect(page).toHaveURL(`${base}/artifacts?artifact=a3`);
    await expect(row(page, "Release notes preview").getByRole("link")).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expect(
      detail.getByRole("heading", { name: "Release notes preview" }),
    ).toBeVisible();
    const open = detail.getByRole("link", { name: t.open("Release notes preview") });
    await expect(open).toHaveAttribute(
      "href",
      `/artifacts/view/a3?returnTo=${encodeURIComponent("/artifacts?artifact=a3")}`,
    );
    await expect(open).toHaveAttribute("target", "_blank");
    await detail.getByRole("button", { name: t.copyLink }).click();
    await expect(detail.getByRole("status").filter({ hasText: t.copied })).toContainText(
      t.linkHint,
    );
    expect(await page.evaluate(() => window.copiedText)).toBe(
      `${base}/artifacts/view/a3`,
    );
    if (shots && language === "en") {
      await page.evaluate(() =>
        document.querySelectorAll("*").forEach((node) => node.scrollTo?.(0, 0)),
      );
      await page.screenshot({ path: `${shots}/artifacts-desktop-detail.png` });
    }

    // Images preview as the picture itself.
    await row(page, "Checkout screenshots").click();
    await expect(detail).toContainText(t.image);
    await expect(
      page.frameLocator(".artifact-preview iframe").locator("img"),
    ).toBeVisible();
  });

  test(`artifacts pin, unpin orphans and delete after confirmation (${language})`, async ({
    page,
    context,
  }) => {
    const state = await start(page, context, language);
    await page.goto(`${base}/artifacts?artifact=a1`);
    const detail = page.locator(".artifact-detail");
    const pin = detail.getByRole("switch", { name: t.pinSwitch });
    await expect(pin).not.toBeChecked();
    await pin.click();
    await expect(pin).toBeChecked();
    await expect(tab(page, t.pinned)).toContainText("3");
    await expect(
      row(page, "Settings QA report").getByRole("img", { name: t.pinned }),
    ).toBeVisible();

    // Unpinning an artifact whose session is gone deletes it, so it asks first.
    await row(page, "Dependency upgrade summary").click();
    await detail.getByRole("switch", { name: t.pinSwitch }).click();
    const unpin = page.getByRole("dialog", { name: t.unpinTitle });
    await expect(unpin).toContainText("Dependency upgrade summary");
    await unpin.getByRole("button", { name: t.unpinAndDelete }).click();
    await expect(row(page, "Dependency upgrade summary")).toHaveCount(0);
    await expect(page).toHaveURL(`${base}/artifacts`);

    await row(page, "Checkout screenshots").click();
    await detail.getByRole("button", { name: t.deleteRow }).click();
    const dialog = page.getByRole("dialog", { name: t.deleteTitle });
    await expect(dialog).toContainText("Checkout screenshots");
    await dialog.getByRole("button", { name: /Cancel|Abbrechen/ }).click();
    await expect(dialog).toHaveCount(0);
    expect(state.items.some((item) => item.id === "a2")).toBe(true);
    await detail.getByRole("button", { name: t.deleteRow }).click();
    await dialog.getByRole("button", { name: t.remove, exact: true }).click();
    await expect(row(page, "Checkout screenshots")).toHaveCount(0);
    await expect(page).toHaveURL(`${base}/artifacts`);
    expect(state.items.map((item) => item.id)).toEqual(["a1", "a3"]);
  });

  test(`artifact search, project filter and empty states (${language})`, async ({
    page,
    context,
  }) => {
    const state = await start(page, context, language);
    await page.goto(`${base}/artifacts`);
    const search = page.getByRole("searchbox", { name: t.search });
    await search.fill("release");
    await expect(page).toHaveURL(`${base}/artifacts?q=release`);
    await expect(row(page, "Release notes preview")).toBeVisible();
    await page.reload();
    await expect(search).toHaveValue("release");
    await expect(page.locator(".artifacts-list .list-row")).toHaveCount(1);
    await expect(page.locator(".artifacts-list .list-row")).toHaveCount(1);
    await expect(row(page, "Release notes preview")).toBeVisible();
    await expect(tab(page, t.all)).toContainText("1");
    expect(state.requests.at(-1)).toContain("q=release");
    // Session names are searchable too.
    await search.fill("checkout flow");
    await expect(row(page, "Checkout screenshots")).toBeVisible();
    await search.fill("zzz");
    await expect(page.getByText(t.noMatch)).toBeVisible();
    await page.getByRole("button", { name: t.clear }).click();
    await expect(search).toHaveValue("");
    await expect(page.locator(".artifacts-list .list-row")).toHaveCount(4);

    await page.getByRole("combobox", { name: t.project }).selectOption("p2");
    await expect(page).toHaveURL(`${base}/artifacts/p2`);
    await expect(page.locator(".artifacts-list .list-row")).toHaveCount(1);
    await expect(row(page, "Checkout screenshots")).toBeVisible();
    await tab(page, t.pinned).click();
    await expect(page).toHaveURL(`${base}/artifacts/p2?tab=pinned`);
    await expect(page.getByRole("button", { name: t.clear })).toBeVisible();

    // A deep link to a deleted artifact falls back to the list with a notice.
    await page.goto(`${base}/artifacts?artifact=missing`);
    await expect(page.getByText(t.gone)).toBeVisible();
    await expect(page).toHaveURL(`${base}/artifacts`);

    state.items = [];
    await page.goto(`${base}/artifacts`);
    await expect(page.getByText(t.emptyNone)).toBeVisible();
    await page.getByRole("button", { name: t.how }).click();
    await expect(page.getByText(t.howText)).toBeVisible();
    await tab(page, t.pinned).click();
    await expect(page.getByText(t.emptyPinned)).toBeVisible();
  });

  test(`artifacts on a phone open as a subpage with a back arrow (${language})`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await start(page, context, language);
    await page.goto(`${base}/artifacts`);
    await expect(row(page, "Settings QA report")).toBeVisible();
    await expect(page.locator(".mobile-header")).toBeHidden();
    await expect(page.locator(".artifact-detail")).toHaveCount(0);
    if (shots && language === "en")
      await page.screenshot({ path: `${shots}/artifacts-phone-list.png` });
    await row(page, "Settings QA report").click();
    await expect(page).toHaveURL(`${base}/artifacts?artifact=a1`);
    await expect(
      page.getByRole("heading", { level: 1, name: "Settings QA report" }),
    ).toBeVisible();
    await expect(page.locator(".artifacts-list")).toHaveCount(0);
    const open = page.getByRole("link", { name: t.open("Settings QA report") });
    await expect(open).toBeInViewport();
    const width = await open.evaluate((node) => node.getBoundingClientRect().width);
    expect(width).toBeGreaterThan(300);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    if (shots && language === "en")
      await page.screenshot({ path: `${shots}/artifacts-phone-detail.png` });
    await page.getByRole("button", { name: t.back, exact: true }).click();
    await expect(page).toHaveURL(`${base}/artifacts`);
    // The arrow replaced the detail entry: system back does not reopen it.
    await page.goBack();
    await expect(page).not.toHaveURL(/artifact=/);
    await expect(row(page, "Settings QA report")).toBeVisible();
  });
}

// WebKit can drop the media query change event at a breakpoint (AGENTPIER-50);
// suppressing it here must not keep the phone list on a wide window.
test("a wide window preselects an artifact even when the change event is lost", async ({
  page,
  context,
}) => {
  await page.addInitScript(() => {
    const add = MediaQueryList.prototype.addEventListener;
    MediaQueryList.prototype.addEventListener = function (type, ...rest) {
      if (type !== "change") add.call(this, type, ...rest);
    };
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await start(page, context, "en");
  await page.goto(`${base}/artifacts`);
  await expect(row(page, "Settings QA report")).toBeVisible();
  await expect(page.locator(".artifact-detail")).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(
    page.locator(".artifact-detail").getByRole("heading", { name: "Settings QA report" }),
  ).toBeVisible();
});
