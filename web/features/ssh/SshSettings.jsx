import React, { useRef, useState } from "react";
import Icon from "../../components/Icon.jsx";
import { Pagination } from "../../components/Pagination.jsx";
import SshAccessDetails from "./SshAccessDetails.jsx";
import SshResourceList from "./SshResourceList.jsx";
import SshDetails from "./SshDetails.jsx";
import useSshAccesses from "./useSshAccesses.js";
import SshAccessForm from "./SshAccessForm.jsx";
import SshKeyCard from "./SshKeyCard.jsx";
import SshKeyForm from "./SshKeyForm.jsx";
import SshProjectReassign from "./SshProjectReassign.jsx";
import { sshCopy as copy } from "../../lib/i18n/messages/ssh.js";
import { sshProjectCopy as projectCopy } from "../../lib/i18n/messages/ssh-projects.js";
import "./ssh.css";
import "./ssh-settings.css";
export default function SshSettings() {
  const { data, setData, error, reload } = useSshAccesses();
  const catalog = useSshAccesses("/ssh-keys");
  const projectCatalog = useSshAccesses("/ssh-projects");
  const [editing, setEditing] = useState(null);
  const [editingKey, setEditingKey] = useState(null);
  const [filter, setFilter] = useState("all");
  const [tab, setTab] = useState("accesses");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [page, setPage] = useState(0);
  const rowRefs = useRef(new Map());
  const searchRef = useRef(null);
  const [reassigning, setReassigning] = useState(false);
  const ready = Boolean(data && catalog.data && projectCatalog.data);
  const keys = catalog.data?.keys || [];
  const knownProjects = projectCatalog.data?.projects || [];
  const projects = knownProjects.map((project) => ({
    ...project,
    name: knownProjects.some(
      (other) => other.id !== project.id && other.name === project.name,
    )
      ? projectCopy.projectLocation(project.name, project.cwd || project.id)
      : project.name,
  }));
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
  const projectFor = (item) =>
    ownerProjects.find((project) => project.id === item.projectId);
  const ownerName = (item) => projectFor(item)?.name || projectCopy.global;
  const accesses = (data?.accesses || []).map((access) => ({
    ...access,
    keyName: keys.find((key) => key.id === access.keyId)?.name || access.keyName,
  }));
  const ownedKeys = keys.filter(
    (key) => filter === "all" || (key.projectId || "") === filter,
  );
  const ownerAvailable =
    filter === "all" ||
    filter === "" ||
    projects.some((project) => project.id === filter);
  const needle = query.trim().toLocaleLowerCase();
  const resources = (tab === "accesses" ? accesses : keys)
    .filter(
      (item) =>
        (filter === "all" || (item.projectId || "") === filter) &&
        [item.name, item.host, item.username, item.keyName, ownerName(item)].some(
          (value) => value?.toLocaleLowerCase().includes(needle),
        ),
    )
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const pageSize = 20;
  const currentPage = Math.min(
    page,
    Math.max(0, Math.ceil(resources.length / pageSize) - 1),
  );
  const paging = {
    page: currentPage,
    pageSize,
    total: resources.length,
    pageCount: Math.max(1, Math.ceil(resources.length / pageSize)),
    start: resources.length ? currentPage * pageSize + 1 : 0,
    end: Math.min(resources.length, (currentPage + 1) * pageSize),
    setPage: (next) => {
      setPage(next);
      setSelectedId(null);
    },
  };
  const selected = ready && resources.find((item) => item.id === selectedId);
  const selectedKey =
    selected && tab === "keys"
      ? {
          ...selected,
          hosts: accesses
            .filter((access) => access.keyId === selected.id)
            .map(({ id, name }) => ({ id, name })),
        }
      : null;
  const resetSelection = () => {
    setSelectedId(null);
    setPage(0);
  };
  const changeTab = (next) => {
    setTab(next);
    setQuery("");
    resetSelection();
  };
  const closeDetails = () => {
    const row = rowRefs.current.get(selectedId);
    setSelectedId(null);
    requestAnimationFrame(() => (row?.isConnected ? row : searchRef.current)?.focus());
  };
  const showKey = (id) => {
    const ordered = [...keys].sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );
    setTab("keys");
    setQuery("");
    setFilter("all");
    setSelectedId(id);
    setPage(
      Math.max(0, Math.floor(ordered.findIndex((key) => key.id === id) / pageSize)),
    );
  };
  const resetFilters = () => {
    setFilter("all");
    setQuery("");
    resetSelection();
    searchRef.current?.focus();
  };

  const revealSaved = (item, items, nextTab) => {
    const nextFilter =
      filter === "all" || (item.projectId || "") === filter ? filter : "all";
    const ordered = items
      .filter(
        (resource) => nextFilter === "all" || (resource.projectId || "") === nextFilter,
      )
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    setQuery("");
    setFilter(nextFilter);
    setTab(nextTab);
    setSelectedId(item.id);
    setPage(
      Math.max(
        0,
        Math.floor(ordered.findIndex((resource) => resource.id === item.id) / pageSize),
      ),
    );
  };
  return (
    <div className="page ssh-page">
      <header className="ssh-heading">
        <div>
          <h1>{copy.title}</h1>
          <p>{copy.description}</p>
        </div>
        <button
          className="button primary"
          disabled={
            !ready || !ownerAvailable || (tab === "accesses" && !ownedKeys.length)
          }
          title={!ownerAvailable ? projectCopy.errors.SSH_PROJECT_UNAVAILABLE : undefined}
          onClick={() => (tab === "accesses" ? setEditing({}) : setEditingKey({}))}
        >
          <Icon name="plus" />
          {tab === "accesses" ? copy.add : copy.addKey}
        </button>
      </header>
      <div className="ssh-tabs" role="tablist" aria-label={copy.title}>
        {["accesses", "keys"].map((id, index) => (
          <button
            key={id}
            id={`ssh-tab-${id}`}
            role="tab"
            aria-selected={tab === id}
            aria-controls="ssh-resource-panel"
            tabIndex={tab === id ? 0 : -1}
            onClick={() => changeTab(id)}
            onKeyDown={(event) => {
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? 1
                    : ["ArrowLeft", "ArrowRight"].includes(event.key)
                      ? 1 - index
                      : null;
              if (next === null) return;
              event.preventDefault();
              changeTab(next === 0 ? "accesses" : "keys");
              event.currentTarget.parentElement.children[next].focus();
            }}
          >
            {id === "accesses" ? copy.accessesTab : copy.keysTab}
            <span>{id === "accesses" ? accesses.length : keys.length}</span>
          </button>
        ))}
      </div>
      {[{ data, error, reload }, catalog, projectCatalog].map(
        (resource, index) =>
          resource.error && (
            <div key={index} className="ssh-load-error">
              <p role="alert">{resource.error}</p>
              <button className="button secondary" onClick={resource.reload}>
                {copy.retry}
              </button>
            </div>
          ),
      )}
      {!ready && !error && !catalog.error && !projectCatalog.error && (
        <p role="status">{copy.loading}</p>
      )}
      <section
        id="ssh-resource-panel"
        role="tabpanel"
        aria-labelledby={`ssh-tab-${tab}`}
        className={`ssh-workspace${selected ? " has-details" : ""}`}
      >
        <div className="ssh-list-panel">
          <div className="ssh-list-toolbar">
            <input
              ref={searchRef}
              type="search"
              aria-label={copy.search}
              placeholder={tab === "accesses" ? copy.searchAccesses : copy.searchKeys}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                resetSelection();
              }}
            />
            <select
              aria-label={projectCopy.filter}
              value={filter}
              onChange={(event) => {
                setFilter(event.target.value);
                resetSelection();
              }}
            >
              <option value="all">{projectCopy.all}</option>
              <option value="">{projectCopy.global}</option>
              {ownerProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>
          <SshResourceList
            items={resources.slice(currentPage * pageSize, (currentPage + 1) * pageSize)}
            tab={tab}
            selectedId={selectedId}
            select={setSelectedId}
            ownerName={ownerName}
            accesses={data ? accesses : null}
            rowRefs={rowRefs}
          />
          {ready && !resources.length && (
            <div className="ssh-empty">
              <p>
                {query || filter !== "all"
                  ? copy.noMatches
                  : tab === "accesses"
                    ? copy.empty
                    : copy.emptyKeys}
              </p>
              {query || filter !== "all" ? (
                <button className="button secondary" onClick={resetFilters}>
                  {copy.resetFilters}
                </button>
              ) : (
                tab === "accesses" &&
                !keys.length && (
                  <button className="button secondary" onClick={() => changeTab("keys")}>
                    {copy.addKey}
                  </button>
                )
              )}
            </div>
          )}
          <Pagination
            paging={paging}
            label={tab === "accesses" ? copy.accessesTab : copy.keysTab}
          />
        </div>
        {selected && (
          <SshDetails key={`${tab}-${selected.id}`} close={closeDetails}>
            {tab === "accesses" ? (
              <SshAccessDetails
                key={JSON.stringify(selected)}
                access={selected}
                project={projectFor(selected)}
                edited={setEditing}
                loading={!ready}
                viewKey={showKey}
                removed={(id) => {
                  closeDetails();
                  setData((current) => ({
                    accesses: current.accesses.filter((item) => item.id !== id),
                  }));
                }}
              />
            ) : (
              <SshKeyCard
                sshKey={selectedKey}
                project={projectFor(selected)}
                edited={setEditingKey}
                removed={(id) => {
                  closeDetails();
                  catalog.setData((current) => ({
                    keys: current.keys.filter((key) => key.id !== id),
                  }));
                }}
              />
            )}
          </SshDetails>
        )}
      </section>
      <footer className="ssh-settings-footer">
        <details>
          <summary>{copy.securityNotes}</summary>
          <p>{copy.scope}</p>
          <p>{copy.backupHint}</p>
        </details>
        <button
          className="ssh-text-button"
          disabled={
            !sourceProjects.some((source) =>
              projects.some((target) => target.id !== source.id),
            )
          }
          onClick={() => setReassigning(true)}
        >
          {projectCopy.reassignOpen}
        </button>
      </footer>
      {editingKey && (
        <SshKeyForm
          sshKey={editingKey.id ? editingKey : null}
          projects={projects}
          projectId={filter === "all" ? null : filter || null}
          close={() => setEditingKey(null)}
          saved={(result) => {
            revealSaved(
              result,
              [...keys.filter((key) => key.id !== result.id), result],
              "keys",
            );
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
            revealSaved(
              result,
              [...accesses.filter((item) => item.id !== result.id), result],
              "accesses",
            );
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
