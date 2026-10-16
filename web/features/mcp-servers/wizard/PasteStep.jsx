import React, { useId, useState } from "react";
import { mcpPackageCopy } from "../../../lib/i18n/messages/mcp-packages.js";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";
import { newestStable } from "../mcp-package-versions.js";
import useMcpPackageVersions from "../useMcpPackageVersions.js";
import NameField from "../NameField.jsx";
import { linkLabel } from "./PackageStep.jsx";
import { PasteIgnored, PasteWarnings } from "./PasteNotes.jsx";
import { parsePaste, pickServer } from "./paste-parser.js";
import { uniqueName } from "./server-name.js";
import WizardStep from "./WizardStep.jsx";

const namePattern = /^[A-Za-z][A-Za-z0-9_-]{0,29}$/;

const errorText = (error) =>
  error.code === "invalidJson"
    ? `${copy.paste.errors.invalidJson} ${copy.paste.position(error.line, error.column)}`
    : copy.paste.errors[error.code];

function sourceLine(draft) {
  if (draft.path === "package")
    return draft.registry === "pypi"
      ? copy.paste.sources.pypi(draft.packageName)
      : copy.paste.sources.npm(draft.packageName);
  if (draft.path === "remote")
    return copy.paste.sources.remote(draft.transport.toUpperCase());
  return copy.paste.sources.command(draft.command);
}

