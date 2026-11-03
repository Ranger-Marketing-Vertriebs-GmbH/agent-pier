import React, { useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Icon from "../../components/Icon.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import { usePageAction } from "../../app/page-action.js";
import api from "../../lib/api.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { connectionsAreaCopy } from "../../lib/i18n/messages/connections-area.js";
import { planeConnectionsCopy as copy } from "../../lib/i18n/messages/tickets.js";
import useLiveTopic from "../../lib/live/useLiveTopic.js";
import { RowMenu, useRowMenu } from "../extensions/RowMenu.jsx";
import PlaneConnectionDialog from "./PlaneConnectionDialog.jsx";

const hostOf = (baseUrl) => {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
};

function ConnectionRow({ connection, onEdit, onRemove }) {
  const menu = useRowMenu();
  return (
    <div className="row-menu-anchor">
      <ListRow
        label={connection.name}
        sub={`${connection.workspaceSlug} · ${hostOf(connection.baseUrl)}`}
        menu={{
          label: copy.rowActions(connection.name),
          expanded: menu.open,
          onClick: menu.toggle,
        }}
      />
      <RowMenu
        label={copy.rowActions(connection.name)}
        state={menu}
        items={[
          { id: "edit", label: copy.editRow, run: onEdit },
          { id: "remove", label: copy.remove, danger: true, run: onRemove },
        ]}
      />
    </div>
  );
}

/**
 * Connections › Ticket sources: the Plane connections (add, edit, delete). The list
 * follows the `tickets.connections` live topic, or the `live` reader of a parent that
 * already follows it; the API key never reaches the browser.
 */
export default function PlaneConnectionsPage({
  only,
  emptyState,
  onChanged,
  live: shared,
} = {}) {
  const own = useLiveTopic(shared ? null : "tickets.connections", "/ticket-connections");
  const live = shared ?? own;
  const [modal, setModal] = useState(null);
  const [removing, setRemoving] = useState(null);
  const connections = live.data?.connections;
  const ready = Array.isArray(connections);
  usePageAction("plane-add", () => setModal({}), !only && ready);
  const shown = ready
    ? only
      ? connections.filter((item) => item.id === only)
      : connections
    : [];
  const empty = ready && !connections.length && emptyState;
  const changed = async (deletedId) => {
    await live.written().catch(() => {});
    onChanged?.(deletedId);
  };
  return (
    <div className="page plane-connections-page">
      <header className="page-heading">
        <div>
          <p>{copy.description}</p>
        </div>
        {!only && !empty && (
          <button
            className="button primary"
            disabled={!ready}
            onClick={() => setModal({})}
          >
            <Icon name="plus" />
            {copy.add}
          </button>
        )}
      </header>
      {live.loading && !ready && (
        <p role="status" className="loading">
          {connectionsAreaCopy.loading}
        </p>
      )}
      {live.error && !ready && (
        <div className="repository-load-error">
          <ErrorMessage error={copy.loadFailed} />
          <button className="button secondary" onClick={() => live.refresh()}>
            {commonCopy.retry}
          </button>
        </div>
      )}
      {empty ? emptyState(() => setModal({})) : null}
      {ready && shown.length > 0 && (
        <ListCard label={copy.list}>
          {shown.map((connection) => (
            <ConnectionRow
              key={connection.id}
              connection={connection}
              onEdit={() => setModal({ connection })}
              onRemove={() => setRemoving(connection)}
            />
          ))}
        </ListCard>
      )}
      {modal && (
        <PlaneConnectionDialog
          connection={modal.connection}
          close={() => setModal(null)}
          saved={() => changed()}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={copy.removeTitle(removing.name)}
          body={copy.removeConfirm(removing.name)}
          confirmLabel={copy.remove}
          destructive
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            await api(`/ticket-connections/${encodeURIComponent(removing.id)}`, "DELETE");
            const id = removing.id;
            setRemoving(null);
            await changed(id);
          }}
        />
      )}
    </div>
  );
}
