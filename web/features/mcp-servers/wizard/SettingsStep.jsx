import React, { useId, useState } from "react";
import LearnMore from "../../../components/LearnMore.jsx";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";
import FieldError from "../FieldError.jsx";
import TimeoutFields from "../TimeoutFields.jsx";
import { placeholderInvalid } from "../agent-placeholders.js";
import { fieldErrors } from "../field-errors.js";
import SettingRow from "./SettingRow.jsx";
import { settingHints, settingProblem } from "./setting-hints.js";
import WizardStep from "./WizardStep.jsx";

const newKey = () => `row-${Math.random().toString(36).slice(2)}`;
// The sign-in header is typed on the remote step; it stays out of this list.
const authKey = "auth";

function Arguments({ draft, set, errorOf, describe, errorId, tried }) {
  const rows = draft.argRows;
  const write = (next) => set("argRows")(next);
  const count = rows.filter(Boolean).length;
  // A pasted argument that could not be taken over stays a row until it has a value.
  const missing = (value) => draft.hints.argsRequired === true && !value.trim();
  const unfilled = rows.some(missing);
  const wrongArg = (value) => placeholderInvalid(value, { prefix: true });
  const wrongArgs = tried && rows.some(wrongArg);
  const wrongCwd = tried && placeholderInvalid(draft.cwd.trim());
  // A problem opens the section; once open it stays open while the owner fixes it.
  const [shown, setShown] = useState(false);
  const forced = Boolean(
    errorOf("args") || errorOf("cwd") || unfilled || wrongArgs || wrongCwd,
  );
  return (
    <details
      className="mcp-advanced"
      open={forced || shown}
      onToggle={(event) => setShown(event.currentTarget.open)}
    >
      <summary>
        {copy.settings.argsTitle} · {count || copy.settings.argsNone}
      </summary>
      <p className="mcp-hint">{copy.settings.argsHint}</p>
      {rows.map((value, index) => (
        <div className="mcp-row" key={index}>
          <input
            aria-label={copy.settings.argument(index + 1)}
            value={value}
            maxLength={16384}
            autoCapitalize="none"
            spellCheck={false}
            {...describe("args")}
            aria-invalid={tried && (missing(value) || wrongArg(value)) ? true : undefined}
            onChange={(event) =>
              write(rows.map((item, at) => (at === index ? event.target.value : item)))
            }
          />
          <button
            type="button"
            className="button secondary"
            aria-label={copy.settings.removeArgument(index + 1)}
            onClick={() => write(rows.filter((_, at) => at !== index))}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      ))}
      {tried && unfilled && (
        <p role="alert" className="mcp-field-error">
          {copy.settings.argumentRequired}
        </p>
      )}
      {wrongArgs && (
        <p role="alert" className="mcp-field-error">
          {copy.settings.argumentPlaceholder}
        </p>
      )}
      <button
        type="button"
        className="button secondary"
        onClick={() => write([...rows, ""])}
      >
        {copy.settings.addArgument}
      </button>
      <FieldError id={errorId} text={errorOf("args")} />
      <label>
        {copy.settings.cwd}
        <input
          value={draft.cwd}
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={wrongCwd ? true : undefined}
          {...describe("cwd")}
          onChange={(event) => set("cwd")(event.target.value)}
        />
      </label>
      <button
        type="button"
        className="button secondary compact"
        aria-pressed={draft.cwd === "{agent.workspace}"}
        onClick={() => set("cwd")("{agent.workspace}")}
      >
        {copy.settings.useWorkspaceCwd}
      </button>
      <FieldError id={errorId} text={errorOf("cwd")} />
      {wrongCwd && (
        <p role="alert" className="mcp-field-error">
          {copy.settings.cwdPlaceholder}
        </p>
      )}
      {draft.cwd.trim() && <small className="mcp-hint">{copy.settings.cwdNote}</small>}
    </details>
  );
}

/**
 * "Settings for <name>": env rows for a local server, header rows for a remote one,
 * and the advanced timeouts of either.
 */
