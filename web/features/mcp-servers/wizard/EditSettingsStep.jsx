import React from "react";
import { mcpServerCopy as copy } from "../../../lib/i18n/messages/mcp-servers.js";
import { mcpWizardCopy } from "../../../lib/i18n/messages/mcp-wizard.js";
import AccountDetail, { AccountSaveBar } from "../../accounts/AccountDetail.jsx";
import McpSecretRows from "../McpSecretRows.jsx";
import { fieldErrors } from "../field-errors.js";
import McpServerConfirmations from "./McpServerConfirmations.jsx";
import useMcpServerForm from "./useMcpServerForm.js";
import "../mcp-servers.css";

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
