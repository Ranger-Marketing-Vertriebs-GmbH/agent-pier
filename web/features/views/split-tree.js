import { clampRatio } from "../../components/split-geometry.js";

export const MAX_PANES = 6;
export const PANE_HINT_FROM = 5;
export const MIN_PANE = Object.freeze({ width: 280, height: 220 });

const TABS = ["terminal", "chat", "files"];
const isPane = (node) => node?.type === "pane";

export const itemKey = (item) =>
  item.kind === "session"
    ? `session:${item.id}`
    : `chat:${item.assistantId}:${item.conversationId}`;

/**
 * A pane leaf; sessions carry a tab (`tab`, else the item's own, else terminal), chats
 * never do.
 */
export function paneLeaf(item, tab) {
  return item.kind === "session"
    ? {
        type: "pane",
        item: { kind: "session", id: item.id },
        tab: tab ?? item.tab ?? "terminal",
      }
    : {
        type: "pane",
        item: {
          kind: "chat",
          assistantId: item.assistantId,
          conversationId: item.conversationId,
        },
      };
}

/** The panes in reading order. */
export function panes(layout) {
  const out = [];
  const walk = (node, path) => {
    if (!node) return;
    if (isPane(node)) {
      out.push({ key: itemKey(node.item), item: node.item, tab: node.tab, path });
      return;
    }
    walk(node.a, [...path, "a"]);
    walk(node.b, [...path, "b"]);
  };
  walk(layout, []);
  return out;
}

export const paneCount = (layout) => panes(layout).length;
export const findPane = (layout, key) =>
  panes(layout).find((pane) => pane.key === key)?.path ?? null;
export const firstPane = (layout) => panes(layout)[0] ?? null;
export const wouldAdd = (layout, item) => findPane(layout, itemKey(item)) === null;

function nodeAt(layout, path) {
  let node = layout;
  for (const step of path) node = node?.[step];
  return node;
}

/** Replace the node at `path` by `fn(node)`; same reference when `fn` returns the node. */
function updateAt(node, path, fn) {
  if (path.length === 0) return fn(node);
  const [step, ...rest] = path;
  const child = updateAt(node[step], rest, fn);
  return child === node[step] ? node : { ...node, [step]: child };
}

function insertAt(layout, targetKey, side, leaf) {
  const path = findPane(layout, targetKey);
  if (!path) return layout;
  if (side === "center") return updateAt(layout, path, () => leaf);
  const dir = side === "left" || side === "right" ? "row" : "col";
  const before = side === "left" || side === "top";
  return updateAt(layout, path, (target) => ({
    type: "split",
    dir,
    ratio: 0.5,
    a: before ? leaf : target,
    b: before ? target : leaf,
  }));
}

export function splitPane(layout, targetKey, side, leaf) {
  return insertAt(layout, targetKey, side === "center" ? "right" : side, leaf);
}

export function replacePane(layout, targetKey, leaf) {
  return insertAt(layout, targetKey, "center", leaf);
}

/** Remove a pane; its sibling takes the parent's place. `null` when none is left. */
export function removePane(layout, key) {
  const path = findPane(layout, key);
  if (!path) return layout;
  if (path.length === 0) return null;
  const parentPath = path.slice(0, -1);
  const sibling = nodeAt(layout, [...parentPath, path.at(-1) === "a" ? "b" : "a"]);
  return updateAt(layout, parentPath, () => sibling);
}

/** Drop an item on a pane (or onto an empty view). An item already present is moved. */
export function dropItem(layout, item, targetKey, side) {
  if (!layout) return paneLeaf(item);
  const key = itemKey(item);
  if (key === targetKey || findPane(layout, targetKey) === null) return layout;
  if (findPane(layout, key)) return movePane(layout, key, targetKey, side);
  return insertAt(layout, targetKey, side, paneLeaf(item));
}

/** Move a pane next to another one; the centre swaps the two panes. */
export function movePane(layout, fromKey, toKey, side) {
  if (fromKey === toKey) return layout;
  const fromPath = findPane(layout, fromKey),
    toPath = findPane(layout, toKey);
  if (!fromPath || !toPath) return layout;
  const from = nodeAt(layout, fromPath);
  if (side === "center") {
    const to = nodeAt(layout, toPath);
    return updateAt(
      updateAt(layout, fromPath, () => to),
      toPath,
      () => from,
    );
  }
  return insertAt(removePane(layout, fromKey), toKey, side, from);
}

export function setRatio(layout, path, ratio) {
  if (!Number.isFinite(ratio)) return layout;
  const next = clampRatio(ratio);
  return updateAt(layout, path, (node) =>
    node.type === "split" && node.ratio !== next ? { ...node, ratio: next } : node,
  );
}

export function setTab(layout, key, tab) {
  if (!TABS.includes(tab)) return layout;
  const path = findPane(layout, key);
  if (!path) return layout;
  return updateAt(layout, path, (leaf) =>
    leaf.item.kind === "session" && leaf.tab !== tab ? { ...leaf, tab } : leaf,
  );
}

/** Swap the item of a pane; unchanged when the new item is already elsewhere. */
export function replaceItem(layout, key, item) {
  const newKey = itemKey(item);
  if (newKey === key || findPane(layout, key) === null) return layout;
  if (findPane(layout, newKey)) return layout;
  return replacePane(layout, key, paneLeaf(item));
}

/** A fresh two-pane view; a centre drop counts as right; `current` keeps `tab`. */
export function twoPaneLayout(current, dropped, side, tab) {
  return splitPane(paneLeaf(current, tab), itemKey(current), side, paneLeaf(dropped));
}
