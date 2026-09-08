import React from "react";
import { backupCopy as copy } from "../../lib/i18n/messages/operations.js";
export function backupDescription(value) {
  return typeof value === "string"
    ? copy.descriptions[value] || value
    : JSON.stringify(value);
}
export default function BackupContents({ values = [] }) {
  return (
    <ul className="operations-list">
      {values.map((item, index) => (
        <li key={index}>{backupDescription(item)}</li>
      ))}
    </ul>
  );
}
