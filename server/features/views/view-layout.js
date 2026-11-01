import { serverMessages } from "../../lib/i18n/de.js";

export const MAX_PANES = 6;
export const MAX_VIEWS = 30;
export const MAX_VIEW_NAME = 60;
export const MIN_RATIO = 0.15;
export const MAX_RATIO = 0.85;

const VIEW_CODES = Object.freeze({
  VIEW_INVALID: ["invalidDocument", 400],
  VIEW_NAME_INVALID: ["invalidName", 400],
  VIEW_LAYOUT_INVALID: ["invalidLayout", 400],
  VIEW_TOO_MANY_PANES: ["tooManyPanes", 400],
  VIEW_DUPLICATE_ITEM: ["duplicateItem", 400],
  VIEW_LIMIT: ["tooMany", 400],
  VIEW_UNKNOWN: ["unknownView", 404],
});

/** An error with a stable `code`, its HTTP `status` and the German message of that code. */
export function viewError(code) {
  const [key, status] = VIEW_CODES[code];
  return Object.assign(new Error(serverMessages.views[key]), { code, status });
}

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const TABS = new Set(["terminal", "chat", "files"]);
const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const onlyKeys = (value, keys) => Object.keys(value).every((key) => keys.includes(key));
const validId = (id) => typeof id === "string" && ID.test(id);
const invalid = () => viewError("VIEW_LAYOUT_INVALID");

function checkItem(item) {
  if (!isRecord(item)) throw invalid();
  if (item.kind === "session") {
    if (!onlyKeys(item, ["kind", "id"]) || !validId(item.id)) throw invalid();
    return { kind: "session", id: item.id };
  }
  if (item.kind === "chat") {
    if (
      !onlyKeys(item, ["kind", "assistantId", "conversationId"]) ||
      !validId(item.assistantId) ||
      !validId(item.conversationId)
    )
      throw invalid();
    return {
      kind: "chat",
      assistantId: item.assistantId,
      conversationId: item.conversationId,
    };
  }
  throw invalid();
}

/** The key by which an item may appear only once per view. */
const itemKey = (item) =>
  item.kind === "session"
    ? `session:${item.id}`
    : `chat:${item.assistantId}:${item.conversationId}`;

/**
 * The checked layout as a clean copy: `null`, a pane or a split (see the spec). Throws
 * a `viewError` for a malformed tree, unknown keys, a tab on a chat, a ratio outside
 * 0.15 to 0.85, more than 6 panes or an item that occurs twice.
 */
export function checkLayout(layout) {
  if (layout === null) return null;
  const seen = new Set();
  let panes = 0;
  const walk = (node, depth) => {
    if (!isRecord(node)) throw invalid();
    if (depth > MAX_PANES) throw viewError("VIEW_TOO_MANY_PANES");
    if (node.type === "pane") {
      if (!onlyKeys(node, ["type", "item", "tab"])) throw invalid();
      const item = checkItem(node.item);
      if (++panes > MAX_PANES) throw viewError("VIEW_TOO_MANY_PANES");
      if (seen.has(itemKey(item))) throw viewError("VIEW_DUPLICATE_ITEM");
      seen.add(itemKey(item));
      if (node.tab === undefined) return { type: "pane", item };
      if (item.kind !== "session" || !TABS.has(node.tab)) throw invalid();
      return { type: "pane", item, tab: node.tab };
    }
    if (node.type === "split") {
      if (!onlyKeys(node, ["type", "dir", "ratio", "a", "b"])) throw invalid();
      if (node.dir !== "row" && node.dir !== "col") throw invalid();
      if (
        typeof node.ratio !== "number" ||
        !Number.isFinite(node.ratio) ||
        node.ratio < MIN_RATIO ||
        node.ratio > MAX_RATIO
      )
        throw invalid();
      const a = walk(node.a, depth + 1),
        b = walk(node.b, depth + 1);
      return { type: "split", dir: node.dir, ratio: node.ratio, a, b };
    }
    throw invalid();
  };
  return walk(layout, 0);
}

/** The items of a (checked) layout in reading order. */
export function layoutItems(layout) {
  if (!layout) return [];
  if (layout.type === "pane") return [layout.item];
  return [...layoutItems(layout.a), ...layoutItems(layout.b)];
}

/** A trimmed name of 1 to 60 characters without control characters, else null. */
export function cleanViewName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name && name.length <= MAX_VIEW_NAME && !/[\x00-\x1f\x7f]/.test(name)
    ? name
    : null;
}
