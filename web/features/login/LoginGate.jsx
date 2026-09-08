import useLanguage from "../../lib/i18n/useLanguage.js";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { LoginContext } from "./LoginContext.js";
import { loginRequest, announceLoginChange } from "./login-api.js";
import LoginPage from "./LoginPage.jsx";
import { loginCopy as copy } from "../../lib/i18n/messages/login.js";
import "./login.css";
export default function LoginGate({ children }) {
  useLanguage();
  const generation = useRef(0);
  const invalidate = useCallback(() => ++generation.current, []);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    const current = invalidate();
    try {
      const next = await loginRequest("status");
      if (typeof next.configured !== "boolean" || typeof next.authenticated !== "boolean")
        throw new Error(copy.failed);
      if (current !== generation.current) return;
      setStatus(next);
      setError("");
    } catch (failure) {
      if (current === generation.current) setError(failure.message);
    }
  }, [invalidate]);
  useEffect(() => {
    refresh();
    const expired = () => {
      invalidate();
      setStatus({ configured: true, authenticated: false });
    };
    const changed = (event) => {
      if (event.key === "agentpier-auth-change") refresh();
    };
    window.addEventListener("agentpier-login-required", expired);
    window.addEventListener("storage", changed);
    window.addEventListener("focus", refresh);
    const timer = setInterval(refresh, 60000);
    return () => {
      invalidate();
      clearInterval(timer);
      window.removeEventListener("agentpier-login-required", expired);
      window.removeEventListener("storage", changed);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh, invalidate]);
  async function logout() {
    await loginRequest("logout", {});
    invalidate();
    setStatus({ configured: true, authenticated: false });
    announceLoginChange();
  }
  if (status?.authenticated)
    return <LoginContext value={{ logout }}>{children}</LoginContext>;
  if (status) return <LoginPage status={status} onLogin={refresh} refresh={refresh} />;
  return (
    <main className="login-page">
      <div className="login-card">
        <p role={error ? "alert" : "status"}>{error || copy.loading}</p>
        {error && (
          <button className="button secondary" onClick={refresh}>
            {copy.retry}
          </button>
        )}
      </div>
    </main>
  );
}
