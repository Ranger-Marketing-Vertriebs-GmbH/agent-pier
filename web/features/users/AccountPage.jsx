import React, { useState } from "react";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow, { unknownValue } from "../../components/ListRow.jsx";
import LogoutButton from "../login/LogoutButton.jsx";
import { NotificationDevices } from "../notifications/NotificationsPage.jsx";
import InstallGroup from "../notifications/InstallGroup.jsx";
import { formatTimestamp } from "../../lib/i18n/index.js";
import { userAppCopy as copy } from "../../lib/i18n/messages/user-app.js";
import PasswordSheet from "./PasswordSheet.jsx";
import "../notifications/notifications.css";

/**
 * Her account: name and username, Change password, whether the owner may read her
 * chats (read-only: only he switches it), this device's and her other devices' push
 * notices (through /api/me/notifications) and Sign out.
 */
export default function AccountPage({ me, user }) {
  const [changing, setChanging] = useState(false);
  const [changed, setChanged] = useState(false);
  const account = me?.user || user;
  const optIn = me?.ownerMayRead;
  return (
    <>
      <GroupLabel id="user-account">{copy.account}</GroupLabel>
      <ListCard labelledBy="user-account">
        <ListRow label={copy.name} value={account?.displayName ?? unknownValue} />
        <ListRow label={copy.username} value={account?.username ?? unknownValue} />
        <ListRow
          label={copy.changePassword}
          onClick={() => {
            setChanged(false);
            setChanging(true);
          }}
        />
      </ListCard>
      {changed && (
        <p role="status" className="user-app-hint">
          {copy.passwordChanged}
        </p>
      )}
      <GroupLabel id="user-privacy">{copy.privacy}</GroupLabel>
      <ListCard labelledBy="user-privacy">
        <ListRow
          label={copy.ownerMayRead}
          value={
            !optIn
              ? unknownValue
              : optIn.enabled
                ? copy.ownerMayReadOn(formatTimestamp(optIn.since))
                : copy.ownerMayReadOff
          }
          hint={copy.ownerMayReadHint}
        />
      </ListCard>
      <InstallGroup />
      <NotificationDevices base="/me/notifications" />
      <div className="user-account-actions">
        <LogoutButton className="button secondary" />
      </div>
      {changing && (
        <PasswordSheet
          onCancel={() => setChanging(false)}
          onDone={() => {
            setChanging(false);
            setChanged(true);
          }}
        />
      )}
    </>
  );
}
