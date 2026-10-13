import React, { useEffect, useState, useSyncExternalStore } from "react";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import { notificationCopy as copy } from "../../lib/i18n/messages/notifications.js";
import {
  readInstallPrompt,
  showInstallPrompt,
  subscribeInstallPrompt,
} from "./install-prompt.js";

// "AgentPier as an app": one status row; installing stays an explicit click.
export default function InstallGroup() {
  const prompt = useSyncExternalStore(subscribeInstallPrompt, readInstallPrompt),
    [installed, setInstalled] = useState(
      () =>
        matchMedia("(display-mode: standalone)").matches || navigator.standalone === true,
    );
  useEffect(() => {
    const completed = () => {
      setInstalled(true);
    };
    window.addEventListener("appinstalled", completed);
    return () => {
      window.removeEventListener("appinstalled", completed);
    };
  }, []);
  return (
    <>
      <GroupLabel id="notifications-app" hint={copy.offlinePrivacy}>
        {copy.appGroup}
      </GroupLabel>
      <ListCard labelledBy="notifications-app">
        <ListRow
          className="notification-install-row"
          label={copy.installTitle}
          sub={installed ? copy.installed : copy.notInstalled}
          status={installed ? { tone: "ok", text: copy.installedStatus } : undefined}
          hint={installed ? undefined : copy.installHelp}
        >
          {!installed && prompt && (
            <button
              type="button"
              className="button secondary compact"
              onClick={showInstallPrompt}
            >
              {copy.install}
            </button>
          )}
        </ListRow>
      </ListCard>
    </>
  );
}
