import React, { useId } from "react";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow from "../../../components/ListRow.jsx";
import { assistantCopy as copy } from "../../../lib/i18n/messages/assistants.js";
import { assistantShellCopy as shellCopy } from "../../../lib/i18n/messages/assistant-shell.js";
import { assistantSkillsCopy as skillsCopy } from "../../../lib/i18n/messages/assistant-skills.js";
import { assistantSshCopy as sshCopy } from "../../../lib/i18n/messages/assistant-ssh.js";

const capabilityLabels = {
  webSearch: () => copy.personal.enableWebSearch,
  webFetch: () => copy.personal.enableWebFetch,
  browser: () => copy.personal.enableBrowser,
  documents: () => copy.personal.enableDocuments,
  memory: () => copy.team.inheritedMemory,
  reminders: () => copy.personal.enableReminders,
};

/**
 * What a task member uses from its lead agent right now (the server resolves it on
 * every read): read only here, changed on the lead.
 */
export default function InheritedCapabilities({ inherited }) {
  const id = useId();
  const team = copy.team;
  const state = (on) => (on ? team.inheritedOn : team.inheritedOff);
  return (
    <section id="agent-inherited" aria-labelledby={id}>
      <GroupLabel id={id} hint={team.inheritedHint}>
        {team.inheritedTitle}
      </GroupLabel>
      <ListCard labelledBy={id}>
        {Object.entries(capabilityLabels).map(([key, label]) => (
          <ListRow
            key={key}
            label={label()}
            value={state(inherited.capabilities?.[key] === true)}
          />
        ))}
        <ListRow label={skillsCopy.title} value={(inherited.skills || []).length} />
        <ListRow
          label={shellCopy.title}
          value={shellCopy.levels[inherited.shell] || shellCopy.levels.off}
        />
        <ListRow label={sshCopy.row} value={state(inherited.ssh === true)} />
      </ListCard>
    </section>
  );
}
