import React from "react";
import "./skill-list.css";

/**
 * What a list row says under its label: the description cut after two lines and an
 * optional short `note` below it (a source, a version, a finding). The whole
 * description belongs in the row's detail view.
 */
export default function RowSummary({ description, note }) {
  return (
    <>
      {description && <span className="skill-row-description">{description}</span>}
      {note && <span className="skill-row-note">{note}</span>}
    </>
  );
}
