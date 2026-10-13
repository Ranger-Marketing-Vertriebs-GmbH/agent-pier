import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatAssistant, chatFixture } from "../helpers/assistant-chat-fixture.js";

// Teams with a long objective and a long member assignment must stay inside their
// column wherever their cards are rendered: the team list in Settings → Work and the
// proposal and review cards in the lead's chat. Nothing scrolls sideways.
const chat = baseURL + "/agents/home/chats/dinner";
const work = baseURL + "/agents/home/settings?tab=work&team=team";
const objective =
  "Verwaltung, Dokumentation und Planung der Netzwerk-Topologie, IP-Adressen, " +
  "VLANs, WLAN-Infrastruktur und aller Dienste im Heimnetz";
const assignment =
  "Verwalte und kenne die gesamte Netzwerk-Topologie, IP-Adresspläne, Subnetze, " +
  "VLANs, Hosts, Services und Netzwerkgeräte. Sei der zentrale Ansprechpartner.";
const url =
  "https://example.com/" + "a-very-long-path-segment-without-any-break-".repeat(4);
const code = "const value = " + "'x'.repeat(10) + ".repeat(12) + "'end';";

function setup(language) {
  return {
    language,
    assistants: [
      chatAssistant(),
      chatAssistant({
        id: "member-0",
        name: "Network Architect",
        teamMemberId: "member-0",
        teamId: "team",
        parentAssistantId: "home",
        lifetime: "task",
      }),
      chatAssistant({
        id: "member-1",
        name: "Network Auditor",
        teamMemberId: "member-1",
        teamId: "review",
        parentAssistantId: "home",
        lifetime: "task",
      }),
    ],
    conversations: [
      { id: "dinner", assistantId: "home" },
      { id: "member-chat", assistantId: "member-0" },
    ],
    members: [
      {
        id: "member-0",
        kind: "member",
        teamId: "team",
        parentAssistantId: "home",
        assistantId: "member-0",
        name: "Network Architect",
        role: "Network",
        assignment,
        lifetime: "task",
        phase: "completed",
        conversationId: "member-chat",
      },
      {
        id: "member-1",
        kind: "member",
        teamId: "review",
        parentAssistantId: "home",
        assistantId: "member-1",
        name: "Network Auditor",
        role: "Network",
        assignment,
        lifetime: "task",
        phase: "provisioning_uncertain",
        conversationId: null,
      },
    ],
    teams: [
      {
        id: "team",
        revision: 1,
        parentAssistantId: "home",
        parentConversationId: "dinner",
        objective,
        phase: "completed",
        createdAt: "2026-10-13T09:00:00.000Z",
        finishedAt: "2026-10-13T09:30:00.000Z",
        members: [],
        memberIds: ["member-0"],
      },
      {
        id: "proposal",
        revision: 1,
        parentAssistantId: "home",
        parentConversationId: "dinner",
        objective: `${objective} (2)`,
        phase: "awaiting_approval",
        createdAt: "2026-10-13T10:00:00.000Z",
        members: [{ name: "Network Architect", role: "Network", assignment }],
        memberIds: [],
      },
      {
        id: "review",
        revision: 1,
        parentAssistantId: "home",
        parentConversationId: "dinner",
        objective: `${objective} (3)`,
        phase: "running",
        status: "uncertain",
        createdAt: "2026-10-13T10:10:00.000Z",
        members: [],
        memberIds: ["member-1"],
      },
    ],
    history: {
      messages: [
        { id: "question", role: "user", text: `Look at ${url}` },
        {
          id: "answer",
          role: "assistant",
          text: `See ${url} and run \`${code}\`:\n\n\`\`\`js\n${code}\n\`\`\``,
        },
      ],
      requests: [],
      stale: false,
    },
  };
}

const sizes = [
  ["phone", { width: 390, height: 844 }],
  ["desktop", { width: 1440, height: 1000 }],
];
const archive = { de: "Archivieren", en: "Archive" };

const noSideways = async (page, selector) => {
  const widths = await page.evaluate((selector) => {
    const d = document.scrollingElement;
    return [d, ...document.querySelectorAll(selector)].map((e) => [
      e.scrollWidth,
      e.clientWidth,
    ]);
  }, selector);
  for (const [scroll, client] of widths) expect(scroll).toBe(client);
};
const inside = async (outer, inner) => {
  const [o, i] = await Promise.all([outer.boundingBox(), inner.boundingBox()]);
  expect(i.x).toBeGreaterThanOrEqual(o.x);
  expect(i.x + i.width).toBeLessThanOrEqual(o.x + o.width + 0.5);
};
const wraps = async (title) => {
  const fontSize = await title.evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
  expect((await title.boundingBox()).height).toBeGreaterThan(fontSize * 2);
};

for (const language of ["de", "en"])
  for (const [size, viewport] of sizes) {
    test(`team card fits the Work tab (${language}, ${size})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await chatFixture(page, setup(language));
      await page.goto(work);
      const card = page.locator("#assistant-team-team");
      await expect(card).toHaveAttribute("open", "");
      await noSideways(page, ".assistant-settings-scroll, #agent-teams");
      await inside(page.locator("#agent-teams"), card);

      // The objective wraps onto several lines; the assignment ends in an ellipsis.
      const title = card.locator(".assistant-team-title strong");
      if (size === "phone") await wraps(title);
      const detail = card.locator(".assistant-team-member small");
      await expect(detail).toHaveCSS("text-overflow", "ellipsis");
      expect(
        await detail.evaluate((e) => e.scrollWidth > e.clientWidth),
        "the long assignment is truncated",
      ).toBe(true);
      await inside(card, detail);

      // The archive button's label is visible in full.
      const button = card.getByRole("button", { name: archive[language], exact: true });
      await button.scrollIntoViewIfNeeded();
      await expect(button).toBeInViewport({ ratio: 1 });
      expect(await button.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    });

    test(`proposal, review and notes fit the transcript (${language}, ${size})`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await chatFixture(page, setup(language));
      await page.goto(chat);
      const transcript = page.locator(".assistant-transcript");
      await expect(transcript.locator("pre")).toBeVisible();
      const proposal = page.locator(".assistant-team-card.awaiting");
      const review = page.locator("#assistant-team-review-review");
      await expect(proposal).toBeVisible();
      await expect(review).toBeVisible();
      await noSideways(page, ".assistant-transcript");
      await inside(transcript, proposal);
      await inside(transcript, review);
      if (size === "phone") await wraps(proposal.locator(".assistant-team-title strong"));
      await inside(proposal, proposal.locator(".assistant-team-proposal small").first());
      for (const button of await proposal
        .locator(".assistant-card-actions .button")
        .all())
        expect(await button.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);

      // Notes and the review heading clamp the objective; their title keeps it.
      const note = transcript.locator(".assistant-team-note a").first();
      await inside(transcript, note);
      const clamped = [note.locator("span"), review.locator(".assistant-team-clamp")];
      if (size === "phone")
        for (const text of clamped)
          expect(
            await text.evaluate((e) => e.scrollHeight > e.clientHeight),
            "the long objective is clamped",
          ).toBe(true);
      await expect(note).toHaveAttribute("title", new RegExp(objective.slice(0, 40)));
    });
  }
