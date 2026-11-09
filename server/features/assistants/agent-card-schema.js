// The closed block set of agent cards (agentpier_card, agent-cards.js). An agent
// never sends markup or scripts: AgentPier checks each block here and renders it
// itself (web/features/assistants/cards/). The limits keep a card small enough for a
// phone and for the chat's live feed.
import { serverMessages } from "../../lib/i18n/de.js";

export const CARD_LIMITS = Object.freeze({
  blocks: 20,
  rows: 50,
  columns: 8,
  metrics: 8,
  buttons: 8,
  links: 20,
  points: 200,
  bytes: 32768,
  openCards: 30,
  placements: 50,
  title: 120,
  text: 2000,
  label: 80,
  value: 40,
  cell: 200,
  message: 500,
  url: 2048,
  id: 64,
});
const L = CARD_LIMITS;

/** An error with a stable CARD_* code and the catalog message (tool-errors.js). */
export function cardError(code, status = 400, ...args) {
  const message = serverMessages.agentCards[code];
  return Object.assign(
    new Error(typeof message === "function" ? message(...args) : message || code),
    { code, status },
  );
}

const fail = (path, what) => {
  throw cardError("CARD_INVALID", 400, `${path}: ${what}`);
};
const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const idPattern = /^[A-Za-z0-9_.:-]{1,64}$/;

function only(value, path, keys) {
  if (!record(value)) fail(path, "must be an object");
  for (const key of Object.keys(value))
    if (!keys.includes(key)) fail(`${path}.${key}`, "is not allowed");
}
function text(value, path, max, { optional = false, numbers = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (numbers && typeof value === "number" && Number.isFinite(value))
    value = String(value);
  if (typeof value !== "string" || !value.trim()) fail(path, "must be a non-empty text");
  if (value.length > max) fail(path, `at most ${max} characters`);
  if (/[\0-\x08\x0b\x0c\x0e-\x1f]/.test(value))
    fail(path, "must not hold control characters");
  return value.trim();
}
function list(value, path, max, min = 1) {
  if (!Array.isArray(value)) fail(path, "must be a list");
  if (value.length < min) fail(path, `needs at least ${min} entry`);
  if (value.length > max) fail(path, `at most ${max} entries`);
  return value;
}
function oneOf(value, path, values, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!values.includes(value)) fail(path, `must be one of ${values.join(", ")}`);
  return value;
}
function id(value, path) {
  if (typeof value !== "string" || !idPattern.test(value))
    fail(path, "must be 1 to 64 letters, digits or _.:-");
  return value;
}
function button(value, path) {
  only(value, path, ["label", "message", "primary"]);
  if (value.primary !== undefined && typeof value.primary !== "boolean")
    fail(`${path}.primary`, "must be true or false");
  return {
    label: text(value.label, `${path}.label`, L.label),
    ...(value.message !== undefined && {
      message: text(value.message, `${path}.message`, L.message),
    }),
    ...(value.primary && { primary: true }),
  };
}
const tones = ["ok", "warn", "fail"];
const states = ["ok", "warn", "fail", "unknown"];

