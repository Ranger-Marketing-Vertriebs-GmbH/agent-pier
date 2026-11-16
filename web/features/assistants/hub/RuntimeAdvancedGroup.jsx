import React, { useId } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import { agentsHubCopy } from "../../../lib/i18n/messages/agents-hub.js";
import { assistantAdvancedCopy as copy } from "../../../lib/i18n/messages/assistant-advanced.js";
import AdvancedSettingRow from "../../settings/AdvancedSettingRow.jsx";
import RuntimeSlot from "../RuntimeSlot.jsx";
import { advancedNotes, settingScope } from "./advanced-scopes.js";
import { advancedKey } from "./runtime-draft.js";
import RuntimeOwnSettings from "./RuntimeOwnSettings.jsx";
import "../../settings/advanced-settings.css";

const groups = ["runs", "media"];

// A note's text and whether it only informs (advanced-scopes.js advancedNotes).
const noteText = (note) =>
  ({
    unqualified: () => copy.unqualified(note.version),
    stopped: () => copy.stopped,
    applies: () => copy.runtimeApplies(note.only, note.name),
    otherUnqualified: () =>
      copy.runtimeUnqualified(note.product, note.version, note.name),
  })[note.kind]();
const informs = (note) => note.kind === "applies" || note.kind === "otherUnqualified";

/**
 * Laufzeit › Erweitert (handoff 5.2, formerly its own subpage): the shared settings
 * for all agents with their Sofort/Neustart nötig badges, ⓘ help and "Standard"
 * reset, and the notes for an unapproved runtime or a stopped service. It names no
 * runtime: the server lists them (`data.runtimes`) and says how each takes a setting.
 * While a further runtime has agents, settings it has no equivalent of say "<first
 * runtime> only", those that restart its agents say so, and a note names which apply
 * to them or a version the mapping is not approved for (advanced-scopes.js). Below,
 * each runtime's own described settings render under its name through the slot
 * `hub.runtime.advanced`. `section=advanced` scrolls here (id
 * `agents-runtime-advanced`).
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
  return (
    <section id="agents-runtime-advanced" aria-labelledby={id}>
      <GroupLabel id={id} hint={copy.intro}>
        {agentsHubCopy.runtime.advanced}
      </GroupLabel>
      <ErrorMessage error={loadError} />
      {!data && !loadError && <p role="status">{copy.loading}</p>}
      {advancedNotes(data).map((note) => (
        <p
          key={`${note.kind}:${note.name ?? ""}`}
          className={`advanced-settings-note${informs(note) ? " info" : ""}`}
          role="status"
        >
          {noteText(note)}
        </p>
      ))}
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
                  scope={settingScope(data, setting)}
                />
              ))}
            </ListCard>
          </React.Fragment>
        );
      })}
      <RuntimeSlot
        name="hub.runtime.advanced"
        context={{ data, values, edit, disabled }}
        Described={RuntimeOwnSettings}
      />
    </section>
  );
}
