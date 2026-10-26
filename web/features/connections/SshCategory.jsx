import React, { useCallback, useMemo, useState } from "react";
import { formatMessageTime } from "../../lib/i18n/index.js";
import { connectionsAreaCopy as copy } from "../../lib/i18n/messages/connections-area.js";
import { sshCopy } from "../../lib/i18n/messages/ssh.js";
import { sshProjectCopy as projectCopy } from "../../lib/i18n/messages/ssh-projects.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import SshAccessForm from "../ssh/SshAccessForm.jsx";
import SshKeyForm from "../ssh/SshKeyForm.jsx";
import SshProjectReassign from "../ssh/SshProjectReassign.jsx";
import UnderlineTabs from "../../components/UnderlineTabs.jsx";
import CategorySection from "./CategorySection.jsx";
import EmptyCategory from "./EmptyCategory.jsx";
import LongList from "./LongList.jsx";
import SshBulkActions from "./SshBulkActions.jsx";
import SshDetailPane from "./SshDetailPane.jsx";
import SshKeysView from "./SshKeysView.jsx";
import { statusTone } from "./SshTestBox.jsx";
import { globalProject, sshItems } from "./connection-items.js";
import { connectionsRoute } from "./routes.js";
import { usePageAction } from "../../app/page-action.js";
import "../ssh/ssh.css";
import "../ssh/ssh-settings.css";

const statuses = ["failed", "hostKey", "untested", "ok"];

