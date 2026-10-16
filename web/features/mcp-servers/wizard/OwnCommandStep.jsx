import React, { useId } from "react";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";
import CommandFields from "../CommandFields.jsx";
import NameField from "../NameField.jsx";
import { fieldErrors } from "../field-errors.js";
import useCommandResolve from "./useCommandResolve.js";
import WizardStep from "./WizardStep.jsx";

const lines = {
  checking: () => copy.command.checking,
  found: (path) => copy.command.found(path),
  missing: () => copy.command.missing,
};

export default function OwnCommandStep({ state, dispatch, go, headingRef }) {
  const formId = useId();
  const { draft, fieldError } = state;
  const set = (key) => (value) => dispatch({ type: "set", key, value });
  const { errorId, errorOf, describe } = fieldErrors(formId, fieldError);
  const resolved = useCommandResolve(draft.command);
  const line = lines[resolved.state];
  return (
    <WizardStep
      title={copy.command.title}
      headingRef={headingRef}
      primary={{ label: copy.continue, disabled: resolved.state !== "found" }}
      onSubmit={() => go("settings")}
    >
      <NameField
        id={`${formId}-name`}
        value={draft.name}
        onChange={set("name")}
        error={errorOf("name")}
        errorId={errorId}
      />
      <CommandFields
        formId={formId}
        values={draft}
        set={set}
        errorOf={errorOf}
        describe={describe}
        errorId={errorId}
        showArgs={false}
        resolved={
          line && (
            <small
              role="status"
              className={resolved.state === "missing" ? "mcp-field-error" : "mcp-hint"}
            >
              {line(resolved.path)}
            </small>
          )
        }
      />
    </WizardStep>
  );
}
