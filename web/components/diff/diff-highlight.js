import { highlightNodes } from "../code-highlight.js";

// Split highlighted trees into lines without losing multiline token state.
export function tokenLines(text, language) {
  const lines = [[]];
  function walk(nodes, classes = []) {
    for (const node of nodes) {
      if (node.type !== "text") {
        walk(node.children || [], [...classes, ...(node.properties?.className || [])]);
        continue;
      }
      node.value.split("\n").forEach((value, index) => {
        if (index) lines.push([]);
        if (value) lines.at(-1).push({ value, classes });
      });
    }
  }
  walk(highlightNodes(text, language));
  return lines;
}

// Hunk separators reset lexical context; old and new sides are tokenized separately.
export function highlightRows(rows, language) {
  const result = new Map();
  let start = 0;
  while (start < rows.length) {
    if (rows[start].kind === "meta") {
      start++;
      continue;
    }
    let end = start;
    while (end < rows.length && rows[end].kind !== "meta") end++;
    for (const side of ["old", "new"]) {
      const selected = rows
        .slice(start, end)
        .map((row, i) => ({ row, index: start + i }))
        .filter(({ row }) => row.kind !== (side === "old" ? "add" : "remove"));
      const tokens = tokenLines(selected.map(({ row }) => row.text).join("\n"), language);
      selected.forEach(({ index }, i) => result.set(index, tokens[i]));
    }
    start = end;
  }
  return result;
}
