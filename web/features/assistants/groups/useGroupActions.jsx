import React, { useState } from "react";
import ConfirmDialog from "../../../components/ConfirmDialog.jsx";
import GroupNameDialog from "./GroupNameDialog.jsx";
import { agentGroupsCopy as copy } from "../../../lib/i18n/messages/agent-groups.js";
import useAsyncAction from "../../../lib/useAsyncAction.js";
import useAssistants from "../useAssistants.js";
import { groupApi } from "./group-api.js";
import { groupOf } from "./group-view.js";

export default function useGroupActions() {
  const { agentGroups: groups = [], refresh } = useAssistants();
  const action = useAsyncAction();
  const [dialog, setDialog] = useState(null);
  const close = () => setDialog(null);
  const save = async (write) => {
    try {
      await write();
    } finally {
      await refresh();
    }
  };
  const run = (write) => action.run(() => save(write));
  return {
    groups,
    busy: action.busy,
    error: action.error,
    create: () => setDialog({ kind: "name" }),
    rename: (group) => setDialog({ kind: "name", group }),
    remove: (group) => setDialog({ kind: "delete", group }),
    reorder: (group, direction) => run(() => groupApi.reorder(group, direction)),
    move: (agent, groupId) =>
      run(() => groupApi.assign(agent.id, groupId, groupOf(groups, agent.id))),
    dialog:
      dialog?.kind === "name" ? (
        <GroupNameDialog
          group={dialog.group}
          close={close}
          save={async (name, group) => {
            await save(() =>
              group ? groupApi.rename(group, name) : groupApi.create(name),
            );
            close();
          }}
        />
      ) : dialog?.kind === "delete" ? (
        <ConfirmDialog
          destructive
          title={copy.deleteTitle(dialog.group.name)}
          body={copy.removeBody}
          confirmLabel={copy.remove}
          onCancel={close}
          onConfirm={async () => {
            await save(() => groupApi.remove(dialog.group));
            close();
          }}
        />
      ) : null,
  };
}
