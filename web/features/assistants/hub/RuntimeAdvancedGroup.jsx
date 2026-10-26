import React, { useId } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import { agentsHubCopy } from "../../../lib/i18n/messages/agents-hub.js";
import { assistantAdvancedCopy as copy } from "../../../lib/i18n/messages/assistant-advanced.js";
import AdvancedSettingRow from "../../settings/AdvancedSettingRow.jsx";
import { advancedKey } from "./runtime-draft.js";
import "../../settings/advanced-settings.css";

const groups = ["runs", "media"];

/**
 * Laufzeit › Erweitert (handoff 5.2, formerly its own subpage): the allow-listed
 * OpenClaw values for all agents with their Sofort/Neustart nötig badges, ⓘ help and
 * "Standard" reset, and the notes for an unapproved runtime or a stopped service.
 * `section=advanced` scrolls here (id `agents-runtime-advanced`).
 */
export default function RuntimeAdvancedGroup({
  data,
  settings,
  loadError,
  values,
  edit,
  disabled,
}) {
  const id = useId();
  const gateway = data?.gateway;
  return (
    <section id="agents-runtime-advanced" aria-labelledby={id}>
      <GroupLabel id={id} hint={copy.intro}>
        {agentsHubCopy.runtime.advanced}
      </GroupLabel>
      <ErrorMessage error={loadError} />
      {!data && !loadError && <p role="status">{copy.loading}</p>}
      {gateway && !gateway.qualified && (
        <p className="advanced-settings-note" role="status">
          {copy.unqualified(gateway.version)}
        </p>
      )}
      {gateway?.qualified && !gateway.running && (
        <p className="advanced-settings-note" role="status">
          {copy.stopped}
        </p>
      )}
      {groups.map((group) => {
        const members = settings.filter((s) => s.group === group);
        if (!members.length) return null;
        const labelId = `${id}-${group}`;
        return (
          <React.Fragment key={group}>
            <GroupLabel as="h3" id={labelId}>
              {copy.groups[group]}
            </GroupLabel>
            <ListCard labelledBy={labelId}>
              {members.map((setting) => (
                <AdvancedSettingRow
                  key={setting.id}
                  setting={setting}
                  value={values[advancedKey(setting.id)] ?? ""}
                  onChange={edit(advancedKey(setting.id))}
                  disabled={disabled}
                />
              ))}
            </ListCard>
          </React.Fragment>
        );
      })}
    </section>
  );
}
