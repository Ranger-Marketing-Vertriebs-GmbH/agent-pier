// agentpier_card (agent-cards.js). The limits match CARD_LIMITS in agent-card-schema.js,
// which checks every block again.
const text = (maxLength) => ({ type: "string", minLength: 1, maxLength });
const button = {
  type: "object",
  properties: { label: text(80), message: text(500), primary: { type: "boolean" } },
  required: ["label"],
  additionalProperties: false,
};
const items = (properties, required, maxItems) => ({
  type: "array",
  minItems: 1,
  maxItems,
  items: { type: "object", properties, required, additionalProperties: false },
});
const block = {
  type: "object",
  properties: {
    type: {
      type: "string",
      enum: [
        "heading",
        "text",
        "metrics",
        "table",
        "chart",
        "checklist",
        "status",
        "links",
        "actions",
      ],
    },
    text: text(2000),
    muted: { type: "boolean" },
    id: { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,64}$" },
    title: text(120),
    columns: { type: "array", minItems: 1, maxItems: 8, items: text(80) },
    rows: items(
      {
        cells: { type: "array", minItems: 1, maxItems: 8, items: text(200) },
        action: button,
      },
      ["cells"],
      50,
    ),
    kind: { type: "string", enum: ["line", "bar"] },
    label: text(120),
    unit: text(16),
    points: items(
      { label: text(40), value: { type: "number" } },
      ["label", "value"],
      200,
    ),
    items: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: {
        type: "object",
        description:
          "metrics: label, value, tone (ok|warn|fail); checklist: id, text, checked; status: label, state (ok|warn|fail|unknown), detail; links: label, url; actions: label, message, primary",
      },
    },
  },
  required: ["type"],
  additionalProperties: false,
};

export const cardDefinition = {
  card: {
    description:
      "Show an interactive card in this chat instead of a long text: a weekly plan to tick off, a status board, a short report. AgentPier draws it from blocks; no HTML or scripts. Actions: create (title, blocks) returns a cardId; update (cardId, blocks, optional title) replaces the card's blocks with a new version and moves the card to the end of the chat (use it after a button message or for a refresh instead of a new card); read (cardId) returns a card with the person's ticks, read without cardId lists this chat's cards. Blocks: heading {text}; text {text, muted}; metrics {items: label, value, tone ok|warn|fail; at most 8}; table {columns, rows: cells, action: a button for that row}; chart {kind line|bar, label, unit, points: label, value; at most 200}; checklist {id, title, items: id, text, checked}; status {items: label, state ok|warn|fail|unknown, detail}; links {items: label, http(s) url}; actions {items: label, message, primary; at most 8 buttons}. At most 20 blocks, 50 rows or items per block, 32 KB per card. Ticks are saved silently and reach you as a card note with the person's next message; pressing a button sends its message (else its label, plus the row's cells for a row's button) as the person's message and starts a turn. Give checklist items stable ids: an update that leaves out `checked` keeps the person's tick. Cards stay in this chat only; on Telegram the person gets a short text version when you create one.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "update", "read"] },
        cardId: { type: "string", minLength: 1, maxLength: 100 },
        title: text(120),
        blocks: { type: "array", minItems: 1, maxItems: 20, items: block },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
};
