export const MIN_RATIO = 0.15;
export const MAX_RATIO = 0.85;
/** Fraction of a pane's width or height, measured from an edge, that selects that edge. */
export const EDGE_ZONE = 0.28;

const isSplit = (node) => node?.type === "split";

export const clampRatio = (ratio) => Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));

const FULL = { x: 0, y: 0, width: 1, height: 1 };

function childBoxes(node, box) {
  if (node.dir === "row") {
    const left = box.width * node.ratio;
    return [
      { ...box, width: left },
      { ...box, x: box.x + left, width: box.width - left },
    ];
  }
  const top = box.height * node.ratio;
  return [
    { ...box, height: top },
    { ...box, y: box.y + top, height: box.height - top },
  ];
}

/** The leaves of a tree as rectangles in fractions of the stage, `a` before `b`. */
export function paneRects(node, keyOf) {
  const out = [];
  const walk = (current, box, path) => {
    if (!isSplit(current)) {
      out.push({ key: keyOf(current), leaf: current, path, ...box });
      return;
    }
    const [boxA, boxB] = childBoxes(current, box);
    walk(current.a, boxA, [...path, "a"]);
    walk(current.b, boxB, [...path, "b"]);
  };
  walk(node, FULL, []);
  return out;
}

/** The dividers of a tree in pre-order; `box` is the split node's own rectangle. */
export function dividerRects(node) {
  const out = [];
  const walk = (current, box, path) => {
    if (!isSplit(current)) return;
    const row = current.dir === "row";
    out.push({
      path,
      dir: current.dir,
      ratio: current.ratio,
      box,
      x: row ? box.x + box.width * current.ratio : box.x,
      y: row ? box.y : box.y + box.height * current.ratio,
      width: row ? 0 : box.width,
      height: row ? box.height : 0,
    });
    const [boxA, boxB] = childBoxes(current, box);
    walk(current.a, boxA, [...path, "a"]);
    walk(current.b, boxB, [...path, "b"]);
  };
  walk(node, FULL, []);
  return out;
}

/** The smallest pixel size a tree needs so that every pane keeps `minPane`; `gap` is the divider thickness. */
export function minSize(node, minPane, gap = 0) {
  if (!isSplit(node)) return { width: minPane.width, height: minPane.height };
  const a = minSize(node.a, minPane, gap),
    b = minSize(node.b, minPane, gap);
  return node.dir === "row"
    ? { width: a.width + gap + b.width, height: Math.max(a.height, b.height) }
    : { width: Math.max(a.width, b.width), height: a.height + gap + b.height };
}

/** The ratio range of a split in a container of `size` that keeps both sides usable. */
export function ratioBounds(node, size, minPane, gap = 0) {
  const row = node.dir === "row";
  const key = row ? "width" : "height";
  const ma = minSize(node.a, minPane, gap)[key],
    mb = minSize(node.b, minPane, gap)[key];
  const total = size[key] - gap;
  if (total <= 0 || ma + mb > total) {
    const ratio = clampRatio(ma / (ma + mb));
    return { min: ratio, max: ratio };
  }
  return {
    min: Math.max(MIN_RATIO, ma / total),
    max: Math.min(MAX_RATIO, 1 - mb / total),
  };
}

export function fits(node, size, minPane, gap = 0) {
  const need = minSize(node, minPane, gap);
  return need.width <= size.width && need.height <= size.height;
}

/** The drop zone under a point: the nearest edge when within `EDGE_ZONE`, else the centre. */
export function sideAt(rect, x, y) {
  const distances = [
    ["left", (x - rect.left) / rect.width],
    ["right", (rect.left + rect.width - x) / rect.width],
    ["top", (y - rect.top) / rect.height],
    ["bottom", (rect.top + rect.height - y) / rect.height],
  ];
  let best = distances[0];
  for (const entry of distances) if (entry[1] < best[1]) best = entry;
  return best[1] < EDGE_ZONE ? best[0] : "center";
}

/** Half of the rect for an edge, the rect itself for the centre. */
export function zoneRect(rect, side) {
  const { left, top, width, height } = rect;
  if (side === "left") return { left, top, width: width / 2, height };
  if (side === "right") return { left: left + width / 2, top, width: width / 2, height };
  if (side === "top") return { left, top, width, height: height / 2 };
  if (side === "bottom")
    return { left, top: top + height / 2, width, height: height / 2 };
  return { left, top, width, height };
}
