import React from "react";
import CheckRow from "../../components/CheckRow.jsx";
import { formatBytes } from "../../lib/format-bytes.js";
import { locale } from "../../lib/i18n/index.js";
import { reaCopy as copy } from "../../lib/i18n/messages/rea.js";
import { serverText } from "../../lib/server-messages.js";

const bytes = (value) => formatBytes(value, locale);

/** "Installed: 6.7.0 · Available: 6.8.0", or the pinned version before an install. */
function versionLine(installed, version, pinned) {
  if (!installed || !version) return copy.version(pinned);
  return version === pinned
    ? copy.installedVersion(version)
    : `${copy.installedVersion(version)} · ${copy.availableVersion(pinned)}`;
}

function Sizes({ part }) {
  return part.downloadSize != null && part.installedSize != null ? (
    <span className="check-row-meta">
      {copy.sizes(bytes(part.downloadSize), bytes(part.installedSize))}
    </span>
  ) : null;
}

/** The parts the owner ticked that this host has, with Core always included. */
function chosenParts(components, chosen) {
  return [
    components.core,
    ...["ghidra", "frida"]
      .filter((id) => chosen[id] && components[id]?.available)
      .map((id) => components[id]),
  ];
}

/**
 * REA's components as check rows: Core (always), Ghidra with its JDK and Frida, each
 * with its version and sizes, an unavailable one disabled with the server's reason,
 * and the total of the ticked rows.
 */
export default function ReaComponents({ components, chosen, onChange, disabled }) {
  const { core, ghidra, frida } = components;
  const parts = chosenParts(components, chosen);
  const sum = (key) => parts.reduce((total, part) => total + (part[key] ?? 0), 0);
  const unavailable = (part) =>
    !part.available && (
      <span className="check-row-subtitle rea-reason">
        {serverText(part.reason, part.reasonKey, part.reasonArgs)}
      </span>
    );
  return (
    <fieldset className="check-list rea-components">
      <legend>{copy.componentsLabel}</legend>
      <CheckRow title={copy.core} subtitle={copy.coreDescription} checked disabled>
        <span className="check-row-subtitle">
          {versionLine(core.installed, core.version, core.pinnedVersion)}
        </span>
        <Sizes part={core} />
      </CheckRow>
      <CheckRow
        title={copy.ghidra}
        subtitle={copy.ghidraDescription}
        checked={ghidra.available && chosen.ghidra}
        disabled={disabled || !ghidra.available}
        onChange={(event) => onChange({ ...chosen, ghidra: event.target.checked })}
      >
        <span className="check-row-subtitle">
          {ghidra.installed && ghidra.version
            ? copy.installedVersion(copy.ghidraVersion(ghidra.version, ghidra.jdkVersion))
            : copy.ghidraVersion(ghidra.pinnedVersion, ghidra.jdkPinnedVersion)}
        </span>
        {unavailable(ghidra)}
        <Sizes part={ghidra} />
      </CheckRow>
      <CheckRow
        title={copy.frida}
        subtitle={copy.fridaDescription}
        checked={frida.available && chosen.frida}
        disabled={disabled || !frida.available}
        onChange={(event) => onChange({ ...chosen, frida: event.target.checked })}
      >
        <span className="check-row-subtitle">
          {versionLine(frida.installed, frida.version, frida.pinnedVersion)}
        </span>
        {unavailable(frida)}
        <Sizes part={frida} />
      </CheckRow>
      <p className="rea-total" aria-live="polite">
        {copy.total(bytes(sum("downloadSize")), bytes(sum("installedSize")))}
      </p>
    </fieldset>
  );
}
