import React, { useEffect, useId, useState } from "react";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import api from "../../lib/api.js";
import { sshProposalCopy as copy } from "../../lib/i18n/messages/assistant-ssh-proposals.js";
import { assistantSshCopy as sshCopy } from "../../lib/i18n/messages/assistant-ssh.js";
import { assistantWorkflowCopy as workflowCopy } from "../../lib/i18n/messages/assistant-workflows.js";
import { sshCopy as keyCopy } from "../../lib/i18n/messages/ssh.js";
import SshCopy from "../ssh/SshCopy.jsx";
import { sshModes } from "./settings/agent-settings-fields.js";
import "./exec-approval-card.css";
import "../ssh/ssh.css";

const NEW_KEY = "";

/** After the owner confirmed: the access exists, its public key waits to be installed. */
export function SshAccessCreatedNote({ action }) {
  const r = action.result || {};
  return (
    <section className="assistant-note assistant-event" data-ssh-access-created="">
      <p>{copy.created(action.payload.name)}</p>
      {r.publicKey && (
        <>
          <SshCopy
            label={keyCopy.publicKey}
            text={r.publicKey}
            button={keyCopy.copyKey}
          />
          <p>{copy.installKey}</p>
        </>
      )}
    </section>
  );
}

/**
 * An agent's proposal of a new SSH access waiting for the owner: endpoint, project,
 * purpose and the scanned host-key fingerprint he has to verify himself. He may pick
 * a key of the proposal's project instead of a new managed one, and another mode than
 * With approval, before he confirms. `onDecide(decision, extra)` sends `keyId` and
 * `mode` only when they differ from the defaults.
 */
export default function SshAccessProposalCard({ action, onDecide }) {
  const p = action.payload;
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [keys, setKeys] = useState(null);
  const [keysFailed, setKeysFailed] = useState(false);
  const [keyId, setKeyId] = useState(NEW_KEY);
  const [mode, setMode] = useState("approval");
  useEffect(() => {
    let live = true;
    api("/ssh-keys").then(
      (result) =>
        live &&
        setKeys(
          (result.keys || []).filter(
            (key) => (key.projectId ?? null) === (p.projectId ?? null),
          ),
        ),
      () => live && setKeysFailed(true),
    );
    return () => {
      live = false;
    };
  }, [p.projectId]);
  async function decide(decision) {
    setBusy(true);
    try {
      await onDecide(
        decision,
        decision === "approve"
          ? {
              ...(keyId !== NEW_KEY ? { keyId } : {}),
              ...(mode !== "approval" ? { mode } : {}),
            }
          : {},
      );
    } finally {
      setBusy(false);
    }
  }
  const keyOptions = [
    { value: NEW_KEY, label: copy.newKey },
    ...(keys || []).map((key) => ({ value: key.id, label: key.name })),
  ];
  return (
    <article
      className="assistant-approval-card exec-approval-card"
      data-pending=""
      data-ssh-access-proposal=""
      aria-labelledby={`${id}-title`}
    >
      <div className="assistant-approval-head">
        <strong id={`${id}-title`}>{copy.title}</strong>
        <small>{workflowCopy.states.awaiting_approval}</small>
      </div>
      <strong className="assistant-approval-title">{p.name}</strong>
      <dl className="exec-approval-facts">
        <dt>{copy.login}</dt>
        <dd>
          <code>{sshCopy.endpoint(p.username, p.host, p.port)}</code>
        </dd>
        <dt>{copy.project}</dt>
        <dd>{p.projectName || copy.noProject}</dd>
        <dt>{copy.purpose}</dt>
        <dd className="assistant-approval-task">{p.purpose}</dd>
        <dt>{copy.fingerprint}</dt>
        <dd>
          <code className="ssh-fingerprint" data-ssh-access-fingerprint="">
            {p.hostFingerprint}
          </code>
        </dd>
      </dl>
      <p className="assistant-note" data-ssh-access-verify="">
        {copy.verify}
      </p>
      {keysFailed && <ErrorMessage error={copy.keysFailed} />}
      <label>
        {copy.key}
        <AnchoredSelect
          label={copy.key}
          value={keyId}
          onChange={setKeyId}
          options={keyOptions}
          disabled={busy || !keys}
        />
      </label>
      <label>
        {copy.mode}
        <AnchoredSelect
          label={copy.mode}
          value={mode}
          onChange={setMode}
          options={sshModes.map((value) => ({ value, label: sshCopy.modes[value] }))}
          disabled={busy}
        />
      </label>
      <p className="assistant-note">{sshCopy.modeHints[mode]}</p>
      {mode !== "approval" && (
        <p className="assistant-note" data-ssh-access-trusted="">
          {sshCopy.trustedWarning}
        </p>
      )}
      <div className="assistant-card-actions">
        <button
          type="button"
          disabled={busy}
          className="button primary"
          onClick={() => decide("approve")}
        >
          {copy.approve}
        </button>
        <button
          type="button"
          disabled={busy}
          className="button secondary"
          onClick={() => decide("decline")}
        >
          {workflowCopy.decline}
        </button>
      </div>
    </article>
  );
}