export default function SettingsStep({ state, dispatch, go, headingRef }) {
  const formId = useId();
  const { draft, path, fieldError } = state;
  const stdio = draft.transport === "stdio";
  const kind = stdio ? "env" : "header";
  const key = stdio ? "env" : "headers";
  // Only API key sign-in sends headers; the other sign-ins save none.
  const editable = stdio || draft.signIn === "headers";
  const all = draft[key];
  const rows = all.filter((row) => stdio || row.key !== authKey);
  const hints = settingHints(draft.hints);
  const set = (field) => (value) => dispatch({ type: "set", key: field, value });
  const { errorId, errorOf, describe } = fieldErrors(formId, fieldError);
  const [tried, setTried] = useState(false);
  const problems = Object.fromEntries(
    rows.map((row) => [
      row.key,
      settingProblem(row, {
        kind,
        required: hints[row.name.trim()]?.required === true,
        rows: all,
      }),
    ]),
  );
  // A missing required value is named once the owner tries to continue.
  const visible = (problem) => (problem === "requiredEmpty" && !tried ? null : problem);
  const write = (next) => set(key)(next);
  const patch = (rowKey, change) =>
    write(all.map((row) => (row.key === rowKey ? { ...row, ...change } : row)));
  const refused = errorOf("env") || errorOf("headers");
  return (
    <WizardStep
      title={copy.settings.title(draft.name)}
      headingRef={headingRef}
      primary={{ label: copy.continue }}
      onSubmit={() => {
        setTried(true);
        const argsMissing =
          stdio &&
          draft.hints.argsRequired === true &&
          draft.argRows.some((a) => !a.trim());
        // Agent placeholders the server would refuse stop here, at their field.
        const argsWrong =
          stdio &&
          (draft.argRows.some((a) => placeholderInvalid(a, { prefix: true })) ||
            placeholderInvalid(draft.cwd.trim()));
        if (
          !argsMissing &&
          !argsWrong &&
          (!editable || !Object.values(problems).some(Boolean))
        )
          go(path === "package" ? "install" : "review");
      }}
    >
      <p className="mcp-hint">
        {stdio
          ? copy.settings.intro
          : editable
            ? copy.settings.headersIntro
            : copy.settings.noHeaders}
      </p>
      {stdio && (
        <LearnMore
          hint={copy.settings.placeholdersHint}
          label={copy.settings.placeholdersLabel}
        >
          <p className="mcp-hint">{copy.settings.placeholdersFolders}</p>
          <p className="mcp-hint">{copy.settings.placeholdersPerAgent}</p>
          <p className="mcp-hint">{copy.settings.placeholdersClis}</p>
        </LearnMore>
      )}
      {refused && (
        <p id={errorId} role="alert" className="mcp-field-error">
          {refused}
        </p>
      )}
      {editable && (
        <>
          <div className="mcp-setting-list">
            {rows.map((row) => (
              <SettingRow
                key={row.key}
                row={row}
                hint={hints[row.name.trim()] ?? {}}
                kind={kind}
                problem={
                  visible(problems[row.key]) ||
                  (fieldError?.names?.includes(row.name.trim())
                    ? fieldError.code !== "MCP_SERVER_PLACEHOLDER"
                      ? "reference"
                      : stdio
                        ? "placeholder"
                        : "placeholderRemote"
                    : null)
                }
                onChange={(change) => patch(row.key, change)}
                onRemove={() => write(all.filter((item) => item.key !== row.key))}
              />
            ))}
          </div>
          <button
            type="button"
            className="button secondary"
            onClick={() => write([...all, { key: newKey(), name: "", value: "" }])}
          >
            {stdio ? copy.settings.add : copy.settings.addHeader}
          </button>
        </>
      )}
      {stdio && (
        <Arguments
          draft={draft}
          set={set}
          errorOf={errorOf}
          describe={describe}
          errorId={errorId}
          tried={tried}
        />
      )}
      <TimeoutFields
        formId={formId}
        values={draft}
        set={set}
        errorOf={errorOf}
        describe={describe}
        errorId={errorId}
      />
    </WizardStep>
  );
}
