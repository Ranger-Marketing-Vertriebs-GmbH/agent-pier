import React from "react";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import RouteLink from "./RouteLink.jsx";

export default function ChatgptOfflineNote({ navigate }) {
  return (
    <p className="accounts-note">
      {copy.accountsOffline}{" "}
      <RouteLink
        route={{ view: "settings", settingsSection: "assistants" }}
        navigate={navigate}
      >
        {copy.runtimeLink}
      </RouteLink>
    </p>
  );
}
