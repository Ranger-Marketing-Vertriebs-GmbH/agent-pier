import React from "react";
import CheckRow from "../../components/CheckRow.jsx";
import { sshCopy as copy } from "../../lib/i18n/messages/ssh.js";
import { sshProjectCopy as projectCopy } from "../../lib/i18n/messages/ssh-projects.js";
export default function SshChoices({
  accesses,
  selected,
  inherited = [],
  change,
  disabled = false,
  hideLegend = false,
}) {
  return (
    <fieldset className="ssh-choices check-list" disabled={disabled}>
      <legend className={hideLegend ? "visually-hidden" : undefined}>{copy.title}</legend>
      {!accesses.length && <p className="dialog-hint">{copy.empty}</p>}
      {accesses.map((access) => {
        const managed = inherited.includes(access.id);
        const explicit = selected.includes(access.id);
        return (
          <div key={access.id} className="ssh-choice">
            <CheckRow
              title={access.name}
              subtitle={`${access.username}@${access.host}:${access.port}`}
              checked={managed || selected.includes(access.id)}
              disabled={disabled || managed}
              onChange={(event) =>
                change(
                  event.target.checked
                    ? [...selected, access.id]
                    : selected.filter((id) => id !== access.id),
                )
              }
            >
              {access.type === "sftp" && <span className="badge">{copy.sftpBadge}</span>}
              {managed && (
                <span className="check-row-meta">{projectCopy.projectManaged}</span>
              )}
              {explicit && (
                <span className="check-row-meta">{projectCopy.explicitAssignment}</span>
              )}
            </CheckRow>
            {managed && explicit && (
              <button
                type="button"
                className="ssh-choice-remove"
                disabled={disabled}
                onClick={() => change(selected.filter((id) => id !== access.id))}
              >
                {projectCopy.removeExplicit}
              </button>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}
