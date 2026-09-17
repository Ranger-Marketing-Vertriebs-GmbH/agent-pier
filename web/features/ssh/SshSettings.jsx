import React, { useState } from "react";
import api from "../../lib/api.js";
import useSshAccesses from "./useSshAccesses.js";
import SshAccessForm from "./SshAccessForm.jsx";
import SshCopy from "./SshCopy.jsx";
import SshKeyCard from "./SshKeyCard.jsx";
import SshKeyForm from "./SshKeyForm.jsx";
import SshProjectReassign from "./SshProjectReassign.jsx";
import { sshCopy as copy } from "../../lib/i18n/messages/ssh.js";
import { sshProjectCopy as projectCopy } from "../../lib/i18n/messages/ssh-projects.js";
import "./ssh.css";
function AccessCard({ access, project, edited, removed, loading }) {
  const [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [tested, setTested] = useState(false);
  const run = async (fn) => {
    setBusy(true);
    setError("");
    setTested(false);
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="ssh-card">
      <h3>{access.name}</h3>
      <p className="ssh-owner-badge">
        {projectCopy.owner}: {project?.name || projectCopy.global}
      </p>
      <p>
        {copy.keyMode}: {access.keyName}
      </p>
      <p>
        {access.username}@{access.host}:{access.port}
      </p>
      <p>
        {copy.fingerprint}:{" "}
        <code className="ssh-fingerprint">{access.hostFingerprint}</code>
      </p>
      <SshCopy label={copy.publicKey} text={access.publicKey} button={copy.copyKey} />
      <p>{copy.publicKeyHint}</p>
      <p>{copy.testHint}</p>
      <div className="ssh-actions">
        <button
          className="button"
          disabled={busy || loading}
          onClick={() => edited(access)}
        >
          {copy.edit}
        </button>
        <button
          className="button"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await api(`/ssh-accesses/${encodeURIComponent(access.id)}/test`, "POST");
              setTested(true);
            })
          }
        >
          {copy.test}
        </button>
        <button className="button" disabled={busy} onClick={() => setConfirm(true)}>
          {copy.remove}
        </button>
      </div>
      {confirm && (
        <div className="ssh-confirm">
          <p>{copy.deleteHint}</p>
          <div className="ssh-actions">
            <button className="button" disabled={busy} onClick={() => setConfirm(false)}>
              {copy.cancel}
            </button>
            <button
              className="button"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api(`/ssh-accesses/${encodeURIComponent(access.id)}`, "DELETE");
                  removed(access.id);
                })
              }
            >
              {copy.confirmDelete}
            </button>
          </div>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">{copy.busy}</p>}
      {tested && <p role="status">{copy.testOk}</p>}
    </article>
  );
}
export default function SshSettings() {
  const { data, setData, error, reload } = useSshAccesses();
  const catalog = useSshAccesses("/ssh-keys");
  const projectCatalog = useSshAccesses("/ssh-projects");
  const [editing, setEditing] = useState(null);
  const [editingKey, setEditingKey] = useState(null);
  const [filter, setFilter] = useState("all");
  const [reassigning, setReassigning] = useState(false);
  const ready = Boolean(data && catalog.data && projectCatalog.data);
  const keys = catalog.data?.keys || [];
  const projects = projectCatalog.data?.projects || [];
  const resourceProjectIds = [...keys, ...(data?.accesses || [])]
    .map((item) => item.projectId)
    .filter((id, index, ids) => id && ids.indexOf(id) === index);
  const missingProjectIds = resourceProjectIds.filter(
    (id) => !projects.some((project) => project.id === id),
  );
  const ownerProjects = [
    ...projects,
    ...missingProjectIds.map((id) => ({
      id,
      name: `${projectCopy.unavailable} · ${id}`,
      unavailable: true,
    })),
  ];
  const sourceProjects = resourceProjectIds.map((id) =>
    ownerProjects.find((project) => project.id === id),
  );
  const visible = (item) => filter === "all" || (item.projectId || "") === filter;
  const visibleKeys = keys.filter(visible);
  const visibleAccesses = (data?.accesses || []).filter(visible);

  return (
    <div className="page ssh-page">
      <h1>{copy.title}</h1>
      <p>{copy.description}</p>
      <p>{copy.scope}</p>
      <p>{copy.backupHint}</p>
      <div className="ssh-project-controls">
        <label>
          {projectCopy.filter}
          <select value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option value="all">{projectCopy.all}</option>
            <option value="">{projectCopy.global}</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button"
          disabled={
            !sourceProjects.length ||
            !sourceProjects.some((source) =>
              projects.some((target) => target.id !== source.id),
            )
          }
          onClick={() => setReassigning(true)}
        >
          {projectCopy.reassignOpen}
        </button>
      </div>
      {projectCatalog.error && (
        <div>
          <p role="alert">{projectCatalog.error}</p>
          <button className="button" onClick={projectCatalog.reload}>
            {copy.retry}
          </button>
        </div>
      )}
      {!projectCatalog.data && !projectCatalog.error && (
        <p role="status">{copy.loading}</p>
      )}
      <section className="ssh-keys" aria-labelledby="ssh-keys-heading">
        <h2 id="ssh-keys-heading">{copy.keys}</h2>
        <button
          className="button primary"
          disabled={!ready}
          onClick={() => setEditingKey({})}
        >
          {copy.addKey}
        </button>
        {ready && !keys.length && <p>{copy.emptyKeys}</p>}
        {ready &&
          visibleKeys.map((key) => (
            <SshKeyCard
              key={key.id}
              sshKey={{
                ...key,
                hosts: data.accesses
                  .filter((access) => access.keyId === key.id)
                  .map((access) => ({ id: access.id, name: access.name })),
              }}
              project={ownerProjects.find((project) => project.id === key.projectId)}
              edited={setEditingKey}
              removed={(id) =>
                catalog.setData((current) => ({
                  keys: current.keys.filter((key) => key.id !== id),
                }))
              }
            />
          ))}
      </section>
      {catalog.error && (
        <div>
          <p role="alert">{catalog.error}</p>
          <button className="button" onClick={catalog.reload}>
            {copy.retry}
          </button>
        </div>
      )}
      {!catalog.data && !catalog.error && <p role="status">{copy.loading}</p>}
      <section className="ssh-hosts" aria-labelledby="ssh-hosts-heading">
        <h2 id="ssh-hosts-heading">{copy.hosts}</h2>
        <button
          className="button primary"
          disabled={!ready || (filter === "all" ? !keys.length : !visibleKeys.length)}
          onClick={() => setEditing({})}
        >
          {copy.add}
        </button>
        {error && (
          <div>
            <p role="alert">{error}</p>
            <button className="button" onClick={reload}>
              {copy.retry}
            </button>
          </div>
        )}
        {!data && !error && <p role="status">{copy.loading}</p>}
        {data && !data.accesses.length && <p>{copy.empty}</p>}
        {visibleAccesses.map((access) => (
          <AccessCard
            key={JSON.stringify(access)}
            access={{
              ...access,
              keyName:
                keys.find((key) => key.id === access.keyId)?.name || access.keyName,
            }}
            edited={setEditing}
            loading={!ready}
            project={ownerProjects.find((project) => project.id === access.projectId)}
            removed={(id) =>
              setData((current) => ({
                accesses: current.accesses.filter((item) => item.id !== id),
              }))
            }
          />
        ))}
      </section>
      {editingKey && (
        <SshKeyForm
          sshKey={editingKey.id ? editingKey : null}
          projects={projects}
          projectId={filter === "all" ? null : filter || null}
          close={() => setEditingKey(null)}
          saved={(result) => {
            catalog.setData((current) => ({
              keys: [...current.keys.filter((key) => key.id !== result.id), result],
            }));
            setEditingKey(null);
          }}
        />
      )}
      {editing && (
        <SshAccessForm
          access={editing.id ? editing : null}
          keys={keys}
          projects={projects}
          projectId={filter === "all" ? null : filter || null}
          close={() => setEditing(null)}
          saved={(result) => {
            setData((current) => ({
              accesses: [
                ...(current?.accesses || []).filter((item) => item.id !== result.id),
                result,
              ],
            }));
            setEditing(null);
          }}
        />
      )}
      {reassigning && (
        <SshProjectReassign
          sourceProjects={sourceProjects}
          targetProjects={projects}
          close={() => setReassigning(false)}
          reassigned={() => {
            setReassigning(false);
            catalog.reload();
            reload();
          }}
        />
      )}
    </div>
  );
}
