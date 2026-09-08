import React, { useState } from "react";
import { loginCopy as copy } from "../../lib/i18n/de/login.js";
import { loginRequest, announceLoginChange } from "./login-api.js";
export default function LoginPage({ status, onLogin, refresh }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const setup = !status.configured;
  async function submit(event) {
    event.preventDefault();
    if (setup && password !== repeat) {
      setError(copy.mismatch);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await loginRequest(setup ? "setup" : "login", { username, password });
      setPassword("");
      setRepeat("");
      announceLoginChange();
      await onLogin();
    } catch (failure) {
      setError(failure.message);
      // Another browser may have completed the single-user setup meanwhile.
      if (setup) await refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-page">
      <form className="login-card" onSubmit={submit}>
        <p className="login-brand">
          AgentPier<span>.</span>
        </p>
        <h1>{setup ? copy.setup : copy.title}</h1>
        <p className="login-description">
          {setup ? copy.setupDescription : copy.description}
        </p>
        <label>
          {copy.username}
          <input
            name="username"
            autoComplete="username"
            required
            maxLength={100}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </label>
        <label>
          {copy.password}
          <input
            name="password"
            type="password"
            autoComplete={setup ? "new-password" : "current-password"}
            required
            minLength={setup ? 12 : undefined}
            maxLength={1024}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {setup && (
          <>
            <small>{copy.passwordHint}</small>
            <label>
              {copy.repeat}
              <input
                name="password-confirmation"
                type="password"
                autoComplete="new-password"
                required
                value={repeat}
                onChange={(event) => setRepeat(event.target.value)}
              />
            </label>
          </>
        )}
        {error && (
          <p role="alert" className="login-error">
            {error}
          </p>
        )}
        <button className="button primary" type="submit" disabled={busy}>
          {busy ? copy.pending : setup ? copy.setup : copy.title}
        </button>
      </form>
    </main>
  );
}
