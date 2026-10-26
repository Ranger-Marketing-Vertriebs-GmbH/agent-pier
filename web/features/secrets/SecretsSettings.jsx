import React, { useEffect, useRef, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Icon from "../../components/Icon.jsx";
import ListDetail from "../../components/ListDetail.jsx";
import api from "../../lib/api.js";
import { requestNavigation } from "../../lib/navigation-guard.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { secretsCopy as copy } from "../../lib/i18n/messages/secrets.js";
import { sshProjectCopy as projectCopy } from "../../lib/i18n/messages/ssh-projects.js";
import SecretForm from "./SecretForm.jsx";
import "./secrets.css";

const byName = (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/**
 * Zugänge › Geheimnisse: values go to the server and never come back. `usedBy(secret)`
 * renders who uses the open secret; `emptyState` replaces the empty sentence; `onChanged`
 * hears every create, edit and delete (to reload counts and usage).
 */
export default function SecretsSettings({ usedBy, emptyState, onChanged }) {
  const [secrets, setSecrets] = useState(null);
  const [projects, setProjects] = useState([]);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  // "" shows the list (and the hint on desktop), "new" the empty form.
  const [selectedId, setSelectedId] = useState("");
  // A just created secret's form mounts anew; its heading takes the focus.
  const [createdId, setCreatedId] = useState("");
  const addButton = useRef(null);
  // Switching secrets asks the open form's unsaved-changes guard first.
  const select = (id) =>
    requestNavigation({
      reason: "application",
      commit: () => {
        setCreatedId("");
        setSelectedId(id);
      },
    });
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    // The same project list the SSH owner field uses.
    Promise.all([
      api("/secrets", "GET", undefined, controller.signal),
      api("/ssh-projects", "GET", undefined, controller.signal),
    ])
      .then(([secretData, projectData]) => {
        setSecrets(secretData.secrets);
        setProjects(projectData.projects);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err.message);
      });
    return () => controller.abort();
  }, [revision]);
  // Same-named projects are told apart by their folder, as in the SSH settings.
  const named = projects.map((project) => ({
    ...project,
    name: projects.some((other) => other.id !== project.id && other.name === project.name)
      ? projectCopy.projectLocation(project.name, project.cwd || project.id)
      : project.name,
  }));
  const missing = (secrets || [])
    .map((secret) => secret.projectId)
    .filter(
      (id, index, ids) =>
        id && ids.indexOf(id) === index && !named.some((project) => project.id === id),
    )
    .map((id) => ({ id, name: copy.unavailableProject(id) }));
  const owners = [...named, ...missing];
  const ownerName = (secret) =>
    owners.find((project) => project.id === secret.projectId)?.name || copy.global;
  const items = [...(secrets || [])].sort(byName);
  const selected = items.find((secret) => secret.id === selectedId);
  const detailId = selected || selectedId === "new" ? selectedId : "";
  return (
    <div className="page secrets-page">
      <header className="secrets-heading">
        <p>{copy.notice}</p>
        {/* An empty list offers adding in its empty state. */}
        {!(emptyState && secrets && !items.length && !detailId) && (
          <button
            type="button"
            className="button primary"
            ref={addButton}
            disabled={!secrets}
            onClick={() => select("new")}
          >
            <Icon name="plus" />
            {copy.add}
          </button>
        )}
      </header>
      {error && (
        <div className="secrets-load-error">
          <ErrorMessage error={error} />
          <button
            type="button"
            className="button secondary"
            onClick={() => setRevision((value) => value + 1)}
          >
            {commonCopy.retry}
          </button>
        </div>
      )}
      {!secrets && !error && <p role="status">{copy.loading}</p>}
      {secrets &&
        !items.length &&
        !detailId &&
        (emptyState ? emptyState(() => select("new")) : <p>{copy.empty}</p>)}
      {secrets && (
        <ListDetail
          className="secrets-list-detail"
          listLabel={copy.title}
          count={items.length}
          items={items}
          selectedId={detailId}
          onSelect={select}
          mobileBackLabel={copy.back}
          renderItem={(secret) => (
            <span className="secrets-item">
              <strong>{secret.name}</strong>
              {secret.description && <small>{secret.description}</small>}
              <small>{ownerName(secret)}</small>
            </span>
          )}
          detail={
            detailId ? (
              <>
                <SecretForm
                  key={detailId}
                  secret={selected || null}
                  projects={owners}
                  focusHeading={detailId === createdId}
                  saved={(result) => {
                    if (!selected) setCreatedId(result.id);
                    setSecrets((current) => [
                      ...current.filter((secret) => secret.id !== result.id),
                      result,
                    ]);
                    setSelectedId(result.id);
                    onChanged?.();
                  }}
                  removed={(id) => {
                    setSecrets((current) => current.filter((secret) => secret.id !== id));
                    setSelectedId("");
                    // The dialog's opener is gone; the add button keeps the focus.
                    requestAnimationFrame(() => addButton.current?.focus());
                    onChanged?.();
                  }}
                />
                {selected && usedBy?.(selected)}
              </>
            ) : (
              items.length > 0 && <p className="secrets-placeholder">{copy.choose}</p>
            )
          }
        />
      )}
    </div>
  );
}
