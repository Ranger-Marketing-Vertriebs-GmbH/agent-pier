import BackupContents, { backupDescription } from "./BackupContents.jsx";
import React, { useId, useState } from "react";
import api from "../../lib/api.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import Modal from "../../components/Modal.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Checkbox from "../../components/Checkbox.jsx";
import { operationsCopy as copy } from "../../lib/i18n/messages/operations.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { PASSPHRASE_MIN, passphraseProblem } from "./backup-form-rules.js";
export default function BackupForm({ close, started }) {
  const historyNote = useId(),
    passphraseErrorId = useId();
  const [includeHistory, setHistory] = useState(true),
    [withCredentials, setCredentials] = useState(false),
    [passphrase, setPassphrase] = useState(""),
    [plan, setPlan] = useState(null),
    // Explained in place instead of the browser's own bubble (docs/ui-guide.md).
    [passphraseError, setPassphraseError] = useState("");
  // History is backed up only encrypted, so it needs the credentials' passphrase.
  const history = includeHistory && withCredentials;
  const action = useAsyncAction(),
    dismiss = () => {
      if (!action.lock.current) close();
    };
  return (
    <Modal title={copy.createBackup} close={dismiss} closeDisabled={action.busy} wide>
      <form
        className="operations-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (plan?.requiresPassphrase) {
            const problem = passphraseProblem(passphrase);
            setPassphraseError(problem);
            if (problem) return event.currentTarget.elements.passphrase?.focus();
          }
          action.run(async () => {
            if (!plan) {
              const result = await api("/operations/backups/plan", "POST", {
                includeHistory: history,
                withCredentials,
              });
              setPlan(result.plan);
              return;
            }
            const result = await api("/operations/backups", "POST", {
              includeHistory: history,
              withCredentials,
              ...(withCredentials ? { passphrase } : {}),
            });
            setPassphrase("");
            started(result.job);
          });
        }}
      >
        <fieldset disabled={action.busy}>
          <Checkbox
            label={copy.includeHistory}
            checked={history}
            disabled={!withCredentials}
            aria-describedby={withCredentials ? undefined : historyNote}
            onChange={(checked) => {
              setHistory(checked);
              setPlan(null);
            }}
          />
          <Checkbox
            label={copy.withCredentials}
            checked={withCredentials}
            onChange={(checked) => {
              setCredentials(checked);
              setPlan(null);
            }}
          />
          <p className="field-description">{copy.backupPrivacy}</p>
          {!withCredentials && (
            <p id={historyNote} className="field-description" role="note">
              {copy.historyNeedsPassphrase}
            </p>
          )}
          {plan && (
            <>
              <h3>{copy.components}</h3>
              <BackupContents values={plan.components} />
              {plan.components.includes("sealed-assistant-credentials") && (
                <p className="field-description">{copy.assistantCredentialsNote}</p>
              )}
              <h3>{copy.omissions}</h3>
              <BackupContents values={plan.omissions} />
              <h3>{copy.consistency}</h3>
              <p>{backupDescription(plan.consistency)}</p>
              {plan.requiresPassphrase && (
                <>
                  <label>
                    {copy.passphrase}
                    <input
                      name="passphrase"
                      type="password"
                      minLength={PASSPHRASE_MIN}
                      required
                      value={passphrase}
                      autoComplete="new-password"
                      aria-invalid={passphraseError ? true : undefined}
                      aria-describedby={passphraseError ? passphraseErrorId : undefined}
                      onChange={(event) => {
                        setPassphrase(event.target.value);
                        if (passphraseError)
                          setPassphraseError(passphraseProblem(event.target.value));
                      }}
                    />
                  </label>
                  <ErrorMessage id={passphraseErrorId} error={passphraseError} />
                </>
              )}
            </>
          )}
        </fieldset>
        <ErrorMessage error={action.error} />
        <div className="operations-actions">
          <button
            type="button"
            className="button secondary"
            disabled={action.busy}
            onClick={dismiss}
          >
            {commonCopy.cancel}
          </button>
          <button className="button primary" disabled={action.busy}>
            {plan ? copy.create : copy.plan}
          </button>
        </div>
      </form>
    </Modal>
  );
}
