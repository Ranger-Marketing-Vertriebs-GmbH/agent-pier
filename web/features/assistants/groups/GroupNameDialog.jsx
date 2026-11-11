import React, { useState } from "react";
import Modal from "../../../components/Modal.jsx";
import SaveBar from "../../../components/SaveBar.jsx";
import { agentGroupsCopy as copy } from "../../../lib/i18n/messages/agent-groups.js";
import useAsyncAction from "../../../lib/useAsyncAction.js";
import useAssistants from "../useAssistants.js";

// Keep a typed name when another view changes the group, with the shared save
// bar's explicit reload/overwrite choice. A repeat still checks the latest revision.
export default function GroupNameDialog({ group, close, save }) {
  const { agentGroups: groups = [] } = useAssistants();
  const [base, setBase] = useState(group);
  const [name, setName] = useState(group?.name || "");
  const mutation = useAsyncAction();
  const latest = group && groups.find((g) => g.id === group.id);
  const conflict = latest && latest.revision !== base?.revision;
  const submit = (chosen) => mutation.run(() => save(name, chosen));
  const dismiss = () => {
    if (!mutation.lock.current) close();
  };
  return (
    <Modal
      title={group ? copy.rename : copy.newGroup}
      close={dismiss}
      closeDisabled={mutation.busy}
      className="agent-group-name-dialog"
      footer={
        <SaveBar
          draft={{
            dirty: true,
            saving: mutation.busy,
            conflicts: conflict ? ["name"] : [],
            outcome: mutation.error
              ? { status: "error", error: { message: mutation.error } }
              : null,
            reset: dismiss,
            reload: () =>
              mutation.run(() => {
                setBase(latest);
                setName(latest.name);
              }),
          }}
          saveDisabled={!name.trim()}
          onSave={() => submit(base)}
          onOverwrite={() => submit(latest)}
        />
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!conflict && name.trim()) void submit(base);
        }}
      >
        <label>
          {copy.name}
          <input
            maxLength={60}
            value={name}
            autoComplete="off"
            data-autofocus
            onChange={(e) => setName(e.target.value)}
          />
        </label>
      </form>
    </Modal>
  );
}
