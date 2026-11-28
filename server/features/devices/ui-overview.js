import { coordinate } from "./device-input.js";

/*
 * The UI overview of a device: what `uiautomator dump` prints, as a short numbered
 * list an agent can read and tap by number.
 *
 * The dump is one `<hierarchy>` of nested `<node …>` tags whose attributes carry
 * everything (text, content-desc, class, bounds, clickable, …). An attribute is in
 * double quotes, or in single quotes when its value contains a double quote; `<`,
 * `>`, `&` and the quote in use are entities. uiautomator leaves out what is not
 * visible to the user by itself.
 *
 * Kept is every node that says something (text, description, hint) or that can be
 * acted on (clickable, long-clickable, scrollable, checkable, an input field,
 * focused); bare layout containers and nodes without an area on the screen are
 * dropped. The list is bounded in entries and bytes and says when it was cut.
 *
 * The dump is what the device and its apps say, so nothing of it is passed on as it
 * is: every text, id, class and the package is one line of bounded length, and an
 * element whose bounds are not coordinates a tap may name (negative, beyond 10000,
 * no number at all) is dropped like one without an area. uiautomator itself cuts the
 * bounds of a real element to the visible screen.
 */
export const OVERVIEW_LIMITS = Object.freeze({
  entries: 150,
  bytes: 16000,
  text: 120,
  name: 60,
  package: 200,
});

const entities = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const unescape = (value) =>
  value.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(\w+));/g, (whole, decimal, hex, name) => {
    if (name) return entities[name] ?? whole;
    const point = decimal ? Number(decimal) : parseInt(hex, 16);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
  });

/** The attributes of every `<node>` of `xml`, in document order. */
export function dumpNodes(xml) {
  const nodes = [];
  const tag = /<node\b((?:\s+[\w:-]+=(?:"[^"]*"|'[^']*'))*)\s*\/?>/g;
  for (const [, body] of String(xml).matchAll(tag)) {
    const node = {};
    for (const [, name, double, single] of body.matchAll(
      /([\w:-]+)=(?:"([^"]*)"|'([^']*)')/g,
    ))
      node[name] = unescape(double ?? single);
    nodes.push(node);
  }
  return nodes;
}

const yes = (node, name) => node[name] === "true";
// One line of text: whitespace runs as one space, cut with an ellipsis.
function line(value, max = OVERVIEW_LIMITS.text) {
  const flat = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
const box = (node) => {
  const found = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(node.bounds || "");
  return found ? found.slice(1).map(Number) : null;
};
// `android.widget.Button` -> `Button`; an inner class keeps its own name.
const shortClass = (name) =>
  String(name || "View")
    .split(".")
    .at(-1)
    .split("$")
    .at(-1) || "View";
const editable = (node) => /EditText$|AutoCompleteTextView$/.test(node.class || "");

function flags(node) {
  return [
    yes(node, "clickable") && "clickable",
    yes(node, "long-clickable") && "long-clickable",
    yes(node, "scrollable") && "scrollable",
    editable(node) && "editable",
    yes(node, "checkable") && (yes(node, "checked") ? "checked" : "unchecked"),
    yes(node, "selected") && "selected",
    yes(node, "focused") && "focused",
    yes(node, "password") && "password",
    node.enabled === "false" && "disabled",
  ].filter(Boolean);
}
const kept = (node) =>
  !!(node.text || node["content-desc"] || node.hint) ||
  editable(node) ||
  ["clickable", "long-clickable", "scrollable", "checkable", "focused"].some((name) =>
    yes(node, name),
  );

/**
 * The overview of the dump `xml`, or null when it holds no hierarchy:
 *
 * - `elements`: the lines, `<n> <Type>[#id] "<text>" [desc="…"] [hint="…"]
 *   [left,top][right,bottom] <flags>`
 * - `targets`: `[{ n, x, y }]`, the centre of each listed element, for a tap
 * - `package` of the window in front, `total` elements found, `shown`, and
 *   `truncated` with a `note` when the list was cut
 */
export function overview(xml, given = OVERVIEW_LIMITS) {
  const limits = { ...OVERVIEW_LIMITS, ...given };
  const source = String(xml ?? "");
  if (!/<hierarchy\b/.test(source)) return null;
  const nodes = dumpNodes(source);
  const elements = [];
  const targets = [];
  let total = 0,
    size = 0,
    truncated = false;
  for (const node of nodes) {
    const bounds = box(node);
    if (!bounds || !kept(node)) continue;
    const [left, top, right, bottom] = bounds;
    if (right <= left || bottom <= top || !bounds.every(coordinate)) continue;
    total++;
    if (truncated) continue;
    const n = elements.length + 1;
    const id = (node["resource-id"] || "").split("/").at(-1);
    const text = line(node.text);
    const description = line(node["content-desc"]);
    const entry = [
      `${n} ${line(shortClass(node.class), limits.name) || "View"}${id ? `#${line(id, limits.name)}` : ""}`,
      text && JSON.stringify(text),
      description && description !== text && `desc=${JSON.stringify(description)}`,
      node.hint && !text && `hint=${JSON.stringify(line(node.hint))}`,
      `[${left},${top}][${right},${bottom}]`,
      ...flags(node),
    ]
      .filter(Boolean)
      .join(" ");
    const bytes = Buffer.byteLength(entry) + 1;
    if (elements.length >= limits.entries || size + bytes > limits.bytes) {
      truncated = true;
      continue;
    }
    size += bytes;
    elements.push(entry);
    targets.push({
      n,
      x: Math.round((left + right) / 2),
      y: Math.round((top + bottom) / 2),
    });
  }
  return {
    package: line(nodes[0]?.package, limits.package) || null,
    elements,
    targets,
    shown: elements.length,
    total,
    truncated,
    ...(truncated && {
      note: `Showing the first ${elements.length} of ${total} elements. Scroll, or narrow the screen down, to see the rest.`,
    }),
  };
}
