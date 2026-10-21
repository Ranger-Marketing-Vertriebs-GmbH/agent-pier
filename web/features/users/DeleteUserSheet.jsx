import React, { useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import Segmented from "../../components/Segmented.jsx";
import { usersCopy as copy } from "../../lib/i18n/messages/users.js";
import { ownerUsersApi } from "./owner-users-api.js";

/**
 * Deleting a user: she can no longer sign in, her private chats go unless the owner
 * may read them, and her own agents are archived or kept under the owner's account.
 */
export default function DeleteUserSheet({ user, ownsAgents, onDeleted, onCancel }) {
  const [agents, setAgents] = useState("archive");
  return (
    <ConfirmDialog
      title={copy.deleteTitle(user.displayName)}
      body={copy.deleteBody}
      confirmLabel={copy.deleteConfirm}
      destructive
      onCancel={onCancel}
      onConfirm={async () => {
        await ownerUsersApi.remove(user.id, ownsAgents ? agents : undefined);
        onDeleted();
      }}
    >
      {ownsAgents && <p className="user-delete-choice">{copy.ownAgentsChoice}</p>}
      {ownsAgents && (
        <Segmented
          label={copy.ownAgentsChoice}
          value={agents}
          onChange={setAgents}
          options={[
            { value: "archive", label: copy.archiveAgents },
            { value: "keep", label: copy.keepAgents },
          ]}
        />
      )}
    </ConfirmDialog>
  );
}