function Found({ server, name, setName, nameError, versions }) {
  const id = useId();
  const { draft } = server;
  const rows = draft.path === "remote" ? draft.headers : draft.env;
  return (
    <section className="mcp-wizard-card-block" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="mcp-wizard-subtitle">
        {copy.paste.foundTitle}
      </h2>
      <NameField
        id={`${id}-name`}
        value={name}
        onChange={setName}
        error={nameError}
        errorId={`${id}-name-error`}
        selfChecked
      />
      <dl className="mcp-details">
        <dt>{copy.paste.source}</dt>
        <dd className="mcp-wizard-mono">{sourceLine(draft)}</dd>
        {draft.argRows?.length > 0 && (
          <>
            <dt>{copy.paste.args}</dt>
            <dd>
              <ul className="mcp-wizard-notes">
                {draft.argRows.map((arg, index) => (
                  <li key={index} className="mcp-wizard-mono">
                    {arg || copy.paste.valueMissing}
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
        <dt>{copy.paste.settings}</dt>
        <dd>
          <ul className="mcp-wizard-notes">
            {rows.map((row) => (
              <li key={row.key}>
                <code className="mcp-wizard-mono">{row.name}</code>
                {" · "}
                {row.value ? copy.paste.valueTaken : copy.paste.valueMissing}
              </li>
            ))}
          </ul>
        </dd>
      </dl>
      <p className="mcp-hint">{copy.paste.secretsNote}</p>
      {draft.path === "package" && versions.publisher && (
        <p className="mcp-hint">
          {copy.package.publishedBy(
            versions.publisher,
            mcpPackageCopy.registries[draft.registry],
          )}
          {versions.repositoryUrl && (
            <>
              {" · "}
              <a href={versions.repositoryUrl} target="_blank" rel="noopener noreferrer">
                {copy.package.sourceLink(linkLabel(versions.repositoryUrl))}
              </a>{" "}
              <small>{copy.package.linkNote}</small>
            </>
          )}
        </p>
      )}
      {draft.path === "package" && <p className="mcp-hint">{copy.paste.reviewNote}</p>}
      <PasteWarnings warnings={server.warnings} />
      <PasteIgnored ignored={server.ignored} />
    </section>
  );
}

/** Paste: the guide's block is read here, in this browser; only a package name is looked up. */
export default function PasteStep({ state, dispatch, go, headingRef, data }) {
  const id = useId();
  const { text, result, index, done = [] } = state.paste;
  const server = result?.ok ? pickServer(result, index, done) : null;
  const taken = (data.mcpServers || []).map((item) => item.name);
  // A name the owner typed for this server is kept; a parsed one is made unique
  // again, since a server saved from this block may hold it by now.
  const freshName = (raw) => (raw ? uniqueName(raw, taken) : "");
  const applied = Boolean(state.path) && state.paste.applied === index;
  const [name, setNameValue] = useState(() =>
    applied ? state.draft.name : freshName(server?.name),
  );
  const [nameError, setNameError] = useState("");
  const setName = (value) => {
    setNameValue(value);
    setNameError("");
  };
  const draft = server?.draft;
  const versions = useMcpPackageVersions(
    draft?.path === "package" ? draft.registry : "npm",
    draft?.path === "package" ? draft.packageName : "",
  );
  const read = () => {
    const next = parsePaste(text, { taken });
    dispatch({ type: "pasteResult", result: next, index: 0 });
    setName(next.ok ? (next.servers[0]?.name ?? "") : "");
  };
  const choose = (next) => {
    dispatch({ type: "pasteResult", result, index: next });
    setName(freshName(result.servers[next].name));
  };
  const proceed = () => {
    const trimmed = name.trim();
    const problem = !namePattern.test(trimmed)
      ? copy.paste.errors.nameInvalid
      : taken.includes(trimmed)
        ? copy.paste.errors.nameTaken
        : "";
    if (problem) return setNameError(problem);
    if (applied) {
      // Back from a later step: keep what was typed there, change the name only.
      dispatch({ type: "set", key: "name", value: trimmed });
      go(
        state.path === "package" && !state.draft.packageVersion ? "package" : "settings",
      );
      return;
    }
    const values = { ...draft, name: trimmed };
    // No exact version in the guide: the newest stable one, pinned when installing.
    if (values.path === "package" && !values.packageVersion && versions.versions.length)
      values.packageVersion = newestStable(versions);
    dispatch({ type: "pasted", draft: values, index });
    go(values.path === "package" && !values.packageVersion ? "package" : "settings");
  };
  const clipboard = typeof navigator !== "undefined" && navigator.clipboard?.readText;
  return (
    <WizardStep
      title={copy.paste.title}
      headingRef={headingRef}
      primary={draft ? { label: copy.continue } : { label: copy.paste.read }}
      secondary={
        draft
          ? {
              label: copy.paste.editText,
              onClick: () => dispatch({ type: "pasteResult", result: null, index: 0 }),
            }
          : undefined
      }
      onSubmit={draft ? proceed : read}
    >
      {!draft && (
        <>
          <p className="mcp-hint" id={`${id}-helper`}>
            {copy.paste.helper}
          </p>
          <label htmlFor={`${id}-text`}>{copy.paste.label}</label>
          <textarea
            id={`${id}-text`}
            className="mcp-wizard-mono mcp-paste-text"
            rows={12}
            value={text}
            spellCheck={false}
            autoCapitalize="none"
            aria-describedby={`${id}-helper`}
            onChange={(event) =>
              dispatch({ type: "pasteText", text: event.target.value })
            }
          />
          {clipboard && (
            <button
              type="button"
              className="button secondary"
              onClick={async () => {
                try {
                  dispatch({
                    type: "pasteText",
                    text: await navigator.clipboard.readText(),
                  });
                } catch {
                  /* The browser refused; the owner pastes by hand. */
                }
              }}
            >
              {copy.paste.pasteButton}
            </button>
          )}
          {result && !result.ok && (
            <p role="alert" className="mcp-field-error">
              {errorText(result.error)}
            </p>
          )}
        </>
      )}
      {result?.ok && result.servers.length - done.length > 1 && (
        <fieldset className="mcp-wizard-cards">
          <legend>
            {copy.paste.others(server.others.join(", "), server.others.length)}
          </legend>
          {result.servers.map((item, at) =>
            done.includes(at) ? null : (
              <label key={at} className="mcp-wizard-card">
                <input
                  type="radio"
                  name={`${id}-server`}
                  checked={at === index}
                  onChange={() => choose(at)}
                />
                <span className="mcp-wizard-card-title">{item.name || item.key}</span>
              </label>
            ),
          )}
        </fieldset>
      )}
      {server?.refused && (
        <p role="alert" className="mcp-field-error">
          {copy.paste.errors[server.refused]}
        </p>
      )}
      {draft && (
        <Found
          server={server}
          name={name}
          setName={setName}
          nameError={nameError}
          versions={versions}
        />
      )}
    </WizardStep>
  );
}