const blocks = {
  heading: (b, p) => {
    only(b, p, ["type", "text"]);
    return { type: "heading", text: text(b.text, `${p}.text`, L.title) };
  },
  text: (b, p) => {
    only(b, p, ["type", "text", "muted"]);
    return {
      type: "text",
      text: text(b.text, `${p}.text`, L.text),
      ...(b.muted === true && { muted: true }),
    };
  },
  metrics: (b, p) => {
    only(b, p, ["type", "items"]);
    return {
      type: "metrics",
      items: list(b.items, `${p}.items`, L.metrics).map((item, i) => {
        const q = `${p}.items[${i}]`;
        only(item, q, ["label", "value", "tone"]);
        return {
          label: text(item.label, `${q}.label`, L.label),
          value: text(item.value, `${q}.value`, L.value, { numbers: true }),
          ...(item.tone !== undefined && { tone: oneOf(item.tone, `${q}.tone`, tones) }),
        };
      }),
    };
  },
  table: (b, p) => {
    only(b, p, ["type", "columns", "rows"]);
    const columns =
      b.columns === undefined
        ? undefined
        : list(b.columns, `${p}.columns`, L.columns).map((c, i) =>
            text(c, `${p}.columns[${i}]`, L.label),
          );
    return {
      type: "table",
      ...(columns && { columns }),
      rows: list(b.rows, `${p}.rows`, L.rows).map((row, i) => {
        const q = `${p}.rows[${i}]`;
        only(row, q, ["cells", "action"]);
        const cells = list(row.cells, `${q}.cells`, columns?.length ?? L.columns).map(
          (c, j) => text(c, `${q}.cells[${j}]`, L.cell, { numbers: true }),
        );
        return {
          cells,
          ...(row.action !== undefined && { action: button(row.action, `${q}.action`) }),
        };
      }),
    };
  },
  chart: (b, p) => {
    only(b, p, ["type", "kind", "label", "unit", "points"]);
    return {
      type: "chart",
      kind: oneOf(b.kind, `${p}.kind`, ["line", "bar"], "line"),
      ...(b.label !== undefined && { label: text(b.label, `${p}.label`, L.title) }),
      ...(b.unit !== undefined && { unit: text(b.unit, `${p}.unit`, 16) }),
      points: list(b.points, `${p}.points`, L.points).map((point, i) => {
        const q = `${p}.points[${i}]`;
        only(point, q, ["label", "value"]);
        if (typeof point.value !== "number" || !Number.isFinite(point.value))
          fail(`${q}.value`, "must be a number");
        return { label: text(point.label, `${q}.label`, L.value), value: point.value };
      }),
    };
  },
  checklist: (b, p) => {
    only(b, p, ["type", "id", "title", "items"]);
    const ids = new Set();
    return {
      type: "checklist",
      ...(b.id !== undefined && { id: id(b.id, `${p}.id`) }),
      ...(b.title !== undefined && { title: text(b.title, `${p}.title`, L.title) }),
      items: list(b.items, `${p}.items`, L.rows).map((item, i) => {
        const q = `${p}.items[${i}]`;
        only(item, q, ["id", "text", "checked"]);
        const itemId = item.id === undefined ? `item-${i + 1}` : id(item.id, `${q}.id`);
        if (ids.has(itemId)) fail(`${q}.id`, "is used twice in this checklist");
        ids.add(itemId);
        if (item.checked !== undefined && typeof item.checked !== "boolean")
          fail(`${q}.checked`, "must be true or false");
        return {
          id: itemId,
          text: text(item.text, `${q}.text`, L.cell),
          ...(item.checked !== undefined && { checked: item.checked }),
        };
      }),
    };
  },
  status: (b, p) => {
    only(b, p, ["type", "items"]);
    return {
      type: "status",
      items: list(b.items, `${p}.items`, L.rows).map((item, i) => {
        const q = `${p}.items[${i}]`;
        only(item, q, ["label", "state", "detail"]);
        return {
          label: text(item.label, `${q}.label`, L.label),
          state: oneOf(item.state, `${q}.state`, states),
          ...(item.detail !== undefined && {
            detail: text(item.detail, `${q}.detail`, L.cell),
          }),
        };
      }),
    };
  },
  links: (b, p) => {
    only(b, p, ["type", "items"]);
    return {
      type: "links",
      items: list(b.items, `${p}.items`, L.links).map((item, i) => {
        const q = `${p}.items[${i}]`;
        only(item, q, ["label", "url"]);
        const url = text(item.url, `${q}.url`, L.url);
        let parsed;
        try {
          parsed = new URL(url);
        } catch {
          fail(`${q}.url`, "must be an absolute http or https address");
        }
        if (!["http:", "https:"].includes(parsed.protocol))
          fail(`${q}.url`, "must be an absolute http or https address");
        return { label: text(item.label, `${q}.label`, L.label), url: parsed.href };
      }),
    };
  },
  actions: (b, p) => {
    only(b, p, ["type", "items"]);
    return {
      type: "actions",
      items: list(b.items, `${p}.items`, L.buttons).map((item, i) =>
        button(item, `${p}.items[${i}]`),
      ),
    };
  },
};
export const blockTypes = Object.freeze(Object.keys(blocks));

