import React from "react";
import { mcpServerCopy as copy } from "../../lib/i18n/messages/mcp-servers.js";
import FieldError from "./FieldError.jsx";

/** Command, and optionally arguments and working directory, of an own-command server. */
export default function CommandFields({
  formId,
  values,
  set,
  errorOf,
  describe,
  errorId,
  showCommand = true,
  showArgs = true,
  resolved = null,
}) {
  const text = (key) => (event) => set(key)(event.target.value);
  return (
    <>
      {showCommand && (
        <div className="mcp-field">
          <label htmlFor={`${formId}-command`}>{copy.commandLabel}</label>
          <input
            id={`${formId}-command`}
            value={values.command}
            required
            autoCapitalize="none"
            spellCheck={false}
            {...describe("command")}
            onChange={text("command")}
          />
          <FieldError id={errorId} text={errorOf("command")} />
          {resolved || <small className="mcp-hint">{copy.commandHint}</small>}
        </div>
      )}
      {showArgs && (
        <>
          <label>
            {copy.argsLabel}
            <textarea
              rows={3}
              value={values.args}
              autoCapitalize="none"
              spellCheck={false}
              {...describe("args")}
              onChange={text("args")}
            />
            <FieldError id={errorId} text={errorOf("args")} />
          </label>
          <label>
            {copy.cwdLabel}
            <input
              value={values.cwd}
              autoCapitalize="none"
              spellCheck={false}
              {...describe("cwd")}
              onChange={text("cwd")}
            />
            <FieldError id={errorId} text={errorOf("cwd")} />
          </label>
        </>
      )}
    </>
  );
}
