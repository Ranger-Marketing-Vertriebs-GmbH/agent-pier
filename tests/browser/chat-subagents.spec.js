import { test, expect } from "../helpers/browser-test.js";
import { subagentFixture } from "./subagent-fixture.js";

const copy = {
  "de-DE": {
    running: "Arbeitet",
    completed: "Erledigt",
    unknown: "Status unbekannt",
    review: "Unteragent: Review parser (general-purpose)",
    styles: "Unteragent: Check styles (Explore)",
    show: "Unteragenten anzeigen",
    active: "Unteragenten (2 · 1 aktiv)",
    older: "Ältere Nachrichten laden",
    total: "Unteragenten (2)",
  },
  "en-GB": {
    running: "Working",
    completed: "Completed",
    unknown: "Status unknown",
    review: "Subagent: Review parser (general-purpose)",
    styles: "Subagent: Check styles (Explore)",
    show: "Show subagents",
    active: "Subagents (2 · 1 active)",
    older: "Load older messages",
    total: "Subagents (2)",
  },
};

for (const locale of ["de-DE", "en-GB"]) {
  test.describe(locale, () => {
    test.use({ locale });
    const text = copy[locale];

    test("subagent rows stand outside tool groups with their label, status and report", async ({
      page,
    }) => {
      const { data, publish } = await subagentFixture(page);
      const review = page.locator('.chat-subagent[data-message-id="toolu_review"]');
      const styles = page.locator('.chat-subagent[data-message-id="toolu_styles"]');
      await expect(review.locator("summary")).toBeVisible();
      await expect(review.locator("summary strong")).toHaveText(text.review);
      await expect(review.locator("summary small")).toHaveText(text.completed);
      await expect(styles.locator("summary strong")).toHaveText(text.styles);
      await expect(styles.locator("summary small")).toHaveText(text.running);
      // Ordinary tools stay grouped; subagent rows are never folded into a group.
      await expect(page.locator(".chat-tool-group")).toHaveCount(1);
      await expect(page.locator(".chat-tool-group .chat-subagent")).toHaveCount(0);
      await review.locator("summary").click();
      await expect(review).toContainText("The parser handles every fixture shape.");
      // Stale data never claims a subagent is still working.
      data.observability.stale = true;
      publish();
      await expect(styles.locator("summary small")).toHaveText(text.unknown);
    });

    test("the subagent list shows working agents first and finished ones below", async ({
      page,
    }) => {
      const { data, publish } = await subagentFixture(page);
      const count = page.getByRole("button", { name: text.show });
      await expect(count).toHaveText(text.active);
      await count.click();
      const panel = page.locator(".background-tasks");
      const entries = panel.locator(".subagent-entry");
      await expect(entries).toHaveCount(2);
      await expect(entries.nth(0)).toContainText("Check styles");
      await expect(entries.nth(0).locator(".subagent-status")).toHaveText(text.running);
      await expect(entries.nth(1)).toContainText("Review parser");
      await expect(entries.nth(1).locator(".subagent-status")).toHaveText(text.completed);
      data.observability.subagents[1].status = "completed";
      publish();
      await expect(count).toHaveText(text.total);
      await expect(panel.locator(".subagent-status.running")).toHaveCount(0);
    });

    test("a frozen subagent row from an older page follows the observed state", async ({
      page,
    }) => {
      const { data, publish } = await subagentFixture(page, { older: true });
      await page.getByRole("button", { name: text.older }).click();
      const old = page.locator('.chat-subagent[data-message-id="toolu_old"]');
      // The older page still says running; the observer knows it completed.
      await expect(old.locator("summary small")).toHaveText(text.completed);
      data.observability.subagents = data.observability.subagents.filter(
        (agent) => agent.id !== "agentold03",
      );
      publish();
      await expect(old.locator("summary small")).toHaveText(text.unknown);
    });

    test("following the end of a short chat never loads older messages by itself", async ({
      page,
    }) => {
      const history = [];
      page.on("request", (request) => {
        if (request.url().includes("/chat/history")) history.push(request.url());
      });
      const { data, publish } = await subagentFixture(page, { older: true });
      // A new reply makes the view follow its end: a scroll down, close to the top
      // while the chat barely overflows. Only a scroll up loads older messages.
      data.messages = [
        ...data.messages,
        { id: "more", role: "assistant", text: "Done." },
      ];
      publish();
      await expect(page.locator(".chat-messages")).toContainText("Done.");
      // The page clock stands still: wait in the test runner for the scroll event.
      await page.waitForTimeout(300);
      expect(history).toEqual([]);
      await expect(page.getByRole("button", { name: text.older })).toBeVisible();
    });
  });
}

test.describe("subagent list updates", () => {
  test.use({ locale: "en-GB" });
  const open = async (page) => {
    await page.getByRole("button", { name: "Show subagents" }).click();
    return page.locator(".background-tasks");
  };
  // Counts list entries the browser removes or inserts, and marks the current ones.
  const watch = (page) =>
    page.evaluate(() => {
      const list = document.querySelector(".background-tasks");
      window.entryChanges = { added: 0, removed: 0 };
      const entries = (nodes) =>
        [...nodes].filter((node) => node.classList?.contains("subagent-entry")).length;
      new MutationObserver((records) => {
        for (const record of records) {
          window.entryChanges.added += entries(record.addedNodes);
          window.entryChanges.removed += entries(record.removedNodes);
        }
      }).observe(list, { childList: true, subtree: true });
      for (const entry of list.querySelectorAll(".subagent-entry"))
        entry.dataset.original = entry.textContent.slice(0, 40);
    });
  const changes = (page) => page.evaluate(() => window.entryChanges);

  test("live frames update listed agents in place without re-creating them", async ({
    page,
  }) => {
    const { data, publish } = await subagentFixture(page);
    const panel = await open(page);
    const entries = panel.locator(".subagent-entry");
    await expect(entries).toHaveCount(2);
    await watch(page);
    for (let frame = 0; frame < 4; frame++) {
      publish();
      await page.waitForTimeout(50);
    }
    data.observability.subagents[1] = {
      ...data.observability.subagents[1],
      task: "Check styles and tokens",
      updatedAt: "2026-09-07T10:00:11Z",
    };
    publish();
    await expect(entries.nth(0)).toContainText("Check styles and tokens");
    data.observability.subagents.push({
      id: "agentdocs04",
      name: "Explore",
      task: "Read the docs",
      status: "running",
      updatedAt: "2026-09-07T10:00:12Z",
    });
    publish();
    await expect(entries).toHaveCount(3);
    publish();
    await expect(page.getByRole("button", { name: "Show subagents" })).toHaveText(
      "Subagents (3 · 2 active)",
    );
    expect(await changes(page)).toEqual({ added: 1, removed: 0 });
    await expect(panel.locator(".subagent-entry[data-original]")).toHaveCount(2);
  });
});
