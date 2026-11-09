import test from "node:test";
import assert from "node:assert/strict";
import {
  CARD_LIMITS,
  cardFallback,
  cardInput,
} from "../../server/features/assistants/agent-card-schema.js";
import { agentCards } from "../../server/lib/i18n/en/agent-cards.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";

const plan = {
  title: "Dinners week 46",
  blocks: [
    { type: "heading", text: "Plan" },
    {
      type: "table",
      columns: ["Day", "Dish"],
      rows: [
        { cells: ["Mon", "Chicken"], action: { label: "Swap" } },
        { cells: ["Tue", 42] },
      ],
    },
    {
      type: "checklist",
      title: "Shopping",
      items: [
        { id: "milk", text: "Milk" },
        { id: "rice", text: "Rice", checked: true },
      ],
    },
    {
      type: "actions",
      items: [{ label: "Recipes", message: "Recipes please", primary: true }],
    },
  ],
};

const rejected = (input, pattern) =>
  assert.throws(
    () => cardInput(input),
    (error) => error.code === "CARD_INVALID" && pattern.test(error.message),
  );

test("a card is checked and normalised, with checklist ids and ticks", () => {
  const card = cardInput(plan);
  assert.equal(card.title, "Dinners week 46");
  assert.deepEqual(card.blocks[1].rows[1].cells, ["Tue", "42"]);
  assert.deepEqual(card.blocks[2], {
    type: "checklist",
    id: "checklist",
    title: "Shopping",
    items: [
      { id: "milk", text: "Milk", checked: false },
      { id: "rice", text: "Rice", checked: true },
    ],
  });
  assert.deepEqual(card.blocks[3].items, [
    { label: "Recipes", message: "Recipes please", primary: true },
  ]);
});

test("every block type is accepted", () => {
  const card = cardInput({
    title: "Status",
    blocks: [
      { type: "text", text: "All fine", muted: true },
      { type: "metrics", items: [{ label: "Hosts ok", value: 11, tone: "ok" }] },
      {
        type: "chart",
        kind: "bar",
        label: "Load",
        unit: "%",
        points: [
          { label: "00:00", value: 20 },
          { label: "06:00", value: 55.5 },
        ],
      },
      {
        type: "status",
        items: [{ label: "mimir", state: "warn", detail: "Link down 23:32" }],
      },
      { type: "links", items: [{ label: "Zabbix", url: "https://zabbix.example/" }] },
    ],
  });
  assert.equal(card.blocks.length, 5);
  assert.equal(card.blocks[1].items[0].value, "11");
  assert.equal(
    cardInput({
      title: "x",
      blocks: [{ type: "chart", points: [{ label: "a", value: 1 }] }],
    }).blocks[0].kind,
    "line",
  );
});

test("an update keeps the person's ticks where the agent leaves them out", () => {
  const before = cardInput(plan);
  before.blocks[2].items[0].checked = true;
  const after = cardInput(
    {
      ...plan,
      blocks: [
        {
          type: "checklist",
          title: "Shopping",
          items: [
            { id: "milk", text: "Milk (2 l)" },
            { id: "rice", text: "Rice", checked: false },
            { id: "eggs", text: "Eggs" },
          ],
        },
      ],
    },
    before,
  );
  assert.deepEqual(
    after.blocks[0].items.map((item) => item.checked),
    [true, false, false],
  );
});

test("unknown blocks, keys, unsafe links and limits are refused with the path", () => {
  rejected({ title: "x", blocks: [{ type: "html", html: "<b>" }] }, /blocks\[0\]\.type/);
  rejected(
    { title: "x", blocks: [{ type: "text", text: "a", style: "x" }] },
    /blocks\[0\]\.style/,
  );
  rejected(
    {
      title: "x",
      blocks: [{ type: "links", items: [{ label: "a", url: "javascript:alert(1)" }] }],
    },
    /blocks\[0\]\.items\[0\]\.url/,
  );
  rejected(
    {
      title: "x",
      blocks: Array.from({ length: 21 }, () => ({ type: "heading", text: "h" })),
    },
    /blocks: at most 20/,
  );
  rejected(
    {
      title: "x",
      blocks: [
        {
          type: "table",
          rows: Array.from({ length: CARD_LIMITS.rows + 1 }, () => ({ cells: ["a"] })),
        },
      ],
    },
    /rows: at most 50/,
  );
  rejected(
    {
      title: "x",
      blocks: [{ type: "table", columns: ["a"], rows: [{ cells: ["a", "b"] }] }],
    },
    /cells: at most 1/,
  );
  rejected(
    {
      title: "x",
      blocks: [
        {
          type: "chart",
          points: Array.from({ length: 201 }, (_, i) => ({ label: `${i}`, value: i })),
        },
      ],
    },
    /points: at most 200/,
  );
  rejected(
    {
      title: "x",
      blocks: [
        {
          type: "checklist",
          items: [
            { id: "a", text: "a" },
            { id: "a", text: "b" },
          ],
        },
      ],
    },
    /used twice/,
  );
  rejected({ title: "", blocks: [] }, /title/);
  assert.throws(
    () =>
      cardInput({
        title: "x",
        blocks: Array.from({ length: 20 }, () => ({
          type: "text",
          text: "y".repeat(2000),
        })),
      }),
    (error) => error.code === "CARD_TOO_LARGE" && error.status === 413,
  );
});

test("the model reads card problems in English with the failing part", () => {
  let error;
  try {
    cardInput({ title: "x", blocks: [{ type: "html" }] });
  } catch (e) {
    error = e;
  }
  const result = toolError(error);
  assert.equal(result.code, "CARD_INVALID");
  assert.match(
    result.reason,
    /^The card was rejected \(blocks\[0\]\.type: must be one of/,
  );
});

test("the Telegram fallback lists the title and each block in short", () => {
  const text = cardFallback(cardInput(plan), agentCards.telegram);
  assert.equal(
    text,
    [
      "Dinners week 46",
      "",
      "Plan",
      "",
      "Mon · Chicken",
      "Tue · 42",
      "",
      "Shopping",
      "☐ Milk",
      "☑ Rice",
      "",
      "Open the chat in AgentPier to use this card.",
    ].join("\n"),
  );
});
