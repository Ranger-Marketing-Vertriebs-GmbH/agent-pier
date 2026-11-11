import React, { useId } from "react";
import useAssistants from "../useAssistants.js";
import { agentGroupsCopy as copy } from "../../../lib/i18n/messages/agent-groups.js";
export default function GroupSelect({ value, onChange }) {
  const id = useId();
  const { agentGroups: groups = [] } = useAssistants();
  if (!groups.length) return null;
  return (
    <div className="agent-field">
      <label htmlFor={id}>{copy.select}</label>
      <select
        id={id}
        value={value || ""}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">{copy.ungrouped}</option>
        {groups.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </select>
    </div>
  );
}
