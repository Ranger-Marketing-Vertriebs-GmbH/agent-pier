// The split view screenshots of the README and the views guide: three panes (a
// terminal, a session chat and an agent chat) and a session dragged onto a pane edge.
// Normal runs only check the scene; AGENTPIER_UPDATE_DOC_SCREENSHOTS=1 refreshes the
// images under docs/screenshots.
import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { chatAssistant } from "../helpers/assistant-chat-fixture.js";
import { mockChatStream } from "../helpers/chat-stream-fixture.js";
import { docScreenshot } from "../helpers/doc-screenshots.js";
import { dragOver, paneTransfer } from "../helpers/pane-drag.js";
import {
  leaf,
  paneOf,
  sessions,
  split,
  splitViewFixture,
  viewId,
} from "../helpers/split-views-browser.js";

test.use({ viewport: { width: 1600, height: 1000 } });

const S1 = "session:s1",
  S2 = "session:s2",
  C1 = "chat:a1:c1";

// Three columns: row(s1 terminal, row(s2 chat, c1)).
const heroLayout = () =>
  split("row", leaf.s1(), split("row", leaf.s2("chat"), leaf.c1()), 0.42);

// The fixture's sessions with an activity, so the sidebar and pane headers show one.
const withActivity = (session, state) => ({ ...session, activity: { state } });

const docsSite = withActivity(
  {
    id: "s3",
    name: "Docs site",
    tool: "claude",
    cwd: "/fixture/docs",
    status: "running",
  },
  "waiting",
);

const at = "2026-11-01T10:00:00.000Z";
const otherView = {
  id: "v_fedcba9876543210",
  name: "Release day",
  layout: split("row", leaf.s1(), leaf.c1()),
  revision: 1,
  createdAt: at,
  usedAt: at,
};

const esc = "\u001b[";
const dim = (text) => `${esc}2m${text}${esc}0m`;
const orange = (text) => `${esc}38;5;209m${text}${esc}0m`;
const green = (text) => `${esc}32m${text}${esc}0m`;
const red = (text) => `${esc}31m${text}${esc}0m`;
const bold = (text) => `${esc}1m${text}${esc}0m`;

// A Claude Code turn in the billing session's terminal.
const terminalOutput = [
  `${orange("✻")} ${bold("Welcome to Claude Code!")}`,
  "",
  `${dim("  cwd: /fixture/billing")}`,
  "",
  `${dim(">")} Move invoice rounding into one helper and test it.`,
  "",
  `${orange("●")} I'll look at how invoices round today.`,
  "",
  `${orange("●")} ${bold("Search")}(pattern: "Math.round", path: "src/billing")`,
  `  ${dim("⎿  Found 4 files")}`,
  "",
  `${orange("●")} ${bold("Update")}(src/billing/rounding.js)`,
  `  ${dim("⎿  Updated rounding.js with 3 additions")}`,
  `     ${green("+ export function roundCents(amount) {")}`,
  `     ${green("+   return Math.round(amount * 100) / 100;")}`,
  `     ${green("+ }")}`,
  "",
  `${orange("●")} ${bold("Update")}(src/billing/invoice.js)`,
  `  ${dim("⎿  Updated invoice.js with 1 addition and 1 removal")}`,
  `     ${red("- const total = Math.round(sum * 100) / 100;")}`,
  `     ${green("+ const total = roundCents(sum);")}`,
  "",
  `${orange("●")} ${bold("Bash")}(npm test -- billing)`,
  `  ${dim("⎿")}  ${green("✔")} rounds half cents up (2 ms)`,
  `     ${green("✔")} keeps totals of zero (1 ms)`,
  `     ${green("✔")} sums line items before rounding (1 ms)`,
  `     ${dim("tests 3 · pass 3 · fail 0")}`,
  "",
  `${orange("●")} All invoice totals now go through`,
  "  roundCents(), and the three new tests pass.",
  "",
  `${dim("╭──────────────────────────────────────────────╮")}`,
  `${dim("│")} >                                            ${dim("│")}`,
  `${dim("╰──────────────────────────────────────────────╯")}`,
  `${dim("  ? for shortcuts")}`,
].join("\r\n");

