import React, { useEffect, useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import { usersCopy as copy } from "../../lib/i18n/messages/users.js";
import { ownerUsersApi } from "./owner-users-api.js";

/**
 * Turning a user's sign-in off: she is signed out, and her reminders, routines,
 * check-ins and Telegram bots end for good (server user-release.js), so it asks first
 * and counts what goes. Without the counts it still names what is removed.
 */
export default function DisableUserSheet({ user, onDisabled, onCancel }) {
  const [impact, setImpact] = useState(null);
  useEffect(() => {
    let live = true;
    ownerUsersApi
      .disableImpact(user.id)
      .then((value) => live && setImpact(value))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [user.id]);
  return (
    <ConfirmDialog
      title={copy.disableTitle(user.displayName)}
      body={[
        copy.disableBody,
        impact && copy.disableImpact(impact.schedules, impact.bots),
      ]}
      confirmLabel={copy.disableConfirm}
      destructive
      onCancel={onCancel}
      onConfirm={async () => {
        await ownerUsersApi.update(user.id, { disabled: true });
        await onDisabled();
      }}
    />
  );
}
