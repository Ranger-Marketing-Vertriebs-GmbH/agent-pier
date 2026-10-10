import React, { useCallback, useEffect, useRef, useState } from "react";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { assistantApi } from "./assistant-api.js";
import useAssistants from "./useAssistants.js";
import RouteLink from "./RouteLink.jsx";
import usePolling from "./usePolling.js";
const active = (attempt) => ["starting", "awaiting_user"].includes(attempt?.status);
const savedLogin = "agentpier-assistant-login";

export default function AssistantModelAccounts({ navigate }) {
  const { runtime, refresh } = useAssistants();
  const [accounts, setAccounts] = useState([]);
  const accountGeneration = useRef(null);
  const [attempt, setAttempt] = useState(() => {
    const id = sessionStorage.getItem(savedLogin);
    return id ? { id, status: "starting" } : null;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [checks, setChecks] = useState({});
  const ready = runtime.availability === "ready";
  const load = useCallback(async () => {
    const generation = {};
    accountGeneration.current = generation;
    const result = await assistantApi.accounts();
    if (generation !== accountGeneration.current) return;
    setAccounts(result.accounts);
    await refresh();
  }, [refresh]);
  useEffect(() => {
    const generation = {};
    accountGeneration.current = generation;
    assistantApi
      .accounts()
      .then((result) => {
        if (generation === accountGeneration.current) setAccounts(result.accounts);
      })
      .catch((e) => {
        if (generation === accountGeneration.current) setError(e.message);
      });
    return () => {
      accountGeneration.current = null;
    };
  }, [ready]);
  const id = active(attempt) ? attempt.id : null;
  usePolling(
    async (signal) => {
      try {
        const next = await assistantApi.loginStatus(id);
        if (signal.aborted) return;
        setAttempt(next);
        if (!active(next)) {
          sessionStorage.removeItem(savedLogin);
          await load();
        }
      } catch (e) {
        if (!signal.aborted) {
          sessionStorage.removeItem(savedLogin);
          setAttempt({ id, status: "failed" });
          setError(e.message);
        }
      }
    },
    1000,
    { enabled: !!id, restartKey: id },
  );
  async function perform(operation) {
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="assistant-accounts" aria-label={copy.accountsTitle}>
      <h2>{copy.accountsTitle}</h2>
      <p className="assistant-note">{copy.accountsDescription}</p>
      <ErrorMessage error={error} />
      {!ready && (
        <p className="assistant-note">
          {copy.accountsOffline}{" "}
          <RouteLink
            route={{ view: "settings", settingsSection: "assistants" }}
            navigate={navigate}
          >
            {copy.runtimeLink}
          </RouteLink>
        </p>
      )}
      <div className="account-list">
        {accounts.map((account) => (
          <article className="account-card" key={account.id}>
            <div className="account-details">
              <h3>{account.name}</h3>
              <p>
                {copy.accountStatus[ready ? account.status : "offline"] ||
                  copy.accountStatus.unknown}
              </p>
              {checks[account.id] && (
                <p role="status">
                  {checks[account.id] === "ok"
                    ? copy.accountVerified
                    : copy.accountCheckFailed}
                </p>
              )}
            </div>
            <div className="assistant-actions">
              <button
                className="button secondary"
                disabled={!ready || busy || active(attempt)}
                onClick={() =>
                  perform(async () => {
                    const result = await assistantApi.checkAccount(account.id);
                    setChecks((previous) => ({
                      ...previous,
                      [account.id]: result.status,
                    }));
                    await load();
                  })
                }
              >
                {copy.accountCheck}
              </button>
              <button
                className="button secondary"
                disabled={!ready || busy || active(attempt)}
                onClick={() =>
                  perform(async () => {
                    await assistantApi.logoutAccount(account.id);
                    await load();
                  })
                }
              >
                {copy.accountDisconnect}
              </button>
            </div>
          </article>
        ))}
      </div>
      {attempt && (
        <div className="assistant-login" role="status">
          <p>{copy.loginStatus[attempt.status] || copy.loginStatus.failed}</p>
          {active(attempt) && attempt.code && (
            <>
              <code className="assistant-device-code">{attempt.code}</code>
              <p>{copy.loginInstructions}</p>
              <a
                className="button secondary"
                href={attempt.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {copy.loginOpen}
              </a>
            </>
          )}
          {active(attempt) && (
            <button
              className="button secondary"
              disabled={busy}
              onClick={() =>
                perform(async () => {
                  setAttempt(await assistantApi.cancelLogin(attempt.id));
                  sessionStorage.removeItem(savedLogin);
                  await load();
                })
              }
            >
              {copy.loginCancel}
            </button>
          )}
        </div>
      )}
      {!active(attempt) && (
        <button
          className="button secondary"
          disabled={!ready || busy}
          onClick={() =>
            perform(async () => {
              const next = await assistantApi.startLogin();
              sessionStorage.setItem(savedLogin, next.id);
              setAttempt(next);
            })
          }
        >
          {busy ? copy.loading : copy.accountConnect}
        </button>
      )}
    </section>
  );
}
