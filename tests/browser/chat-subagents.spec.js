import { test, expect } from "@playwright/test";
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

    test("the subagent list shows working agents first and recent finished ones", async ({
      page,
    }) => {
      const { data, publish } = await subagentFixture(page);
      const count = page.getByRole("button", { name: text.show });
      await expect(count).toHaveText(text.active);
      await count.click();
      const panel = page.locator(".chat-subagents");
      const entries = panel.locator(".subagent-entry");
      await expect(entries).toHaveCount(2);
      await expect(entries.nth(0)).toContainText("Check styles");
      await expect(entries.nth(0).locator(".subagent-status")).toHaveText(text.running);
      await expect(entries.nth(1)).toContainText("Review parser");
      await expect(entries.nth(1).locator(".subagent-status")).toHaveText(text.completed);
      data.observability.subagents[1].status = "completed";
      publish();
      await expect(panel.getByRole("heading")).toHaveText(text.total);
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
  });
}
