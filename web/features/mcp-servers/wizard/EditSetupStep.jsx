import React from "react";
import { mcpServerCopy as copy } from "../../../lib/i18n/messages/mcp-servers.js";
import { mcpWizardCopy } from "../../../lib/i18n/messages/mcp-wizard.js";
import AccountDetail, { AccountSaveBar } from "../../accounts/AccountDetail.jsx";
import CliDropNotes from "../CliDropNotes.jsx";
import CommandFields from "../CommandFields.jsx";
import ConnectionField from "../ConnectionField.jsx";
import FieldError from "../FieldError.jsx";
import McpAuthFields from "../McpAuthFields.jsx";
import McpPackageFields from "../McpPackageFields.jsx";
import NameField from "../NameField.jsx";
import SourceField from "../SourceField.jsx";
import TimeoutFields from "../TimeoutFields.jsx";
import { fieldErrors } from "../field-errors.js";
import McpServerConfirmations from "./McpServerConfirmations.jsx";
import useMcpServerForm from "./useMcpServerForm.js";
import "../mcp-servers.css";
import "./mcp-wizard.css";

/**
 * Edit "Source and name": name, address and sign-in, or command and package source,
 * and the advanced timeouts of either.
 */
export default function EditSetupStep(props) {
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
  const { errorId, errorOf, describe } = fieldErrors(formId, fieldError);
  const values = draft.values;
  const stdio = server.transport === "stdio";
  const packaged = stdio && values.source === "package";
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
          <NameField
            id={`${formId}-name`}
            value={values.name}
            onChange={set("name")}
            error={errorOf("name")}
            errorId={errorId}
            renamed={values.name.trim() !== server.name}
          />
          <ConnectionField transport={server.transport} />
          {stdio ? (
            <>
              <SourceField server={server} values={values} set={set} />
              {packaged && !server.source && (
                <McpPackageFields
                  formId={formId}
                  values={values}
                  set={set}
                  constraintsError={errorOf("packageConstraints")}
                  versionError={errorOf("packageVersion")}
                />
              )}
              <CommandFields
                formId={formId}
                values={values}
                set={set}
                errorOf={errorOf}
                describe={describe}
                errorId={errorId}
                showCommand={!packaged}
              />
            </>
          ) : (
            <>
              <label>
                {copy.urlLabel}
                <input
                  value={values.url}
                  required
                  type="url"
                  autoCapitalize="none"
                  spellCheck={false}
                  {...describe("url")}
                  onChange={(event) => set("url")(event.target.value)}
                />
                <FieldError id={errorId} text={errorOf("url")} />
                <small className="mcp-hint">{copy.urlHint}</small>
              </label>
              <McpAuthFields draft={values} server={server} set={set} />
            </>
          )}
          <TimeoutFields
            formId={formId}
            values={values}
            set={set}
            errorOf={errorOf}
            describe={describe}
            errorId={errorId}
          />
          <CliDropNotes values={values} server={server} />
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
