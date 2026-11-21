import React from "react";
import { restoreSettingsCopy as copy } from "../../lib/i18n/messages/restore-settings.js";

const label = (key) => copy.keys[key] || key;
const lists = ["restored", "fromThisInstance", "setAgain"];

/**
 * The `settings` part of a restore report (server/features/operations/config-backup.js):
 * which config.json settings came back, which this instance supplied, and which the
 * owner sets again, with the way to Remote access.
 */
export default function RestoreSettingsReport({ settings }) {
  if (!settings || typeof settings !== "object") return null;
  const shown = lists.filter((list) => settings[list]?.length > 0);
  return (
    <section aria-label={copy.title}>
      <h3>{copy.title}</h3>
      <p className="field-description">
        {settings.sameHost ? copy.sameHost : copy.otherHost}
      </p>
      {shown.length > 0 && (
        <dl className="operations-metadata">
          {shown.map((list) => (
            <React.Fragment key={list}>
              <dt>{copy[list]}</dt>
              <dd>{settings[list].map(label).join(", ")}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}
      {settings.setAgain?.length > 0 && (
        <p className="field-description">
          {copy.setAgainHelp} <a href="/settings/remote">{copy.openRemoteAccess}</a>
        </p>
      )}
    </section>
  );
}