/** "Ops-Wache, Rechercheur · 1 Hook · 2 Sessions", "nicht benutzt" or "—". */
export function usedSummary(item) {
  if (!item.usage) return copy.unknownUsage;
  if (item.used === false) return copy.notUsed;
  const agents = [
    ...new Set(
      (item.usage.agents || []).filter((a) => a.via !== "hook").map((a) => a.name),
    ),
  ];
  return [
    agents.length > 2 ? copy.usedSummary.agents(agents.length) : agents.join(", "),
    item.usage.hooks?.length ? copy.usedSummary.hooks(item.usage.hooks.length) : "",
    item.usage.sessions ? copy.usedSummary.sessions(item.usage.sessions) : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The parts of "last used" GET /connections/usage covers, as one sentence. */
export const lastUseNote = (covers) =>
  covers
    ? copy.lastUseCovers(
        covers
          .map((part) => copy.lastUseParts[part])
          .filter(Boolean)
          .join(", "),
      )
    : copy.lastUseUnknown;

/**
 * Zugänge › SSH/SFTP-Zugänge: the long list of accesses with views, filters, groups,
 * bulk actions and the detail pane, or the SSH keys; the add and edit dialogs, the
 * security notes and project reassignment.
 */
export default function SshCategory({
  catalog,
  connectionUsage,
  reloadUsage,
  agentsEnabled,
  assistants,
  navigate,
  narrow,
  list,
  activeId,
  setActiveId,
}) {
  const [view, setView] = useState("accesses");
  // The bulk bar stays while its dialog is open, even when the run emptied the selection.
  const [bulkOpen, setBulkOpen] = useState(false);
  const [keyId, setKeyId] = useState(null);
  const [editing, setEditing] = useState(null);
  const [editingKey, setEditingKey] = useState(null);
  const [reassigning, setReassigning] = useState(false);
  const covers = connectionUsage?.lastUseCovers ?? null;
  const items = useMemo(
    () =>
      sshItems({
        accesses: catalog.accesses,
        usage: connectionUsage,
        ownerName: catalog.ownerName,
      }),
    [catalog.accesses, connectionUsage, catalog.ownerName],
  );
  const groupOf = useCallback(
    (item, groupBy) =>
      groupBy === "status"
        ? {
            key: item.status,
            label: copy.sshStatus[item.status],
            order: statuses.indexOf(item.status),
          }
        : {
            key: item.group.key,
            label: item.group.label,
            order: item.group.key === globalProject ? 0 : 1,
          },
    [],
  );
  const active = catalog.accesses.find((access) => access.id === activeId);
  const selected = catalog.accesses.filter((access) =>
    list.state.selected.includes(access.id),
  );
  const agentNames = new Map();
  for (const item of items)
    for (const agent of item.usage?.agents || []) agentNames.set(agent.id, agent.name);
  const open = (item) =>
    narrow ? navigate(connectionsRoute("ssh", item.id)) : setActiveId(item.id);
  const reloadAll = () => {
    catalog.reloadAccesses();
    reloadUsage();
  };
  // The Project chip scopes both lists and is the owner new accesses and keys start
  // with; a project that is gone takes no new resources.
  const projectFilter = list.state.filters.project || "";
  const owner = projectFilter === globalProject ? "" : projectFilter;
  const ownerAvailable =
    !owner || catalog.projects.some((project) => project.id === owner);
  const ownedKeys = projectFilter
    ? catalog.keys.filter((key) => (key.projectId || "") === owner)
    : catalog.keys;
  const canAdd = catalog.ready && ownerAvailable && ownedKeys.length > 0;
  // ⌘K actions: the keys view, adding a key, adding an access (a key first when none
  // exists yet, as the empty state offers).
  usePageAction("ssh-keys", () => setView("keys"));
  usePageAction(
    "ssh-key-add",
    () => {
      setView("keys");
      if (ownerAvailable) setEditingKey({});
    },
    catalog.ready,
  );
  usePageAction(
    "ssh-add",
    () => {
      setView(canAdd ? "accesses" : "keys");
      if (canAdd) setEditing({});
      else if (ownerAvailable) setEditingKey({});
    },
    catalog.ready,
  );
  const projectOptions = [
    { value: globalProject, label: projectCopy.global },
    ...catalog.ownerProjects.map((p) => ({ value: p.id, label: p.name })),
  ];
  const setProjectFilter = (value) =>
    list.dispatch({ type: "filter", key: "project", value });
  const content =
    view === "keys" ? (
      <SshKeysView
        catalog={catalog}
        projectFilter={projectFilter}
        projectOptions={projectOptions}
        onProjectFilter={setProjectFilter}
        canAdd={catalog.ready && ownerAvailable}
        selectedId={keyId}
        select={setKeyId}
        editKey={setEditingKey}
      />
    ) : catalog.ready && !catalog.accesses.length ? (
      <EmptyCategory
        icon="terminal"
        title={copy.empty.ssh.title}
        body={
          catalog.keys.length
            ? copy.empty.ssh.body
            : `${copy.empty.ssh.body} ${sshCopy.emptyKeys}`
        }
        actions={[
          {
            label: copy.empty.ssh.primary,
            onClick: () => setEditing({}),
            disabled: !canAdd,
          },
          { label: copy.empty.ssh.secondary, onClick: () => setEditingKey({}) },
        ]}
      />
    ) : (
      <div
        className={["connections-list-detail", active ? "has-detail" : ""]
          .join(" ")
          .trim()}
      >
        <LongList
          label={copy.sections.ssh}
          items={items}
          state={list.state}
          dispatch={list.dispatch}
          groupOf={groupOf}
          views={
            covers
              ? ["all", "problems", "unused", "today"]
              : ["all", "problems", "unused"]
          }
          viewNote={lastUseNote(covers)}
          searchPlaceholder={copy.searchSsh}
          filters={[
            {
              key: "project",
              label: copy.filters.project,
              options: projectOptions,
            },
            {
              key: "type",
              label: copy.filters.type,
              options: [
                { value: "ssh", label: sshCopy.typeSsh },
                { value: "sftp", label: sshCopy.typeSftp },
              ],
            },
            {
              key: "agent",
              label: copy.filters.agent,
              options: [...agentNames].map(([value, label]) => ({ value, label })),
            },
            {
              key: "status",
              label: copy.filters.status,
              options: statuses.map((value) => ({ value, label: copy.sshStatus[value] })),
            },
          ]}
          groupOptions={["project", "status", "none"].map((value) => ({
            value,
            label: copy.groupOptions[value],
          }))}
          sortOptions={(covers ? ["name", "changed", "used"] : ["name", "changed"]).map(
            (value) => ({ value, label: copy.sortOptions[value] }),
          )}
          columns={{ type: copy.columns.type, last: copy.columns.last }}
          cells={(item) => ({
            type: item.kind === "sftp" ? sshCopy.typeSftp : sshCopy.typeSsh,
            usedBy: usedSummary(item),
            // Rows of the same name tell their owner and key apart for screen readers.
            description: [
              item.group.label,
              item.record.auth === "password"
                ? sshCopy.signInPassword
                : item.record.keyMissing
                  ? sshCopy.keyDeleted
                  : item.record.keyName,
            ]
              .filter(Boolean)
              .join(", "),
            status: { tone: statusTone[item.status], text: copy.sshStatus[item.status] },
            last: !covers
              ? copy.unknownUsage
              : item.lastUsedAt
                ? formatMessageTime(item.lastUsedAt)
                : copy.never,
          })}
          activeId={activeId}
          onOpen={open}
          bulkOpen={bulkOpen}
          bulk={
            <SshBulkActions
              onOpenChange={setBulkOpen}
              selected={selected}
              usage={connectionUsage}
              assistants={assistants}
              catalog={catalog}
              onDone={reloadAll}
            />
          }
        />
        {active && !narrow && (
          <SshDetailPane
            access={active}
            catalog={catalog}
            usage={
              connectionUsage?.ssh?.[active.id] ?? (connectionUsage ? null : undefined)
            }
            agentsEnabled={agentsEnabled}
            assistants={assistants}
            navigate={navigate}
            reloadUsage={reloadUsage}
            close={() => setActiveId(null)}
            edit={setEditing}
            viewKey={(id) => {
              setView("keys");
              setKeyId(id);
            }}
            removed={(id) => {
              setActiveId(null);
              catalog.setAccesses((current) => ({
                accesses: current.accesses.filter((access) => access.id !== id),
              }));
              reloadUsage();
            }}
          />
        )}
      </div>
    );
  return (
    <CategorySection
      title={copy.sections.ssh}
      count={catalog.ready ? sshCopy.accessCount(catalog.accesses.length) : ""}
      actions={
        // An empty list offers the same actions in its empty state.
        !catalog.ready || (view === "keys" ? catalog.keys : catalog.accesses).length ? (
          <button
            type="button"
            className="button primary compact"
            disabled={view === "keys" ? !catalog.ready || !ownerAvailable : !canAdd}
            onClick={() => (view === "keys" ? setEditingKey({}) : setEditing({}))}
          >
            {view === "keys" ? sshCopy.addKey : sshCopy.add}
          </button>
        ) : null
      }
    >
      {catalog.errors.map((resource, index) => (
        <div key={index} className="ssh-load-error">
          <p role="alert">{resource.error}</p>
          <button className="button secondary" onClick={resource.reload}>
            {commonCopy.retry}
          </button>
        </div>
      ))}
      {!catalog.ready && !catalog.errors.length && <p role="status">{sshCopy.loading}</p>}
      <UnderlineTabs
        label={copy.sections.ssh}
        idPrefix="ssh"
        tabs={[
          { id: "accesses", label: sshCopy.accessesTab, count: catalog.accesses.length },
          { id: "keys", label: sshCopy.keysTab, count: catalog.keys.length },
        ]}
        selected={view}
        onSelect={setView}
      />
      <div
        id={`ssh-tabpanel-${view}`}
        role="tabpanel"
        aria-labelledby={`ssh-tab-${view}`}
      >
        {(view === "keys" ? catalog.keysLoaded : catalog.ready) && content}
      </div>
      <footer className="ssh-settings-footer">
        <details>
          <summary>{sshCopy.securityNotes}</summary>
          <p>{sshCopy.scope}</p>
          <p>{sshCopy.backupHint}</p>
        </details>
        <button
          className="ssh-text-button"
          disabled={
            !catalog.sourceProjects.some((source) =>
              catalog.projects.some((target) => target.id !== source?.id),
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
          projects={catalog.projects}
          projectId={projectFilter ? owner || null : null}
          close={() => setEditingKey(null)}
          saved={(result) => {
            catalog.setKeys((current) => ({
              keys: [
                ...(current?.keys || []).filter((key) => key.id !== result.id),
                result,
              ],
            }));
            setView("keys");
            setKeyId(result.id);
            setEditingKey(null);
          }}
        />
      )}
      {editing && (
        <SshAccessForm
          access={editing.id ? editing : null}
          keys={catalog.keys}
          projects={catalog.projects}
          projectId={projectFilter ? owner || null : null}
          close={() => setEditing(null)}
          saved={(result) => {
            catalog.setAccesses((current) => ({
              accesses: [
                ...(current?.accesses || []).filter((item) => item.id !== result.id),
                result,
              ],
            }));
            setView("accesses");
            // The new access opens beside the list, on phones as its own page.
            if (narrow && !editing.id) navigate(connectionsRoute("ssh", result.id));
            else if (!narrow) setActiveId(result.id);
            setEditing(null);
            reloadUsage();
          }}
        />
      )}
      {reassigning && (
        <SshProjectReassign
          sourceProjects={catalog.sourceProjects}
          targetProjects={catalog.projects}
          close={() => setReassigning(false)}
          reassigned={() => {
            setReassigning(false);
            catalog.reload();
          }}
        />
      )}
    </CategorySection>
  );
}
