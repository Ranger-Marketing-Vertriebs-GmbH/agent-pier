import BackupContents, { backupDescription } from "./BackupContents.jsx";
import React, { useState } from "react";
import api from "../../lib/api.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import Modal from "../../components/Modal.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Checkbox from "../../components/Checkbox.jsx";
import { operationsCopy as copy } from "../../lib/i18n/messages/operations.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
export default function BackupForm({ close, started }) {
  const [includeHistory, setHistory] = useState(true),
    [withCredentials, setCredentials] = useState(false),
    [passphrase, setPassphrase] = useState(""),
    [plan, setPlan] = useState(null);
  const action = useAsyncAction(),
    dismiss = () => {
      if (!action.lock.current) close();
    };
  return (
    <Modal title={copy.createBackup} close={dismiss} closeDisabled={action.busy} wide>
      <form
        className="operations-form"
        onSubmit={(event) => {
          event.preventDefault();
          action.run(async () => {
            if (!plan) {
              const result = await api("/operations/backups/plan", "POST", {
                includeHistory,
                withCredentials,
              });
              setPlan(result.plan);
              return;
            }
            const result = await api("/operations/backups", "POST", {
              includeHistory,
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
            checked={includeHistory}
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
          {includeHistory && !withCredentials && (
            <p className="field-description" role="note">
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
                <label>
                  {copy.passphrase}
                  <input
                    type="password"
                    minLength={12}
                    required
                    value={passphrase}
                    autoComplete="new-password"
                    onChange={(event) => setPassphrase(event.target.value)}
                  />
                </label>
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
