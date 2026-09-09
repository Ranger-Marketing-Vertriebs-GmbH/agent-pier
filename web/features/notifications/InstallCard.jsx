import React, { useEffect, useState, useSyncExternalStore } from "react";
import { notificationCopy as copy } from "../../lib/i18n/messages/notifications.js";
import {
  readInstallPrompt,
  showInstallPrompt,
  subscribeInstallPrompt,
} from "./install-prompt.js";
export default function InstallCard() {
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
    <section className="operations-card">
      <h2>{copy.installTitle}</h2>
      <p>{installed ? copy.installed : copy.installHelp}</p>
      {!installed && prompt && (
        <button className="button primary" onClick={showInstallPrompt}>
          {copy.install}
        </button>
      )}
      <p className="field-description">{copy.offlinePrivacy}</p>
    </section>
  );
}
