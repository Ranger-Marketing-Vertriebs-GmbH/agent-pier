import React, { useId, useState } from "react";
import Segment from "../../../components/Segment.jsx";
import { mcpOAuthCopy } from "../../../lib/i18n/messages/mcp-oauth.js";
import { mcpServerCopy } from "../../../lib/i18n/messages/mcp-servers.js";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";
import FieldError from "../FieldError.jsx";
import NameField from "../NameField.jsx";
import { fieldErrors } from "../field-errors.js";
import { addressWarnings } from "./setting-hints.js";
import { guessTransport } from "./wizard-state.js";
import WizardStep from "./WizardStep.jsx";

const signIns = ["headers", "oauth", "none"];
const authRowOf = (headers) =>
  headers.find((row) => row.key === "auth") ?? {
    key: "auth",
    name: "Authorization",
    value: "",
    bearer: true,
  };

export default function RemoteStep({ state, dispatch, go, headingRef }) {
  const formId = useId();
  const { draft, fieldError } = state;
  const set = (key) => (value) => dispatch({ type: "set", key, value });
  const { errorId, errorOf, describe } = fieldErrors(formId, fieldError);
  const [changing, setChanging] = useState(false);
  const [guessed, setGuessed] = useState(false);
  const authRow = authRowOf(draft.headers);
  const setAuthRow = (change) =>
    set("headers")([
      { ...authRow, ...change },
      ...draft.headers.filter((row) => row.key !== "auth"),
    ]);
  return (
    <WizardStep
      title={copy.remote.title}
      headingRef={headingRef}
      primary={{ label: copy.continue }}
      onSubmit={() => {
        // The sign-in header exists only with API key sign-in; its row is written
        // even when the owner kept the preset name and typed nothing yet.
        const others = draft.headers.filter((row) => row.key !== "auth");
        set("headers")(draft.signIn === "headers" ? [authRow, ...others] : others);
        go("settings");
      }}
    >
      <NameField
        id={`${formId}-name`}
        value={draft.name}
        onChange={set("name")}
        error={errorOf("name")}
        errorId={errorId}
      />
      <div className="mcp-field">
        <label htmlFor={`${formId}-url`}>{mcpServerCopy.urlLabel}</label>
        <input
          id={`${formId}-url`}
          type="url"
          required
          value={draft.url}
          placeholder="https://example.com/mcp"
          autoCapitalize="none"
          spellCheck={false}
          {...describe("url")}
          onChange={(event) => set("url")(event.target.value)}
          onBlur={() => {
            if (changing) return;
            const guess = guessTransport(draft.url);
            setGuessed(guess === "sse");
            if (guess !== draft.transport) set("transport")(guess);
          }}
        />
        <FieldError id={errorId} text={errorOf("url")} />
        {addressWarnings(draft.url).map((warning) => (
          <p key={warning} className="mcp-warning">
            {warning === "insecure" ? copy.remote.insecure : copy.remote.tokenInQuery}
          </p>
        ))}
      </div>
      <div className="mcp-field">
        <span>{copy.remote.connection(mcpServerCopy.transports[draft.transport])}</span>
        {guessed && !changing && (
          <small className="mcp-hint">{copy.remote.guessed}</small>
        )}
        {changing ? (
          <Segment
            label={mcpServerCopy.transportLabel}
            value={draft.transport}
            onChange={set("transport")}
            options={["http", "sse"].map((value) => ({
              value,
              label: mcpServerCopy.transports[value],
            }))}
          />
        ) : (
          <button type="button" className="button text" onClick={() => setChanging(true)}>
            {copy.remote.change}
          </button>
        )}
        {draft.transport === "sse" && (
          <small className="mcp-hint">{copy.remote.sseNote}</small>
        )}
      </div>
      <fieldset className="mcp-wizard-cards">
        <legend>{copy.remote.signIn}</legend>
        {signIns.map((kind) => (
          <label key={kind} className="mcp-wizard-card">
            <input
              type="radio"
              name={`${formId}-sign-in`}
              checked={draft.signIn === kind}
              onChange={() => set("signIn")(kind)}
            />
            <span className="mcp-wizard-card-title">{copy.remote.signIns[kind]}</span>
            <small className="mcp-hint">{copy.remote.signInHints[kind]}</small>
          </label>
        ))}
      </fieldset>
      {draft.signIn === "headers" && (
        <div className="mcp-wizard-auth">
          <label>
            {copy.remote.headerName}
            <input
              value={authRow.name}
              required
              autoCapitalize="none"
              spellCheck={false}
              onChange={(event) => setAuthRow({ name: event.target.value })}
            />
          </label>
          <label>
            {copy.remote.token}
            <input
              type="password"
              autoComplete="new-password"
              value={authRow.value}
              maxLength={16384}
              onChange={(event) => setAuthRow({ value: event.target.value })}
            />
          </label>
          <label className="mcp-check">
            <input
              type="checkbox"
              checked={authRow.bearer === true}
              onChange={(event) => setAuthRow({ bearer: event.target.checked })}
            />
            <span>{copy.remote.bearer}</span>
          </label>
        </div>
      )}
      {draft.signIn === "oauth" && (
        <details className="mcp-advanced" open={Boolean(draft.oauthScope)}>
          <summary>{mcpOAuthCopy.advanced}</summary>
          <label>
            {mcpOAuthCopy.scopeLabel}
            <input
              value={draft.oauthScope}
              maxLength={512}
              autoCapitalize="none"
              spellCheck={false}
              onChange={(event) => set("oauthScope")(event.target.value)}
            />
          </label>
          <small className="mcp-hint">{mcpOAuthCopy.scopeHint}</small>
        </details>
      )}
    </WizardStep>
  );
}
