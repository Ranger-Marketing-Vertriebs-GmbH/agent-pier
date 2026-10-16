// While a run summarises a long conversation, the chat says so instead of "Working";
// afterwards a quiet note marks where earlier messages were summarised
// (server/features/assistants/compactions.js, conversations.js).
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatFixture, emit } from "../helpers/assistant-chat-fixture.js";

const question = { id: "u1", role: "user", text: "What is my DNS server?", timestamp: 1 };
const request = (state) => ({
  id: "q1",
  state: state === "completed" ? "completed" : "accepted",
  text: question.text,
  attempt: { id: "a1", state },
});
const earlier = [
  { id: "u0", role: "user", text: "My router lives at 10.0.0.1.", timestamp: 0.5 },
  { id: "a0", role: "assistant", text: "Noted.", timestamp: 0.6 },
];
const note = {
  id: "compaction:c1",
  role: "event",
  event: "compaction",
  tokensBefore: 251400,
  tokensAfter: 18200,
  timestamp: 0.9,
  runId: null,
};
const compacting = {
  messages: [...earlier, question],
  requests: [request("running")],
  stale: false,
  compacting: true,
};
const answered = {
  messages: [
    ...earlier,
    note,
    question,
    { id: "m1", role: "assistant", runId: "a1", text: "10.0.0.53.", timestamp: 2 },
  ],
  requests: [request("completed")],
  stale: false,
};
const copy = {
  en: {
    running:
      "Summarising the conversation so far — this can take a few minutes for long chats.",
    header: "Summarising conversation",
    working: "Working",
    note: "Earlier messages were summarised (about 251k → 18k tokens).",
  },
  de: {
    running:
      "Fasst den bisherigen Verlauf zusammen – bei langen Chats kann das ein paar Minuten dauern.",
    header: "Fasst Verlauf zusammen",
    working: "Arbeitet",
    note: "Ältere Nachrichten wurden zusammengefasst (etwa 251k → 18k Tokens).",
  },
};
const runState = (page) => page.locator(".assistant-run-state");
const headerLabel = (page) => page.locator(".assistant-header-label");

for (const language of ["en", "de"])
  test(`the chat says it summarises, then leaves a note (${language})`, async ({
    page,
  }) => {
    const text = copy[language];
    const state = await chatFixture(page, { language, history: compacting });
    await page.goto(baseURL + "/agents/home/chats/dinner");
    await expect(runState(page)).toHaveText(text.running);
    await expect(runState(page)).toHaveAttribute("role", "status");
    await expect(runState(page)).toBeVisible();
    await expect(headerLabel(page)).toHaveText(text.header);
    await expect(page.locator("[data-compaction-note]")).toHaveCount(0);
    // The summary is over; the run answers.
    state.history = { ...compacting, compacting: false };
    await emit(page, { type: "change" });
    await expect(runState(page)).toHaveText(text.working);
    await expect(headerLabel(page)).toHaveText(text.working);
    state.history = answered;
    await emit(page, { type: "change" });
    const shown = page.locator("[data-compaction-note]");
    await expect(shown).toHaveText(text.note);
    await expect(shown).toHaveClass(/assistant-event/);
    // The note sits where the history was shortened: before the new question.
    const order = await page
      .getByRole("log")
      .locator(".assistant-message, [data-compaction-note]")
      .evaluateAll((items) =>
        items.map((item) =>
          item.matches("[data-compaction-note]") ? "note" : "message",
        ),
      );
    expect(order).toEqual(["message", "message", "note", "message", "message"]);
  });

test("the summarising status fits a phone and stays clear of the composer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await chatFixture(page, { history: compacting });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  const line = runState(page);
  await expect(line).toHaveText(copy.en.running);
  await expect(line).toBeInViewport();
  const box = await line.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  // The header keeps its short form on one line.
  await expect(headerLabel(page)).toHaveText(copy.en.header);
  const label = await headerLabel(page).boundingBox();
  expect(label.x + label.width).toBeLessThanOrEqual(390);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});
