import React from "react";
import ProviderMark from "../../components/ProviderMark.jsx";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { cliName } from "./run-stages.js";

// Profiles grouped by phase, in the order the phases are listed.
export function profileGroups(profiles) {
  return Object.entries(copy.phaseNames)
    .map(([phase, label]) => ({
      phase,
      label,
      items: profiles.filter((p) => (p.phaseKey || "custom") === phase),
    }))
    .filter((group) => group.items.length);
}

// Choosing a profile opens it for editing.
export default function ProfileList({ groups, selectedId, onSelect }) {
  return (
    <div className="list-detail-items profile-list">
      {groups.map((group) => (
        <div className="profile-group" key={group.phase}>
          <h3 className="profile-group-caps">{group.label}</h3>
          {group.items.map((profile) => {
            const selected = profile.id === selectedId,
              config = profile.config;
            return (
              <button
                type="button"
                key={profile.id}
                className={`profile-item${selected ? " selected" : ""}`}
                aria-label={copy.edit(profile.name)}
                aria-current={selected ? "true" : undefined}
                onClick={() => onSelect(profile.id)}
              >
                <ProviderMark tool={config.cliTool} small />
                <span className="profile-item-text">
                  <strong>{profile.name}</strong>
                  <small>
                    {cliName(config.cliTool)} ·{" "}
                    {config.models.default || copy.accountDefault}
                  </small>
                  <small
                    className={config.run.autonomous ? "" : "profile-item-interactive"}
                  >
                    {config.run.autonomous ? copy.autonomousBadge : copy.interactive}
                    {profile.enabled ? "" : commonCopy.disabledSuffix}
                  </small>
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
