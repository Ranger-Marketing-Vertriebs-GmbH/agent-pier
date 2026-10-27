import React, { useId, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import ListCard from "../../components/ListCard.jsx";
import { ToggleRow } from "../../components/ListRow.jsx";
import Modal from "../../components/Modal.jsx";
import SaveBar from "../../components/SaveBar.jsx";
import Segmented from "../../components/Segmented.jsx";
import api from "../../lib/api.js";
import { mailCopy as copy } from "../../lib/i18n/messages/mail.js";
import MailTestResult from "./MailTestResult.jsx";
import {
  accountBody,
  formValues,
  isDirty,
  mailSecurities,
  mailSides,
  needsPlaintext,
  passwordRequired,
  saveBlocker,
  testBody,
  withPreset,
} from "./mail-account-form.js";
import "./mail.css";

function Field({ label, hint, children }) {
  const id = useId();
  return (
    <div className="mail-field">
      <label htmlFor={id}>{label}</label>
      {React.cloneElement(children, {
        id,
        ...(hint ? { "aria-describedby": `${id}-hint` } : {}),
      })}
      {hint && (
        <small id={`${id}-hint`} className="mail-hint">
          {hint}
        </small>
      )}
    </div>
  );
}

/**
 * Add or edit an email account in a dialog with a save bar. The saved password is
 * never shown: editing leaves it empty, and it is required again only when an IMAP or
 * SMTP server, port, security or the provider changes (the server binds it to them).
 * "Test connection" signs in with the typed values before anything is saved.
 */
export default function MailAccountForm({ account = null, close, saved }) {
  const [initial] = useState(() => formValues(account));
  const [values, setValues] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState(null);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);
  const [testError, setTestError] = useState("");
  const gmail = values.preset === "gmail";
  const required = passwordRequired(values, account);
  const blocker = saveBlocker(values, account);
  const dirty = isDirty(values, initial);
  const update = (next) => {
    setValues(next);
    setResult(null);
    setTestError("");
    setOutcome(null);
  };
  const set = (field, value) => update({ ...values, [field]: value });
  const setSide = (side, field, value) =>
    update({ ...values, [side]: { ...values[side], [field]: value } });
  const submit = async () => {
    // Enter in a field submits too: nothing to save without a change.
    if (blocker || busy || !dirty) return;
    setBusy(true);
    setOutcome(null);
    try {
      const body = accountBody(values, { editing: Boolean(account), initial });
      const stored = account
        ? await api(`/mail/accounts/${encodeURIComponent(account.id)}`, "PATCH", body)
        : await api("/mail/accounts", "POST", body);
      saved(stored);
    } catch (error) {
      setOutcome({ status: "error", error: { message: error.message } });
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setTesting(true);
    setResult(null);
    setTestError("");
    try {
      setResult(await api("/mail/test", "POST", testBody(values, account)));
    } catch (error) {
      setTestError(error.message);
    } finally {
      setTesting(false);
    }
  };
  const text = (side, field, type = "text") => (
    <input
      required
      type={type}
      value={values[side][field]}
      min={type === "number" ? 1 : undefined}
      max={type === "number" ? 65535 : undefined}
      onChange={(event) => setSide(side, field, event.target.value)}
    />
  );
  return (
    <Modal
      title={account ? copy.edit : copy.add}
      close={() => {
        if (!busy) close();
      }}
      closeDisabled={busy}
      footer={null}
    >
      <form
        className="mail-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <fieldset disabled={busy}>
          <div className="mail-field">
            <span aria-hidden="true">{copy.provider}</span>
            <Segmented
              label={copy.provider}
              value={values.preset}
              onChange={(preset) => update(withPreset(values, preset))}
              options={["gmail", "generic"].map((value) => ({
                value,
                label: copy.providers[value],
              }))}
            />
          </div>
          {gmail && <p className="mail-hint">{copy.gmailHint}</p>}
          <Field label={copy.name}>
            <input
              required
              maxLength={100}
              value={values.name}
              onChange={(event) => set("name", event.target.value)}
            />
          </Field>
          <Field label={copy.address}>
            <input
              required
              type="email"
              autoComplete="off"
              maxLength={320}
              value={values.address}
              onChange={(event) => set("address", event.target.value)}
            />
          </Field>
          <Field label={copy.displayName} hint={copy.displayNameHint}>
            <input
              maxLength={100}
              value={values.displayName}
              onChange={(event) => set("displayName", event.target.value)}
            />
          </Field>
          <Field label={copy.username} hint={copy.usernameHint}>
            <input
              autoComplete="off"
              maxLength={320}
              placeholder={values.address}
              value={values.username}
              onChange={(event) => set("username", event.target.value)}
            />
          </Field>
          <Field
            label={gmail ? copy.appPassword : copy.password}
            hint={account ? (required ? copy.passwordAgain : copy.passwordKeep) : null}
          >
            <input
              type="password"
              autoComplete="new-password"
              required={required}
              value={values.password}
              onChange={(event) => set("password", event.target.value)}
            />
          </Field>
          {mailSides.map((side) => (
            <div key={side} className="mail-server">
              <div className="mail-server-address">
                <Field label={copy.server[side]}>{text(side, "host")}</Field>
                <Field label={copy.port[side]}>{text(side, "port", "number")}</Field>
              </div>
              <div className="mail-field">
                <span aria-hidden="true">{copy.security[side]}</span>
                <Segmented
                  label={copy.security[side]}
                  value={values[side].security}
                  onChange={(security) => setSide(side, "security", security)}
                  options={mailSecurities.map((value) => ({
                    value,
                    label: copy.securities[value],
                  }))}
                />
              </div>
            </div>
          ))}
          <ListCard label={copy.servers}>
            <ToggleRow
              label={copy.saveSent}
              sub={copy.saveSentHint}
              checked={values.saveSent}
              onChange={(value) => set("saveSent", value)}
            />
            {needsPlaintext(values) && (
              <ToggleRow
                label={copy.allowPlaintext}
                sub={copy.plaintextWarning}
                checked={values.allowPlaintext}
                onChange={(value) => set("allowPlaintext", value)}
              />
            )}
          </ListCard>
          <div className="mail-test">
            <button
              type="button"
              className="button secondary"
              disabled={testing || blocker !== null}
              onClick={test}
            >
              {testing ? copy.testing : copy.test}
            </button>
            {testing && <p role="status">{copy.testing}</p>}
            <MailTestResult result={result} />
            <ErrorMessage error={testError} />
          </div>
        </fieldset>
      </form>
      <SaveBar
        draft={{
          dirty,
          saving: busy,
          outcome,
          conflicts: [],
          reset: close,
          reload: close,
        }}
        onSave={submit}
        saveDisabled={blocker !== null}
        note={blocker ? copy.blocked[blocker] : undefined}
      />
    </Modal>
  );
}
