import React from "react";

// Lines under a row label (description, scope · state, path); empty lines are left out.
// Elements passed in `lines` carry a key anyway (react-x/no-missing-key checks array
// literals); the wrapping spans are keyed by position.
export default function RowLines({ lines }) {
  return lines
    .filter(
      (line) => line !== null && line !== undefined && line !== false && line !== "",
    )
    .map((line, index) => (
      <span key={index} className="row-line">
        {line}
      </span>
    ));
}
