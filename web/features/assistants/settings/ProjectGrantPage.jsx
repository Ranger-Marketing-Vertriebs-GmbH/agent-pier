import React from "react";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import { CheckboxRow, RadioRow } from "../../../components/ListRow.jsx";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { assistantWorkflowCopy as copy } from "../../../lib/i18n/messages/assistant-workflows.js";
import { folderLevels, setFolderLevel, toggleId } from "./agent-settings-fields.js";
import SubpageHeader from "./SubpageHeader.jsx";
import LockedNotice from "./LockedNotice.jsx";
import "./ssh-grant-page.css";

/**
 * The projects this agent may use and, per granted project, its direct access to
 * the project folder (none, read, or read and write); part of the Work draft.
 * Removing a project also removes its folder access. An agent of users
 * (`foldersOnly`) gets folders only, read or read and write, never the project.
 */
export default function ProjectGrantPage({
  items,
  selected,
  levels,
  disabled,
  onChange,
  onBack,
  foldersOnly = false,
}) {
  const toggle = (id, on) =>
    onChange(
      foldersOnly
        ? {
            projectIds: selected,
            projectFiles: setFolderLevel(levels, id, on ? "read" : null),
          }
        : {
            projectIds: toggleId(selected, id, on),
            projectFiles: on ? levels : setFolderLevel(levels, id, null),
          },
    );
  const choices = foldersOnly ? folderLevels.filter((v) => v !== "none") : folderLevels;
  return (
    <section className="agent-subpage ssh-grant-page" aria-label={copy.projects}>
      <SubpageHeader title={copy.projects} tab="access" onBack={onBack} />
      {foldersOnly && <LockedNotice items={["coding"]} />}
      <p className="assistant-note">
        {foldersOnly ? copy.projectsFoldersIntro : copy.projectsIntro}
      </p>
      {!items && <p className="assistant-note">{assistantCopy.loading}</p>}
      {items?.length === 0 && <p className="assistant-note">{copy.noResources}</p>}
      {items?.length > 0 && (
        <ListCard label={copy.projects}>
          {items.map((item) => {
            const granted = foldersOnly
              ? Boolean(levels[item.id])
              : selected.includes(item.id);
            const level = levels[item.id] || "none";
            const legend = `project-folder-${item.id}-label`;
            return (
              <div key={item.id} className="ssh-grant-host" data-project-grant={item.id}>
                <CheckboxRow
                  label={item.name}
                  sub={item.path}
                  checked={granted}
                  disabled={disabled}
                  onChange={(on) => toggle(item.id, on)}
                />
                {granted && (
                  <div className="ssh-grant-modes">
                    <GroupLabel as="h3" id={legend}>
                      {copy.folderLegend}
                    </GroupLabel>
                    <ListCard labelledBy={legend} disabled={disabled}>
                      {choices.map((value) => (
                        <RadioRow
                          key={value}
                          name={`project-folder-${item.id}`}
                          value={value}
                          label={copy.folderLevels[value]}
                          sub={copy.folderHints[value]}
                          checked={level === value}
                          disabled={disabled}
                          onChange={(next) =>
                            onChange({
                              projectIds: selected,
                              projectFiles: setFolderLevel(levels, item.id, next),
                            })
                          }
                        />
                      ))}
                    </ListCard>
                    {level === "write" && (
                      <p className="ssh-grant-warning">{copy.folderWarning}</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </ListCard>
      )}
    </section>
  );
}
