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
import { RowMenu, useRowMenu } from "../extensions/RowMenu.jsx";
import PlaneConnectionDialog from "./PlaneConnectionDialog.jsx";

const hostOf = (baseUrl) => {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
};

// What the last check of a connection found, as its row shows it.
function checkView(check) {
  if (!check) return {};
  if (check.state === "checking") return { value: copy.checking };
  if (check.state === "ok")
    return { status: { tone: "ok", text: copy.checkOk(check.count) } };
  return { status: { tone: "error", text: copy.checkFailed }, detail: check.message };
}

function ConnectionRow({ connection, check, onEdit, onCheck, onRemove }) {
  const menu = useRowMenu();
  const { detail, ...trailing } = checkView(check);
  const place = `${connection.workspaceSlug} · ${hostOf(connection.baseUrl)}`;
  return (
    <div className="row-menu-anchor">
      <ListRow
        label={connection.name}
        sub={detail ? `${place} · ${detail}` : place}
        onClick={onEdit}
        chevron={false}
        {...trailing}
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
          { id: "check", label: copy.check, run: onCheck },
          { id: "remove", label: copy.remove, danger: true, run: onRemove },
        ]}
      />
    </div>
  );
}

/**
 * Connections › Ticket sources: the Plane connections (add, edit, check, delete). A row
 * opens its edit dialog; saving checks the connection by listing its Plane projects. `live` is the
 * parent's reader of the `tickets.connections` live topic; the API key never reaches
 * the browser.
 */
export default function PlaneConnectionsPage({ emptyState, onChanged, live }) {
  const [modal, setModal] = useState(null);
  const [removing, setRemoving] = useState(null);
  // Per connection: the last check that reads its Plane projects with the saved key.
  const [checks, setChecks] = useState({});
  const check = (id) => {
    setChecks((current) => ({ ...current, [id]: { state: "checking" } }));
    api(`/ticket-connections/${encodeURIComponent(id)}/projects`)
      .then((result) => ({ state: "ok", count: result.projects?.length || 0 }))
      .catch((error) => ({ state: "error", message: error.message }))
      .then((result) => setChecks((current) => ({ ...current, [id]: result })));
  };
  const connections = live.data?.connections;
  const ready = Array.isArray(connections);
  usePageAction("plane-add", () => setModal({}), ready);
  const shown = ready ? connections : [];
  const empty = ready && !connections.length && emptyState;
  const changed = async (deletedId) => {
    await live.written().catch(() => {});
    onChanged?.(deletedId);
  };
  return (
    <div className="plane-connections">
      <header className="connections-intro">
        <p>{copy.description}</p>
        {!empty && (
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
              check={checks[connection.id]}
              onEdit={() => setModal({ connection })}
              onCheck={() => check(connection.id)}
              onRemove={() => setRemoving(connection)}
            />
          ))}
        </ListCard>
      )}
      {modal && (
        <PlaneConnectionDialog
          connection={modal.connection}
          close={() => setModal(null)}
          // A saved connection is checked at once: a wrong address or key shows here.
          saved={(connection) => {
            changed();
            if (connection?.id) check(connection.id);
          }}
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
