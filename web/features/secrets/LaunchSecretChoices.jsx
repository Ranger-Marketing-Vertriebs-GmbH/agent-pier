import React, { useEffect } from "react";
import CheckRow from "../../components/CheckRow.jsx";
import useResource from "../../lib/useResource.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { secretsCopy as copy } from "../../lib/i18n/messages/secrets.js";
import { launchProject, launchSecretSelection } from "./launch-secrets.js";

/**
 * The new-session dialog's secrets: the launch project's own come with the session
 * (fixed), global ones and other projects' can be added (`selected`, sent as
 * `secretIds`). Shown only once secrets exist.
 */
export default function LaunchSecretChoices({ cwd, selected, change }) {
  const secrets = useResource("/secrets");
  const list = secrets.data?.secrets;
  // The projects (as in Settings › Secrets) are read only once there are secrets.
  const projects = useResource(list?.length ? "/ssh-projects" : null);
  const known = projects.data?.projects;
  const project = known ? launchProject(known, cwd) : null;
  // A secret the new folder's project brings itself is no longer an extra choice.
  useEffect(() => {
    if (!list || !known) return;
    const kept = launchSecretSelection(selected, list, project?.id);
    if (kept !== selected) change(kept);
  }, [list, known, project?.id, selected, change]);
  const error = secrets.error || projects.error;
  if (error)
    return (
      <div className="ssh-launch">
        <p role="alert">{error}</p>
        <button
          className="button"
          type="button"
          onClick={() => {
            secrets.refresh();
            projects.refresh();
          }}
        >
          {commonCopy.retry}
        </button>
      </div>
    );
  if (!list?.length || !known) return null;
  const owner = (secret) =>
    secret.projectId
      ? known.find((item) => item.id === secret.projectId)?.name ||
        copy.unavailableProject(secret.projectId)
      : copy.global;
  return (
    <div className="ssh-launch">
      <fieldset className="ssh-choices check-list">
        <legend>{copy.title}</legend>
        {list.map((secret) => {
          const own = Boolean(project && secret.projectId === project.id);
          return (
            <CheckRow
              key={secret.id}
              title={secret.name}
              subtitle={secret.description || undefined}
              checked={own || selected.includes(secret.id)}
              disabled={own}
              onChange={(event) =>
                change(
                  event.target.checked
                    ? [...selected, secret.id]
                    : selected.filter((id) => id !== secret.id),
                )
              }
            >
              {own ? (
                <span className="check-row-meta">{copy.launchProject}</span>
              ) : (
                <span className="badge">{owner(secret)}</span>
              )}
            </CheckRow>
          );
        })}
      </fieldset>
      <p>{copy.launchHint}</p>
    </div>
  );
}
