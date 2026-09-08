import React, { useContext, useState } from "react";
import { LoginContext } from "./LoginContext.js";
import { loginCopy as copy } from "../../lib/i18n/de/login.js";
export default function LogoutButton() {
  const auth = useContext(LoginContext);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (!auth) return null;
  async function logout() {
    setBusy(true);
    try {
      await auth.logout();
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }
  return (
    <>
      <button className="nav-item" onClick={logout} disabled={busy}>
        {copy.logout}
      </button>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
