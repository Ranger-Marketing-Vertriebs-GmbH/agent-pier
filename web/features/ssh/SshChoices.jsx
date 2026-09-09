import React from "react";
import { sshCopy as copy } from "../../lib/i18n/messages/ssh.js";
export default function SshChoices({ accesses, selected, change, disabled = false }) {
  return (
    <fieldset className="ssh-choices" disabled={disabled}>
      <legend>{copy.title}</legend>
      {!accesses.length && <p>{copy.empty}</p>}
      {accesses.map((access) => (
        <label className="ssh-check" key={access.id}>
          <input
            type="checkbox"
            checked={selected.includes(access.id)}
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
          </span>
        </label>
      ))}
    </fieldset>
  );
}
