import React, { useId } from "react";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow from "../../../components/ListRow.jsx";
import { assistantCopy as copy } from "../../../lib/i18n/messages/assistants.js";
import { memberGrantCopy as grantCopy } from "../../../lib/i18n/messages/assistant-member-grants.js";
import { assistantPdfCopy as pdfCopy } from "../../../lib/i18n/messages/assistant-pdf.js";
import { assistantShellCopy as shellCopy } from "../../../lib/i18n/messages/assistant-shell.js";
import { assistantSkillsCopy as skillsCopy } from "../../../lib/i18n/messages/assistant-skills.js";
import { assistantSshCopy as sshCopy } from "../../../lib/i18n/messages/assistant-ssh.js";
import { folderCounts, logText } from "../member-grants.js";
import { routePath } from "../../../app/routes.js";
import { agentRoute } from "./agent-settings-fields.js";
import ReplacedInstructions from "./ReplacedInstructions.jsx";

const capabilityLabels = {
  webSearch: () => copy.personal.enableWebSearch,
  webFetch: () => copy.personal.enableWebFetch,
  browser: () => copy.personal.enableBrowser,
  documents: () => copy.personal.enableDocuments,
  readPdfs: () => pdfCopy.enable,
  createImages: () => copy.personal.enableCreateImages,
  memory: () => grantCopy.memory,
  reminders: () => copy.personal.enableReminders,
};

/**
 * What a task member runs with: what its lead granted, within what the lead has
 * right now (the server resolves `inherited` on every read), and the lead's later
 * grant changes with who made them and when. Read only here.
 */
export default function GrantedCapabilities({ inherited, member, assistantId, go }) {
  const id = useId();
  const state = (on) => (on ? grantCopy.on : grantCopy.off);
  const log = member?.grantLog || [];
  return (
    <section id="agent-granted" aria-labelledby={id}>
      <GroupLabel id={id} hint={grantCopy.hint}>
        {grantCopy.title}
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
        {/* Granted folders at the level the member uses now, capped by the lead. */}
        <ListRow
          label={grantCopy.projectFolders}
          value={folderCounts(inherited.projects)}
        />
        {/* GitHub through the lead's token profile, at most at the lead's level now. */}
        <ListRow
          label={grantCopy.github}
          value={grantCopy.githubLevels[inherited.github?.level || "none"]}
        />
        {/* Its own memory, always on, beside the copy of the lead's (memory/lead/). */}
        {assistantId && (
          <ListRow
            label={grantCopy.ownMemory}
            sub={grantCopy.ownMemoryHint}
            href={routePath(agentRoute(assistantId, "capabilities", "memory"))}
            onClick={() => go("capabilities", "memory")}
          />
        )}
      </ListCard>
      {log.length > 0 && (
        <>
          <h3 className="agent-granted-history">{grantCopy.history}</h3>
          <ul className="agent-granted-log" data-grant-log="">
            {[...log].reverse().map((entry, n) => (
              <li key={n}>
                {logText(entry)}
                {entry.replaced && (
                  <ReplacedInstructions memberId={member.id} entryId={entry.replaced} />
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
