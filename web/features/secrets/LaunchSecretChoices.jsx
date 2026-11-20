import React from "react";
import GrantPicker from "../../components/GrantPicker.jsx";
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
  const entries = list.map((secret) => ({
    id: secret.id,
    name: secret.name,
    sub: secret.description || undefined,
    group: owner(secret),
    badge: owner(secret),
  }));
  return (
    <div className="ssh-launch">
      <GrantPicker
        stacked
        entries={entries}
        selected={selected}
        onChange={change}
        typeLabel={copy.grantType}
        listLabel={copy.title}
        heading={copy.title}
      />
      <p>{copy.launchHint}</p>
    </div>
  );
}
