import React from "react";
import { operationsCopy as copy } from "../../lib/i18n/messages/operations.js";

export const isPrerelease = (version) =>
  typeof version === "string" && version.includes("-");

// Marks release candidates wherever a version can be installed or activated.
export default function PrereleaseBadge({ version }) {
  return isPrerelease(version) ? (
    <>
      {" "}
      <span className="badge release-badge">{copy.prerelease}</span>
    </>
  ) : null;
}
