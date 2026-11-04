import React, { useMemo } from "react";
import { diffReviewCopy as copy } from "../../lib/i18n/messages/diff-review.js";
import { highlightRows } from "./diff-highlight.js";
import "./diff.css";

const markers = { add: "+", remove: "−", context: " ", meta: " " };

// Read-only unless `onSelect` is given; `renderAfter(index)` adds content below a row.
export default function DiffRows({
  rows,
  language,
  selected = null,
  onSelect,
  renderAfter,
}) {
  const highlighted = useMemo(() => highlightRows(rows, language), [rows, language]);
  const coordinates = rows.some(
    (row) => row.oldLine !== undefined || row.newLine !== undefined,
  );
  return rows.map((row, index) => (
    <React.Fragment key={index}>
      <div
        className={`diff-row is-${row.kind}${selected === index ? " is-selected" : ""}`}
        onClick={onSelect ? () => onSelect(index) : undefined}
      >
        {coordinates && (
          <>
            <span className="diff-number" aria-hidden="true">
              {row.oldLine ?? ""}
            </span>
            <span className="diff-number" aria-hidden="true">
              {row.newLine ?? ""}
            </span>
          </>
        )}
        <span className="diff-marker">{markers[row.kind]}</span>
        <code>
          {row.annotation
            ? copy[row.annotation]
            : highlighted.get(index)?.map((token, i) => (
                <span key={i} className={token.classes.join(" ")}>
                  {token.value}
                </span>
              )) || row.text}
          {row.text ? "" : "​"}
        </code>
      </div>
      {renderAfter?.(index)}
    </React.Fragment>
  ));
}
