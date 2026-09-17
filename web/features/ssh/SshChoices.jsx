import React from "react";
import { sshCopy as copy } from "../../lib/i18n/messages/ssh.js";
import { sshProjectCopy as projectCopy } from "../../lib/i18n/messages/ssh-projects.js";
export default function SshChoices({
  accesses,
  selected,
  inherited = [],
  change,
  disabled = false,
}) {
  return (
    <fieldset className="ssh-choices" disabled={disabled}>
      <legend>{copy.title}</legend>
      {!accesses.length && <p>{copy.empty}</p>}
      {accesses.map((access) => {
        const managed = inherited.includes(access.id);
        const explicit = selected.includes(access.id);
        return (
          <div key={access.id}>
            <label className="ssh-check">
              <input
                type="checkbox"
                checked={managed || selected.includes(access.id)}
                disabled={disabled || managed}
                onChange={(event) =>
                  change(
                    event.target.checked
                      ? [...selected, access.id]
                      : selected.filter((id) => id !== access.id),
                  )
                }
              />
              <span>
                <strong>{access.name}</strong>
                <small>
                  {access.username}@{access.host}:{access.port}
                </small>
                {managed && <small>{projectCopy.projectManaged}</small>}
                {explicit && <small>{projectCopy.explicitAssignment}</small>}
              </span>
            </label>
            {managed && explicit && (
              <button
                type="button"
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
