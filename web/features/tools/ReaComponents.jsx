import React from "react";
import CheckRow from "../../components/CheckRow.jsx";
import { reaCopy as copy } from "../../lib/i18n/messages/rea.js";
import { names } from "../../lib/providers.js";
import { GhidraRow, PartsTotal, Sizes, Unavailable, versionLine } from "./ToolParts.jsx";

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
  return (
    <fieldset className="check-list rea-components">
      <legend>{copy.componentsLabel}</legend>
      <CheckRow title={copy.core} subtitle={copy.coreDescription} checked disabled>
        <span className="check-row-subtitle">
          {versionLine(core.installed, core.version, core.pinnedVersion)}
        </span>
        <Sizes part={core} />
      </CheckRow>
      <GhidraRow
        ghidra={ghidra}
        checked={chosen.ghidra}
        disabled={disabled}
        sharedWith={names["craft-anything"]}
        onChange={(checked) => onChange({ ...chosen, ghidra: checked })}
      />
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
        <Unavailable part={frida} />
        <Sizes part={frida} />
      </CheckRow>
      <PartsTotal parts={chosenParts(components, chosen)} />
    </fieldset>
  );
}
