import React, { useMemo } from "react";
import { chatMessageCopy as copy } from "../../lib/i18n/messages/chat.js";
import { highlightNodes } from "./ToolCode.jsx";

// Split highlighted trees into lines without losing multiline token state.
function tokenLines(text, language) {
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
export default function ToolDiffCode({ rows, language }) {
  const highlighted = useMemo(() => {
    const result = new Map();
    // Hunk separators reset lexical context; old and new sides are tokenized separately.
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
        const tokens = tokenLines(
          selected.map(({ row }) => row.text).join("\n"),
          language,
        );
        selected.forEach(({ index }, i) => result.set(index, tokens[i]));
      }
      start = end;
    }
    return result;
  }, [rows, language]);
  const coordinates = rows.some(
    (row) => row.oldLine !== undefined || row.newLine !== undefined,
  );
  return rows.map((row, index) => (
    <div className={`tool-diff-row is-${row.kind}`} key={index}>
      {coordinates && (
        <>
          <span className="tool-diff-number" aria-hidden="true">
            {row.oldLine ?? ""}
          </span>
          <span className="tool-diff-number" aria-hidden="true">
            {row.newLine ?? ""}
          </span>
        </>
      )}
      <span className="tool-diff-marker">
        {{ add: "+", remove: "−", context: " ", meta: " " }[row.kind]}
      </span>
      <code>
        {row.annotation
          ? copy[row.annotation]
          : highlighted.get(index)?.map((token, i) => (
              <span key={i} className={token.classes.join(" ")}>
                {token.value}
              </span>
            )) || row.text}
        {row.text ? "" : "\u200b"}
      </code>
    </div>
  ));
}