// The shop session's chat (Codex).
const shopChat = {
  availability: "ready",
  tasks: [],
  messages: [
    {
      id: "q1",
      role: "user",
      text: "The checkout button jumps when the cart total changes. Can you fix it?",
    },
    {
      id: "a1",
      role: "assistant",
      text:
        "The total renders without a fixed width, so the button moves with every " +
        "digit. I gave the total `tabular-nums` and a minimum width in " +
        "`CheckoutBar.css`.\n\n" +
        "- `npm test -- checkout`: 14 passed\n" +
        "- Checked at 390 px and 1440 px",
    },
    { id: "q2", role: "user", text: "Great, commit it." },
    {
      id: "a2",
      role: "assistant",
      text: "Committed as `fix: keep the checkout button in place`.",
    },
  ],
};

// The planner agent's chat.
const plannerChat = {
  assistants: [
    chatAssistant({
      id: "a1",
      name: "Planner",
      model: { connectionId: "router", modelId: "anthropic/claude-sonnet-5" },
    }),
  ],
  conversations: [{ id: "c1", assistantId: "a1", main: true }],
  history: {
    messages: [
      {
        id: "p1",
        role: "user",
        text: "What is left before Friday's release?",
      },
      {
        id: "p2",
        role: "assistant",
        text:
          "Three items are left:\n\n" +
          "1. **Billing:** the rounding fix is in review.\n" +
          "2. **Shop:** the checkout fix is committed.\n" +
          "3. **Docs:** the upgrade notes still need a draft.\n\n" +
          "Shall I start a session for the upgrade notes?",
      },
    ],
    requests: [],
    stale: false,
  },
};

async function heroFixture(page) {
  const controls = await splitViewFixture(page, {
    layout: heroLayout(),
    chat: plannerChat,
  });
  controls.views = [...controls.views, otherView];
  controls.sessions = [
    withActivity(sessions.s1, "idle"),
    withActivity(sessions.s2, "working"),
    docsSite,
  ];
  await mockChatStream(page, () => shopChat);
  await page.route(/\/api\/sessions\/s2\/chat(\?|$)/, (route) =>
    route.fulfill({ json: shopChat }),
  );
  await page.routeWebSocket("**/api/sessions/*/terminal", (socket) => {
    socket.send(JSON.stringify({ type: "output", data: terminalOutput }));
  });
  return controls;
}

async function openHero(page) {
  await page.goto(`${baseURL}/views/${viewId}`);
  await expect(page.locator(".split-pane")).toHaveCount(3);
  await expect(paneOf(page, S1).locator(".xterm-rows")).toContainText("roundCents");
  await expect(paneOf(page, S2)).toContainText("fix: keep the checkout button");
  await expect(paneOf(page, C1)).toContainText("Shall I start a session");
  await page.mouse.move(0, 0);
}

test("three panes side by side: terminal, session chat and agent chat", async ({
  page,
}) => {
  await heroFixture(page);
  await openHero(page);
  await expect(page.locator(".sidebar")).toContainText("Release day");
  await page.screenshot({
    path: docScreenshot("docs/screenshots/split-view-desktop.png"),
  });
});

test("a session dragged onto a pane's edge shows where it will split", async ({
  page,
}) => {
  await heroFixture(page);
  await openHero(page);
  const transfer = await paneTransfer(page, { item: { kind: "session", id: "s3" } });
  await dragOver(paneOf(page, C1), "right", transfer);
  await expect(paneOf(page, C1).locator(".drop-zone-overlay")).toHaveAttribute(
    "data-side",
    "right",
  );
  await page.screenshot({
    path: docScreenshot("docs/screenshots/split-view-drop-desktop.png"),
  });
});
