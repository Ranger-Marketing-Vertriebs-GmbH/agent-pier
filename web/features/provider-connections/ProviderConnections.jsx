import React, { useState } from "react";
import Modal from "../../components/Modal.jsx";
import AsyncForm from "../../components/AsyncForm.jsx";
import Icon from "../../components/Icon.jsx";
import api from "../../lib/api.js";
import { names } from "../../lib/providers.js";
import { connectionCopy as copy } from "../../lib/i18n/messages/connections.js";
import ConnectionDialog from "./ConnectionDialog.jsx";
import "./connections.css";
function endpointHost(connection) {
  const url = connection.endpoint?.openaiBaseUrl || connection.endpoint?.anthropicBaseUrl;
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
function connectionSummary(connection) {
  return [
    copy.providerNames[connection.providerId] || connection.providerId,
    endpointHost(connection),
    connection.hasSecret
      ? copy.keySaved
      : connection.launchable
        ? copy.keyNotRequired
        : copy.keyMissing,
  ].filter(Boolean);
}
export default function ProviderConnections({ connections = [], refresh }) {
  const [editing, setEditing] = useState(null),
    [removing, setRemoving] = useState(null);
  return (
    <section className="provider-connections">
      <header className="page-heading">
        <div>
          <h2>{copy.title}</h2>
          <p>{copy.description}</p>
        </div>
        <button className="button primary" onClick={() => setEditing({})}>
          <Icon name="plus" />
          {copy.add}
        </button>
      </header>
      {!connections.length && <p className="field-description">{copy.empty}</p>}
      {connections.map((connection) => (
        <article className="provider-connection-card" key={connection.id}>
          <div>
            <h3>{connection.name}</h3>
            <p>{connectionSummary(connection).join(" · ")}</p>
            <p>
              {copy.compatible}:{" "}
              {connection.tools.map((tool) => names[tool]).join(", ") ||
                copy.noCompatible}
            </p>
          </div>
          <div className="account-actions">
            <button
              className="icon-button"
              aria-label={copy.editNamed(connection.name)}
              onClick={() => setEditing(connection)}
            >
              <Icon name="edit" size={16} />
            </button>
            <button
              className="icon-button"
              aria-label={copy.deleteNamed(connection.name)}
              onClick={() => setRemoving(connection)}
            >
              <Icon name="trash" size={16} />
            </button>
          </div>
        </article>
      ))}
      {editing && (
        <ConnectionDialog
          connection={editing.id ? editing : null}
          close={() => setEditing(null)}
          saved={refresh}
        />
      )}
      {removing && (
        <Modal title={copy.delete} close={() => setRemoving(null)}>
          <AsyncForm
            close={() => setRemoving(null)}
            button={copy.delete}
            danger
            submit={async () => {
              await api(
                `/provider-connections/${encodeURIComponent(removing.id)}`,
                "DELETE",
              );
              await refresh();
              setRemoving(null);
            }}
          >
            <p>{copy.deleteConfirm(removing.name)}</p>
          </AsyncForm>
        </Modal>
      )}
    </section>
  );
}
