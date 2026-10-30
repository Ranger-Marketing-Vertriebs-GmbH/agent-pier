import React, { useEffect, useId, useState } from "react";
import Checkbox from "../../../components/Checkbox.jsx";
import ConfirmDialog from "../../../components/ConfirmDialog.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow from "../../../components/ListRow.jsx";
import { assistantSettingsCopy } from "../../../lib/i18n/messages/assistant-settings.js";
import { assistantApi } from "../assistant-api.js";
import useAssistants from "../useAssistants.js";

const workKeys = [
  "turns",
  "teams",
  "members",
  "requests",
  "coding",
  "goals",
  "approvals",
];

/** The dialog's details: what goes, what stays, who is affected and what stops. */
function RestartDetails({ preview, copy }) {
  const id = useId();
  const { members = {}, work = {} } = preview;
  const facts = [
    copy.goes(preview.people),
    copy.stays,
    copy.notSaved,
    members.temporary > 0 && copy.temporary(members.temporary),
    members.permanent > 0 && copy.permanent(members.permanent),
    copy.archived,
  ].filter(Boolean);
  const running = workKeys.filter((key) => work[key] > 0);
  return (
    <>
      <ul>
        {facts.map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
      {running.length > 0 && (
        <>
          <p id={id}>{copy.workIntro}</p>
          <ul aria-labelledby={id}>
            {running.map((key) => (
              <li key={key}>{copy.work[key](work[key])}</li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/** Loads what the restart affects and asks for an acknowledgement before it runs. */
function RestartDialog({ assistant, onCancel, onDone }) {
  const copy = assistantSettingsCopy.mainChatRestart;
  const { refresh } = useAssistants();
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState("");
  const [understood, setUnderstood] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    assistantApi.mainChatRestartPreview(assistant.id, controller.signal).then(
      (result) => setPreview(result),
      (e) => {
        if (!controller.signal.aborted)
          setError(e.message || assistantSettingsCopy.mainChatRestart.loadFailed);
      },
    );
    return () => controller.abort();
  }, [assistant.id]);
  return (
    <ConfirmDialog
      destructive
      title={copy.title(assistant.name)}
      body={copy.body}
      confirmLabel={copy.confirm}
      confirmDisabled={!preview || !understood}
      error={error}
      onCancel={onCancel}
      onConfirm={async () => {
        await assistantApi.restartMainChats(assistant.id);
        // The restart is done; a failed reload of the agent list must not hide that.
        await Promise.resolve(refresh?.()).catch(() => {});
        onDone();
      }}
    >
      {preview ? (
        <RestartDetails preview={preview} copy={copy} />
      ) : (
        !error && <p role="status">{copy.loading}</p>
      )}
      <Checkbox
        label={copy.acknowledge}
        checked={understood}
        disabled={!preview}
        onChange={setUnderstood}
      />
    </ConfirmDialog>
  );
}

/**
 * Gefahrenbereich (docs/agents.md): starts every main chat of the
 * agent over, ends its temporary members and restarts its permanent ones. Agent
 * settings are the owner's; a team member restarts with its lead, so it has none.
 */
export default function MainChatRestart({ assistant }) {
  const id = useId();
  const copy = assistantSettingsCopy.mainChatRestart;
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState("");
  if (!assistant || assistant.teamMemberId || assistant.archivedAt) return null;
  return (
    <section id="agent-danger" aria-labelledby={id}>
      <GroupLabel id={id}>{copy.group}</GroupLabel>
      <ListCard labelledBy={id}>
        <ListRow
          label={copy.row}
          sub={copy.rowHint}
          onClick={() => {
            setResult("");
            setConfirming(true);
          }}
        />
      </ListCard>
      {result && (
        <p role="status" className="assistant-notice">
          {result}
        </p>
      )}
      {confirming && (
        <RestartDialog
          assistant={assistant}
          onCancel={() => setConfirming(false)}
          onDone={() => {
            setConfirming(false);
            setResult(copy.done);
          }}
        />
      )}
    </section>
  );
}
