import React, { useContext, useState } from "react";
import { LoginContext } from "./LoginContext.js";
import { loginCopy as copy } from "../../lib/i18n/messages/login.js";
import { requestNavigation } from "../../lib/navigation-guard.js";
export default function LogoutButton({ className = "nav-item" }) {
  const auth = useContext(LoginContext);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (!auth) return null;
  async function logout() {
    setBusy(true);
    try {
      // Signing out leaves the workspace: unsaved changes ask first, like a navigation.
      const left = await requestNavigation({ reason: "logout", commit: auth.logout });
      if (!left) setBusy(false);
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }
  return (
    <>
      <button className={className} onClick={logout} disabled={busy}>
        {copy.logout}
      </button>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
