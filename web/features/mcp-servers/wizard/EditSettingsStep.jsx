import React, { useEffect, useState } from "react";
import { mcpServerCopy as copy } from "../../../lib/i18n/messages/mcp-servers.js";
import { mcpWizardCopy } from "../../../lib/i18n/messages/mcp-wizard.js";
import AccountDetail, { AccountSaveBar } from "../../accounts/AccountDetail.jsx";
import McpSecretRows from "../McpSecretRows.jsx";
import { fieldErrors } from "../field-errors.js";
import McpServerConfirmations from "./McpServerConfirmations.jsx";
import { directoryApi } from "./directory-api.js";
import useMcpServerForm from "./useMcpServerForm.js";
import "../mcp-servers.css";

/**
 * The names the directory entry a server came from marks required, for the option the
 * server runs (its package registry, else a remote). Opening the edit step is the owner
 * action that asks; a failure marks nothing.
 */
function useRequiredNames(server) {
  const [requiredNames, setRequiredNames] = useState([]);
  const origin = server.directoryOrigin?.name;
  const registry = server.source?.registry;
  const stdio = server.transport === "stdio";
  useEffect(() => {
    setRequiredNames([]);
    if (!origin) return undefined;
    let live = true;
    directoryApi.detail(origin).then(
      (entry) => {
        if (!live) return;
        const options = Array.isArray(entry?.options) ? entry.options : [];
        const option = registry
          ? options.find((item) => item.kind === registry)
          : options.find((item) => item.kind?.startsWith("remote-"));
        const inputs = (stdio ? option?.env : option?.headers) ?? [];
        setRequiredNames(inputs.filter((item) => item.required).map((item) => item.name));
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [origin, registry, stdio]);
  return requiredNames;
}

/** Edit "Settings": stored names with Replace / Remove, new rows; values never shown. */
export default function EditSettingsStep(props) {
  const {
    server,
    form,
    draft,
    barDraft,
    set,
    fieldError,
    formId,
    formRef,
    programChoice,
  } = useMcpServerForm(props);
  const { errorId, errorOf } = fieldErrors(formId, fieldError);
  const stdio = server.transport === "stdio";
  const oauth = !stdio && draft.values.auth === "oauth";
  const requiredNames = useRequiredNames(server);
  return (
    <AccountDetail
      title={server.name}
      bar={
        <AccountSaveBar
          form={form}
          draft={barDraft}
          formRef={formRef}
          saveLabel={mcpWizardCopy.edit.save}
          saveFocusKey="mcp-form-save"
        />
      }
    >
      <form
        id={formId}
        ref={formRef}
        className="accounts-detail-group mcp-form"
        onSubmit={(event) => {
          event.preventDefault();
          form.save();
        }}
      >
        <fieldset disabled={draft.saving && !draft.confirmation}>
          {oauth ? (
            <p className="mcp-hint">{mcpWizardCopy.overview.noSettings}</p>
          ) : (
            <McpSecretRows
              label={stdio ? copy.envLabel : copy.headersLabel}
              rows={stdio ? draft.values.env : draft.values.headers}
              onChange={set(stdio ? "env" : "headers")}
              error={errorOf(stdio ? "env" : "headers")}
              invalidNames={fieldError?.names}
              requiredNames={requiredNames}
              errorId={errorId}
            />
          )}
          <p className="mcp-hint">{copy.secretNote}</p>
          <p className="mcp-hint">{copy.secretPlacement}</p>
        </fieldset>
      </form>
      <McpServerConfirmations
        server={server}
        draft={draft}
        programChoice={programChoice}
      />
    </AccountDetail>
  );
}
