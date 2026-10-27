import React, { useEffect, useId, useState } from "react";
import ConfirmDialog from "../../../components/ConfirmDialog.jsx";
import { agentLifecycleCopy as copy } from "../../../lib/i18n/messages/agent-lifecycle.js";
import { assistantApi } from "../assistant-api.js";
import useAssistants from "../useAssistants.js";

const countKeys = ["chats", "routines", "memoryFiles", "workspaceFiles", "members"];

/**
 * "Delete permanently" (docs/ui-guide.md#confirmations): lists what is lost as counts
 * and stays off until the agent's name is typed exactly as it is.
 */
export function AgentDeleteDialog({ assistant, onCancel, onDeleted }) {
  const { refresh } = useAssistants();
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const id = useId();
  useEffect(() => {
    let live = true;
    assistantApi.agentDeletion(assistant.id).then(
      (result) => live && setPreview(result),
      (e) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [assistant.id]);
  const lost = preview
    ? countKeys
        .filter((key) => preview.counts[key] > 0 || key === "chats")
        .map((key) => copy[key](preview.counts[key]))
    : [];
  return (
    <ConfirmDialog
      destructive
      title={copy.deleteTitle(assistant.name)}
      body={copy.deleteBody}
      confirmLabel={copy.deletePermanently}
      confirmDisabled={!preview || name !== assistant.name}
      error={error}
      onCancel={onCancel}
      onConfirm={async () => {
        await assistantApi.deleteAgent(assistant.id, name);
        await refresh();
        onDeleted?.();
      }}
    >
      {preview ? (
        <>
          <p id={`${id}-lost`}>{copy.lost}</p>
          <ul aria-labelledby={`${id}-lost`}>
            {lost.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
          <p>{copy.kept}</p>
        </>
      ) : (
        !error && <p role="status">{copy.counting}</p>
      )}
      <label>
        {copy.typeName(assistant.name)}
        <input
          value={name}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
    </ConfirmDialog>
  );
}

/** The dialogs of useAgentLifecycle: archive a lead with its members, delete. */
export default function AgentLifecycleDialogs({ assistant, lifecycle, onDeleted }) {
  if (lifecycle.dialog === "members")
    return (
      <ConfirmDialog
        title={copy.membersTitle(assistant.name, lifecycle.tasks.length)}
        body={copy.membersBody}
        confirmLabel={copy.archive}
        onCancel={lifecycle.close}
        onConfirm={() => lifecycle.archive(true)}
      />
    );
  if (lifecycle.dialog === "delete")
    return (
      <AgentDeleteDialog
        assistant={assistant}
        onCancel={lifecycle.close}
        onDeleted={onDeleted}
      />
    );
  return null;
}
