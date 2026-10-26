import React, { useRef, useState } from "react";
import { connectionsAreaCopy as copy } from "../../lib/i18n/messages/connections-area.js";
import { sshCopy } from "../../lib/i18n/messages/ssh.js";
import SshDetails from "../ssh/SshDetails.jsx";
import SshKeyCard from "../ssh/SshKeyCard.jsx";
import SshResourceList from "../ssh/SshResourceList.jsx";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import EmptyCategory from "./EmptyCategory.jsx";
import { globalProject } from "./connection-items.js";

const byName = (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/**
 * The SSH keys of Zugänge › SSH/SFTP-Zugänge: search, the key list with the hosts that
 * use each key, and the key card (fingerprint, copy, download, edit, delete).
 */
export default function SshKeysView({
  catalog,
  selectedId,
  select,
  editKey,
  projectFilter,
  projectOptions,
  onProjectFilter,
  canAdd,
}) {
  const [query, setQuery] = useState("");
  const rowRefs = useRef(new Map());
  const searchRef = useRef(null);
  const needle = query.trim().toLocaleLowerCase();
  const owner = projectFilter === globalProject ? "" : projectFilter;
  const keys = [...catalog.keys]
    .filter(
      (key) =>
        (!projectFilter || (key.projectId || "") === owner) &&
        [key.name, catalog.ownerName(key)].some((value) =>
          value?.toLocaleLowerCase().includes(needle),
        ),
    )
    .sort(byName);
  // A key's card waits for the accesses: until they are known it is never shown as
  // unused or deletable.
  const selected = catalog.ready && keys.find((key) => key.id === selectedId);
  if (catalog.keysLoaded && !catalog.keys.length)
    return (
      <EmptyCategory
        icon="shield"
        title={copy.empty.keys.title}
        body={copy.empty.keys.body}
        actions={[
          {
            label: copy.empty.keys.primary,
            onClick: () => editKey({}),
            disabled: !canAdd,
          },
        ]}
      />
    );
  return (
    <div className={["ssh-workspace", selected ? "has-details" : ""].join(" ").trim()}>
      <div className="ssh-list-panel">
        <div className="ssh-list-toolbar">
          <input
            ref={searchRef}
            type="search"
            aria-label={sshCopy.search}
            placeholder={sshCopy.searchKeys}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <AnchoredSelect
            label={copy.filters.project}
            value={projectFilter}
            onChange={onProjectFilter}
            options={[
              { value: "", label: copy.filterAll(copy.filters.project) },
              ...projectOptions,
            ]}
          />
        </div>
        <SshResourceList
          items={keys}
          tab="keys"
          selectedId={selectedId}
          select={select}
          ownerName={catalog.ownerName}
          accesses={catalog.accessesLoaded ? catalog.accesses : null}
          rowRefs={rowRefs}
        />
        {catalog.keysLoaded && !keys.length && (query || projectFilter) && (
          <div className="ssh-empty">
            <p>{sshCopy.noMatches}</p>
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                setQuery("");
                onProjectFilter("");
                searchRef.current?.focus();
              }}
            >
              {sshCopy.resetFilters}
            </button>
          </div>
        )}
      </div>
      {selected && (
        <SshDetails
          key={selected.id}
          close={() => {
            const row = rowRefs.current.get(selected.id);
            select(null);
            requestAnimationFrame(() => row?.focus());
          }}
        >
          <SshKeyCard
            sshKey={{
              ...selected,
              hosts: catalog.accesses
                .filter((access) => access.keyId === selected.id)
                .map(({ id, name }) => ({ id, name })),
            }}
            project={catalog.projectFor(selected)}
            edited={editKey}
            removed={(id) => {
              select(null);
              catalog.setKeys((current) => ({
                keys: current.keys.filter((key) => key.id !== id),
              }));
              requestAnimationFrame(() => searchRef.current?.focus());
            }}
          />
        </SshDetails>
      )}
    </div>
  );
}
