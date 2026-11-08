import React from "react";
import CheckRow from "../../components/CheckRow.jsx";
import { formatBytes } from "../../lib/format-bytes.js";
import { locale } from "../../lib/i18n/index.js";
import { reaCopy as copy } from "../../lib/i18n/messages/rea.js";
import { serverText } from "../../lib/server-messages.js";

// The parts the REA and Craft Anything dialogs share: component sizes and versions,
// the Ghidra row both tools install, the total and the job status.

const bytes = (value) => formatBytes(value, locale);

/** "Installed: 6.7.0 · Available: 6.8.0", or the pinned version before an install. */
export function versionLine(installed, version, pinned) {
  if (!installed || !version) return copy.version(pinned);
  return version === pinned
    ? copy.installedVersion(version)
    : `${copy.installedVersion(version)} · ${copy.availableVersion(pinned)}`;
}

export function Sizes({ part }) {
  return part.downloadSize != null && part.installedSize != null ? (
    <span className="check-row-meta">
      {copy.sizes(bytes(part.downloadSize), bytes(part.installedSize))}
    </span>
  ) : null;
}

/** Why this host lacks `part`, as a warning line of its row. */
export function Unavailable({ part }) {
  return part.available ? null : (
    <span className="check-row-subtitle rea-reason">
      {serverText(part.reason, part.reasonKey, part.reasonArgs)}
    </span>
  );
}

/**
 * Ghidra with its JDK as a check row: the versions, the reason when this host has none,
 * the sizes and, when `ghidra.shared`, that the tool named `sharedWith` keeps it too.
 */
export function GhidraRow({ ghidra, checked, disabled, onChange, sharedWith }) {
  return (
    <CheckRow
      title={copy.ghidra}
      subtitle={copy.ghidraDescription}
      checked={ghidra.available && checked}
      disabled={disabled || !ghidra.available}
      onChange={(event) => onChange(event.target.checked)}
    >
      <span className="check-row-subtitle">
        {ghidra.installed && ghidra.version
          ? copy.installedVersion(copy.ghidraVersion(ghidra.version, ghidra.jdkVersion))
          : copy.ghidraVersion(ghidra.pinnedVersion, ghidra.jdkPinnedVersion)}
      </span>
      {ghidra.shared && (
        <span className="check-row-subtitle">{copy.ghidraShared(sharedWith)}</span>
      )}
      <Unavailable part={ghidra} />
      <Sizes part={ghidra} />
    </CheckRow>
  );
}

/** "Total: download …, installed …" of the ticked `parts`. */
export function PartsTotal({ parts }) {
  const sum = (key) => parts.reduce((total, part) => total + (part[key] ?? 0), 0);
  return (
    <p className="rea-total" aria-live="polite">
      {copy.total(bytes(sum("downloadSize")), bytes(sum("installedSize")))}
    </p>
  );
}

/** A tool's job status: running, failed or done, its message and the background note. */
export function ToolStatus({ state, labels }) {
  const label = labels[state.status];
  const message = serverText(state.message, state.messageKey, state.messageArgs);
  if (!label && !message) return null;
  return (
    <div className={`rea-status ${state.status}`} role="status" aria-live="polite">
      {label && <strong>{label}</strong>}
      {message && <p>{message}</p>}
      {state.status === "running" && <p className="dialog-hint">{labels.background}</p>}
    </div>
  );
}
