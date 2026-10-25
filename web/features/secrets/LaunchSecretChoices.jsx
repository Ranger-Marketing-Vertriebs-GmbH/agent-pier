import React from "react";
import CheckRow from "../../components/CheckRow.jsx";
import useResource from "../../lib/useResource.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { secretsCopy as copy } from "../../lib/i18n/messages/secrets.js";

/**
 * The new-session dialog's secrets, each optional and sent as `secretIds`. The
 * server adds the session's own project's secrets anyway (and drops duplicates), so
 * the dialog never guesses the project. Shown only once secrets exist.
 */
export default function LaunchSecretChoices({ selected, change }) {
  const secrets = useResource("/secrets");
  const list = secrets.data?.secrets;
  // Only for the owner badges: without the project list a badge shows the id.
  const projects = useResource(
    list?.some((secret) => secret.projectId) ? "/ssh-projects" : null,
  );
  if (secrets.error)
    return (
      <div className="ssh-launch">
        <p role="alert">{secrets.error}</p>
        <button className="button" type="button" onClick={secrets.refresh}>
          {commonCopy.retry}
        </button>
      </div>
    );
  if (!list?.length) return null;
  const owner = (secret) =>
    secret.projectId
      ? projects.data?.projects?.find((item) => item.id === secret.projectId)?.name ||
        secret.projectId
      : copy.global;
  return (
    <div className="ssh-launch">
      <fieldset className="ssh-choices check-list">
        <legend>{copy.title}</legend>
        {list.map((secret) => (
          <CheckRow
            key={secret.id}
            title={secret.name}
            subtitle={secret.description || undefined}
            checked={selected.includes(secret.id)}
            onChange={(event) =>
              change(
                event.target.checked
                  ? [...selected, secret.id]
                  : selected.filter((id) => id !== secret.id),
              )
            }
          >
            <span className="badge">{owner(secret)}</span>
          </CheckRow>
        ))}
      </fieldset>
      <p>{copy.launchHint}</p>
    </div>
  );
}
