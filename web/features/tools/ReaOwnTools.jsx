import React from "react";
import Segmented from "../../components/Segmented.jsx";
import { reaCopy as copy } from "../../lib/i18n/messages/rea.js";

const fields = [
  {
    key: "hopperPath",
    type: "text",
    placeholder: "/Applications/Hopper Disassembler.app",
  },
  { key: "idaConfig", type: "text", placeholder: "/path/to/ida-mcp.json" },
  { key: "jebUrl", type: "url", placeholder: "http://127.0.0.1:8851/mcp" },
];

/** The settings form of REA as strings ("" for an unset value). */
export function settingsDraft(settings = {}) {
  return {
    provider: settings.provider === "ida" ? "ida" : "ghidra",
    idaConfig: settings.idaConfig ?? "",
    hopperPath: settings.hopperPath ?? "",
    jebUrl: settings.jebUrl ?? "",
  };
}

/**
 * Bring-your-own tools: the Hopper launcher path, the IDA MCP bridge configuration,
 * the JEB MCP URL and the analysis provider. AgentPier never downloads these; the
 * server validates the values when REA applies them.
 */
export default function ReaOwnTools({ settings, onChange, disabled }) {
  const set = (key, value) => onChange({ ...settings, [key]: value });
  return (
    <section className="rea-section" aria-labelledby="rea-own-tools">
      <h3 id="rea-own-tools">{copy.ownToolsLabel}</h3>
      <p className="dialog-hint">{copy.ownToolsDescription}</p>
      {fields.map(({ key, type, placeholder }) => (
        <label key={key}>
          {copy[key]}
          <input
            type={type}
            value={settings[key]}
            placeholder={placeholder}
            disabled={disabled}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => set(key, event.target.value)}
          />
        </label>
      ))}
      <div className="rea-provider">
        <span className="rea-provider-label">{copy.provider}</span>
        <Segmented
          label={copy.provider}
          value={settings.provider}
          disabled={disabled}
          onChange={(value) => set("provider", value)}
          options={[
            { value: "ghidra", label: "Ghidra" },
            { value: "ida", label: "IDA" },
          ]}
        />
        <p className="dialog-hint">{copy.providerHint}</p>
      </div>
    </section>
  );
}
