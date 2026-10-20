import React from "react";
import SettingsShell from "../../components/SettingsShell.jsx";
import LogoutButton from "../login/LogoutButton.jsx";
import { userAppCopy as copy } from "../../lib/i18n/messages/user-app.js";
import "./user-app.css";

// The restricted user's own app: her agents and account only, never the owner's
// workspace. It talks only to /auth and /api/me.
export default function UserApp({ status }) {
  return (
    <main className="user-app">
      <SettingsShell
        title={status.user?.displayName || status.user?.username || ""}
        subtitle={copy.brand}
        actions={<LogoutButton className="button secondary" />}
      >
        <section className="user-app-empty">
          <p>{copy.empty}</p>
          <p className="user-app-hint">{copy.emptyHint}</p>
        </section>
      </SettingsShell>
    </main>
  );
}
