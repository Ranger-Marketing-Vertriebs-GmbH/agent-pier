import React, { useId } from "react";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";
import CommandFields from "../CommandFields.jsx";
import NameField from "../NameField.jsx";
import { fieldErrors } from "../field-errors.js";
import { mapCommand, splitCommandLine } from "./command-mapper.js";
import useCommandResolve from "./useCommandResolve.js";
import WizardStep from "./WizardStep.jsx";

const lines = {
  checking: () => copy.command.checking,
  found: (path) => copy.command.found(path),
  missing: () => copy.command.missing,
};

/** What the command field names: a package AgentPier can install, or docker. */
function commandMatch(draft) {
  const words = splitCommandLine(draft.command) ?? [];
  if (!words.length) return { mapped: null, docker: false };
  const mapped = mapCommand(words[0], [...words.slice(1), ...(draft.argRows ?? [])]);
  return {
    mapped: mapped.kind === "command" ? null : mapped,
    docker: mapped.warnings.some((note) => note.code === "docker"),
  };
}

export default function OwnCommandStep({ state, dispatch, go, headingRef }) {
  const formId = useId();
  const { draft, fieldError } = state;
  const set = (key) => (value) => dispatch({ type: "set", key, value });
  const { errorId, errorOf, describe } = fieldErrors(formId, fieldError);
  const resolved = useCommandResolve(draft.command);
  const line = lines[resolved.state];
  const { mapped, docker } = commandMatch(draft);
  const switchToPackage = () => {
    dispatch({
      type: "switchToPackage",
      values: {
        registry: mapped.kind,
        packageName: mapped.packageName,
        packageVersion: mapped.version,
        argRows: mapped.args,
        hints: mapped.program ? { program: mapped.program } : {},
      },
    });
    go("package");
  };
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
      {mapped && (
        <div className="mcp-wizard-notice mcp-wizard-switch" role="status">
          <p>{copy.command.looksLikePackage}</p>
          <button type="button" className="button secondary" onClick={switchToPackage}>
            {copy.command.switchToPackage}
          </button>
        </div>
      )}
      {docker && <p className="mcp-warning">{copy.command.docker}</p>}
    </WizardStep>
  );
}
