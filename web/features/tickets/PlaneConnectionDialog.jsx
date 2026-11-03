import React from "react";
import AsyncForm from "../../components/AsyncForm.jsx";
import Modal from "../../components/Modal.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import api from "../../lib/api.js";
import { planeConnectionsCopy as copy } from "../../lib/i18n/messages/tickets.js";

/**
 * Add or edit a Plane connection. The API key is sent only when typed: editing with a
 * blank key keeps the saved one, and the key never comes back from the server.
 */
export default function PlaneConnectionDialog({ connection, close, saved }) {
  return (
    <Modal
      title={connection ? copy.edit : copy.add}
      close={close}
      dismissOnBackdrop={false}
    >
      <AsyncForm
        close={close}
        button={commonCopy.save}
        submit={async (form) => {
          const body = {
            name: form.get("name")?.trim(),
            baseUrl: form.get("baseUrl")?.trim(),
            workspaceSlug: form.get("workspaceSlug")?.trim(),
          };
          const token = form.get("token");
          if (token) body.token = token;
          const result = await api(
            connection
              ? `/ticket-connections/${encodeURIComponent(connection.id)}`
              : "/ticket-connections",
            connection ? "PUT" : "POST",
            body,
          );
          saved(result.connection);
          close();
        }}
      >
        <label>
          {copy.name}
          <input
            name="name"
            required
            autoFocus
            maxLength={100}
            defaultValue={connection?.name || ""}
            placeholder={copy.namePlaceholder}
          />
        </label>
        <label>
          {copy.apiUrl}
          <input
            name="baseUrl"
            required
            defaultValue={connection?.baseUrl || "https://api.plane.so"}
            autoCapitalize="none"
            spellCheck={false}
          />
        </label>
        <p className="field-description">{copy.apiUrlHelp}</p>
        <label>
          {copy.workspace}
          <input
            name="workspaceSlug"
            required
            maxLength={48}
            defaultValue={connection?.workspaceSlug || ""}
            autoCapitalize="none"
            spellCheck={false}
          />
        </label>
        <p className="field-description">{copy.workspaceHelp}</p>
        <label>
          {copy.apiKey}
          <input
            name="token"
            type="password"
            required={!connection?.hasSecret}
            autoComplete="new-password"
            spellCheck={false}
            placeholder={connection?.hasSecret ? copy.apiKeyKeep : copy.apiKeyPlaceholder}
          />
        </label>
        <p className="field-description">
          {connection?.hasSecret ? copy.apiKeyKeep : copy.apiKeyHelp}
        </p>
      </AsyncForm>
    </Modal>
  );
}
