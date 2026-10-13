import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatAssistant, chatFixture } from "../helpers/assistant-chat-fixture.js";

// A finished team with a long objective and a long member assignment must stay
// inside the transcript; the transcript itself never scrolls sideways.
const chat = baseURL + "/agents/home/chats/dinner";
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
    ],
    teams: [
      {
        id: "team",
        revision: 1,
        parentAssistantId: "home",
        parentConversationId: "dinner",
        objective,
        phase: "completed",
        members: [],
        memberIds: ["member-0"],
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

for (const language of ["de", "en"])
  for (const [size, viewport] of sizes)
    test(`team card fits the transcript (${language}, ${size})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await chatFixture(page, setup(language));
      await page.goto(chat);
      const card = page.locator(".assistant-team-card");
      await card.locator("summary").click();
      await expect(card).toHaveAttribute("open", "");
      const transcript = page.locator(".assistant-transcript");
      await expect(transcript.locator("pre")).toBeVisible();

      const widths = await page.evaluate(() => {
        const t = document.querySelector(".assistant-transcript");
        const d = document.scrollingElement;
        return {
          document: [d.scrollWidth, d.clientWidth],
          transcript: [t.scrollWidth, t.clientWidth],
        };
      });
      expect(widths.document[0]).toBe(widths.document[1]);
      expect(widths.transcript[0]).toBe(widths.transcript[1]);

      const [outer, inner] = await Promise.all([
        transcript.boundingBox(),
        card.boundingBox(),
      ]);
      expect(inner.x).toBeGreaterThanOrEqual(outer.x);
      expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width + 0.5);

      // The objective wraps onto several lines; the assignment ends in an ellipsis.
      const title = card.locator(".assistant-team-title strong");
      const fontSize = await title.evaluate((e) =>
        parseFloat(getComputedStyle(e).fontSize),
      );
      if (size === "phone")
        expect((await title.boundingBox()).height).toBeGreaterThan(fontSize * 2);
      const detail = card.locator(".assistant-team-member small");
      await expect(detail).toHaveCSS("text-overflow", "ellipsis");
      expect(
        await detail.evaluate((e) => e.scrollWidth > e.clientWidth),
        "the long assignment is truncated",
      ).toBe(true);
      const box = await detail.boundingBox();
      expect(box.x + box.width).toBeLessThanOrEqual(inner.x + inner.width);

      // The bordered row under the member is the archive button; its label is visible.
      const button = card.getByRole("button", { name: archive[language], exact: true });
      await button.scrollIntoViewIfNeeded();
      await expect(button).toBeInViewport({ ratio: 1 });
      expect(await button.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    });
