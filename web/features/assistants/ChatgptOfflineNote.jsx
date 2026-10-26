import React from "react";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import RouteLink from "./RouteLink.jsx";
import { useCrossLink } from "../../app/cross-link.js";
import { agentsHubRoute } from "./hub-routes.js";

export default function ChatgptOfflineNote({ navigate }) {
  const settings = useCrossLink()(agentsHubRoute("runtime"));
  return (
    <p className="accounts-note">
      {copy.accountsOffline}{" "}
      <RouteLink route={settings} navigate={navigate}>
        {copy.runtimeLink}
      </RouteLink>
    </p>
  );
}
