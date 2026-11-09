import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";

// Agent cards in the chat (history messages with `card` or `cardMoved`): the blocks,
// silent ticks, button presses that send a message, and the marker of a moved card.
const at = "2026-11-09T07:09:00.000Z";
const dinners = {
  id: "card_dinners",
  title: "Dinners week 46",
  version: 1,
  updatedAt: at,
  frozen: false,
  blocks: [
    {
      type: "table",
      columns: ["Day", "Dish"],
      rows: [
        { cells: ["Mon", "Chicken and broccoli"], action: { label: "Swap" } },
        { cells: ["Tue", "Lasagne with savoy"], action: { label: "Swap" } },
      ],
    },
    {
      type: "checklist",
      id: "shopping",
      title: "Shopping list",
      items: [
        { id: "chicken", text: "1.8 kg chicken", checked: false },
        { id: "rice", text: "500 g rice", checked: true },
      ],
    },
    {
      type: "actions",
      items: [
        { label: "Recipes for Monday", primary: true },
        { label: "Add the weekend" },
      ],
    },
  ],
};
const status = {
  id: "card_status",
  title: "Infrastructure status",
  version: 3,
  updatedAt: at,
  frozen: false,
  blocks: [
    {
      type: "metrics",
      items: [
        { label: "Hosts ok", value: "11", tone: "ok" },
        { label: "Warnings", value: "1", tone: "warn" },
        { label: "Problems", value: "0" },
      ],
    },
    {
      type: "status",
      items: [
        { label: "monitoring", state: "ok", detail: "Disk 29 %" },
        { label: "mimir", state: "warn", detail: "Link down 23:32" },
      ],
    },
    {
      type: "chart",
      kind: "line",
      label: "Load proxmox-1, 24 h",
      unit: "%",
      points: [20, 24, 30, 42, 50, 38, 35, 40].map((value, i) => ({
        label: `${String(i * 3).padStart(2, "0")}:00`,
        value,
      })),
    },
    { type: "links", items: [{ label: "Zabbix", url: "https://zabbix.example/" }] },
  ],
};
const item = (card, n, timestamp) => ({
  id: `card:${card.id}:${n}`,
  role: "assistant",
  text: "",
  timestamp,
  card,
});
const now = Date.parse(at);
const history = {
  messages: [
    { id: "q1", role: "user", text: "Check the hosts", timestamp: now - 60000 },
    {
      id: "moved",
      role: "assistant",
      text: "",
      timestamp: now - 50000,
      cardMoved: { id: status.id, title: status.title },
    },
    { id: "a1", role: "assistant", text: "Here is the plan.", timestamp: now - 40000 },
    item(dinners, 1, now - 30000),
    // A marker the card follows directly is not shown.
    {
      id: "adjacent",
      role: "assistant",
      text: "",
      timestamp: now - 20000,
      cardMoved: { id: status.id, title: status.title },
    },
    item(status, 3, now - 10000),
  ],
  requests: [],
  stale: false,
};

async function open(page) {
  const state = await chatFixture(page, {
    conversations: [{ id: "dinner", assistantId: "home", title: "Dinner plans" }],
    history,
  });
  state.cardCalls = [];
  await page.route("**/api/assistant-conversations/dinner/cards/**", async (route) => {
    const url = new URL(route.request().url());
    const body = route.request().postDataJSON();
    state.cardCalls.push([url.pathname.split("/").slice(-2).join("/"), body]);
    await route.fulfill({
      json: url.pathname.endsWith("/press")
        ? { text: "Swap: Tue · Lasagne with savoy", card: dinners }
        : dinners,
    });
  });
  await page.goto(`${baseURL}/agents/home/chats/dinner`);
  return state;
}

for (const [name, use] of [
  ["desktop", { viewport: { width: 1280, height: 900 } }],
  ["phone", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
])
  test.describe(name, () => {
    test.use(use);

    test("cards show their blocks; ticks are silent and buttons send a message", async ({
      page,
    }) => {
      const state = await open(page);
      const plan = page.getByRole("article", { name: "Card: Dinners week 46" });
      await expect(plan.getByRole("row")).toHaveCount(3);
      await expect(plan.getByRole("checkbox", { name: "500 g rice" })).toBeChecked();
      const board = page.getByRole("article", { name: "Card: Infrastructure status" });
      await expect(board).toContainText("Version 3 · updated");
      await expect(board.locator(".agent-card-metric")).toHaveCount(3);
      await expect(board.locator(".agent-card-tile.state-warn")).toContainText(
        "mimir",
      );
      await expect(board.getByRole("table", { name: "Chart: Load proxmox-1, 24 h" }))
        .toBeAttached();
      await expect(board.getByRole("link", { name: "Zabbix" })).toHaveAttribute(
        "rel",
        "noopener noreferrer",
      );
      // Only the marker with a message after it shows.
      await expect(page.locator(".agent-card-moved")).toHaveCount(1);
      for (const card of [plan, board]) {
        const box = await card.boundingBox();
        expect(box.width).toBeLessThanOrEqual(use.viewport.width);
      }
      await page.screenshot({ path: test.info().outputPath("cards.png"), fullPage: true });

      const chicken = plan.getByRole("checkbox", { name: "1.8 kg chicken" });
      await chicken.check();
      await expect(chicken).toBeChecked();
      await expect
        .poll(() => state.cardCalls)
        .toEqual([
          ["card_dinners/check", { version: 1, block: 1, item: "chicken", checked: true }],
        ]);
      expect(state.posted).toEqual([]);

      await plan.getByRole("row", { name: /Tue/ }).getByRole("button", { name: "Swap" }).click();
      await expect.poll(() => state.posted.map((p) => p.text)).toEqual([
        "Swap: Tue · Lasagne with savoy",
      ]);
      expect(state.cardCalls.at(-1)).toEqual([
        "card_dinners/press",
        { version: 1, block: 0, row: 1 },
      ]);
    });

    test("the marker of a moved card leads to the card", async ({ page }) => {
      await open(page);
      const marker = page.getByRole("button", {
        name: "Show the updated card “Infrastructure status”",
      });
      await marker.click();
      const board = page.getByRole("article", { name: "Card: Infrastructure status" });
      await expect(board).toBeInViewport();
    });
  });
