import React from "react";
import Segment from "../../components/Segment.jsx";
import { mcpPackageCopy } from "../../lib/i18n/messages/mcp-packages.js";
import { keepPackageValues } from "./mcp-server-draft.js";

/**
 * Own command or package. A new or own-command server chooses (switching an existing
 * one installs the package, D1); a packaged server can switch back to an own command,
 * which removes its package on save.
 */
export default function SourceField({ server, values, set }) {
  const copy = mcpPackageCopy;
  if (!server?.source)
    return (
      <div className="mcp-field">
        <span aria-hidden="true">{copy.sourceLabel}</span>
        <Segment
          label={copy.sourceLabel}
          value={values.source}
          onChange={set("source")}
          options={["command", "package"].map((value) => ({
            value,
            label: copy.sources[value],
          }))}
        />
      </div>
    );
  const detaching = values.source !== "package";
  return (
    <div className="mcp-field">
      <span>{copy.sourceLabel}</span>
      <div className="mcp-source">
        <span className="mcp-hint">
          {copy.sources[detaching ? "command" : "package"]}
        </span>
        <button
          type="button"
          className="button secondary"
          onClick={() => {
            if (!detaching) return set("source")("command");
            // Keep package: back to exactly what is stored, so nothing is left to save.
            for (const [key, value] of Object.entries(keepPackageValues(server)))
              set(key)(value);
          }}
        >
          {detaching ? copy.keepPackage : copy.useOwnCommand}
        </button>
      </div>
      {detaching && <p className="mcp-warning">{copy.detachHint}</p>}
    </div>
  );
}