/**
 * A checked card `{ title, blocks }` from the tool's `title` and `blocks`, or a
 * CARD_INVALID / CARD_TOO_LARGE error naming the part. Each checklist gets an id (its
 * own, else `checklist`, `checklist-2`, … in order) and each item `checked`: as given,
 * else as `previous` (the card before an update) had it for the same checklist and
 * item id, else false. So a person's ticks survive an update that leaves them out.
 */
export function cardInput({ title, blocks: input }, previous = null) {
  const checkedBefore = new Map();
  for (const block of previous?.blocks ?? [])
    if (block.type === "checklist")
      for (const item of block.items)
        checkedBefore.set(`${block.id}\n${item.id}`, item.checked);
  const card = {
    title: text(title, "title", L.title),
    blocks: list(input, "blocks", L.blocks).map((block, i) => {
      const path = `blocks[${i}]`;
      if (!record(block)) fail(path, "must be an object");
      if (!Object.hasOwn(blocks, block.type))
        fail(`${path}.type`, `must be one of ${blockTypes.join(", ")}`);
      return blocks[block.type](block, path);
    }),
  };
  const checklistIds = new Set();
  let unnamed = 0;
  card.blocks.forEach((block, i) => {
    if (block.type !== "checklist") return;
    block.id ??= unnamed++ ? `checklist-${unnamed}` : "checklist";
    if (checklistIds.has(block.id)) fail(`blocks[${i}].id`, "is used twice in this card");
    checklistIds.add(block.id);
    block.items = block.items.map((item) => ({
      ...item,
      checked: item.checked ?? checkedBefore.get(`${block.id}\n${item.id}`) ?? false,
    }));
  });
  const bytes = Buffer.byteLength(JSON.stringify(card));
  if (bytes > L.bytes) throw cardError("CARD_TOO_LARGE", 413, L.bytes);
  return card;
}

const stateMark = { ok: "🟢", warn: "🟡", fail: "🔴", unknown: "⚪" };
const shown = (items, max, line, m) => [
  ...items.slice(0, max).map(line),
  ...(items.length > max ? [m.more(items.length - max)] : []),
];

/**
 * A card as plain text for Telegram: its title and a compact line per block (at most
 * ten rows each), then the hint to open AgentPier. `m` is the channel language's
 * `agentCards.telegram` copy.
 */
export function cardFallback(card, m) {
  const lines = [card.title];
  for (const block of card.blocks) {
    lines.push("");
    if (block.type === "heading") lines.push(block.text);
    else if (block.type === "text") lines.push(block.text);
    else if (block.type === "metrics")
      lines.push(block.items.map((item) => `${item.label}: ${item.value}`).join(" · "));
    else if (block.type === "table")
      lines.push(...shown(block.rows, 10, (row) => row.cells.join(" · "), m));
    else if (block.type === "chart") {
      const last = block.points.at(-1);
      lines.push(
        `${block.label ? `${block.label}: ` : ""}${m.chart(block.points.length)}, ${last.label} ${last.value}${block.unit ? ` ${block.unit}` : ""}`,
      );
    } else if (block.type === "checklist") {
      if (block.title) lines.push(block.title);
      lines.push(
        ...shown(
          block.items,
          10,
          (item) => `${item.checked ? "☑" : "☐"} ${item.text}`,
          m,
        ),
      );
    } else if (block.type === "status")
      lines.push(
        ...shown(
          block.items,
          10,
          (item) =>
            `${stateMark[item.state]} ${item.label}${item.detail ? `: ${item.detail}` : ""}`,
          m,
        ),
      );
    else if (block.type === "links")
      lines.push(...shown(block.items, 10, (item) => `${item.label}: ${item.url}`, m));
    else if (block.type === "actions") lines.pop();
  }
  lines.push("", m.open);
  return lines.join("\n");
}
