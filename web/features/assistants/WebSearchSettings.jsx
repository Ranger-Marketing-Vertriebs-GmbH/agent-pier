import React, { useEffect, useState } from "react";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { assistantApi } from "./assistant-api.js";
import RestartConfirmation from "./RestartConfirmation.jsx";
import { restartRequired } from "../provider-connections/restart-confirmation.js";

const providers = ["duckduckgo", "perplexity", "brave"];

/** The search provider agents use; keys are written here and never shown again. */
export default function WebSearchSettings({ connections = [] }) {
  const copy = assistantCopy.webSearch;
  const [settings, setSettings] = useState(null),
    [provider, setProvider] = useState("duckduckgo"),
    [connectionId, setConnectionId] = useState(""),
    [key, setKey] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [restart, setRestart] = useState(null),
    [pending, setPending] = useState(null);
  const openRouter = connections.filter((c) => c.providerId === "openrouter");
  const adopt = (next) => {
    setSettings(next);
    setProvider(next.provider);
    setConnectionId(next.connectionId || "");
  };
  useEffect(() => {
    const controller = new AbortController();
    assistantApi
      .webSearch(controller.signal)
      .then(adopt)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, []);
  const buildInput = (removeKey) => ({
    revision: settings.revision,
    provider,
    ...(provider === "perplexity" && connectionId ? { connectionId } : {}),
    ...(provider === "brave" && removeKey ? { braveKey: null } : {}),
    ...(provider === "brave" && !removeKey && key ? { braveKey: key } : {}),
  });
  async function save(removeKey = false, confirmRestart = false) {
    // The confirmed request repeats the one the owner was asked about.
    const input = confirmRestart && pending ? pending : buildInput(removeKey);
    setBusy(true);
    setError("");
    try {
      const next = await assistantApi.saveWebSearch({
        ...input,
        ...(confirmRestart ? { confirmRestart: true } : {}),
      });
      adopt(next);
      setKey("");
      setRestart(null);
      setPending(null);
    } catch (e) {
      if (restartRequired(e)) {
        setRestart(e.affected || {});
        setPending(input);
      } else setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const dirty = () => setRestart(null);
  return (
    <section className="assistant-accounts" aria-label={copy.title}>
      <h2>{copy.title}</h2>
      <p className="assistant-note">{copy.description}</p>
      <ErrorMessage error={error} />
      {settings && (
        <form
          className="assistant-form"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <p className="assistant-note" role="status">
            {settings.ready ? copy.ready : copy.notConfigured}
          </p>
          <fieldset className="assistant-capability-options">
            <legend>{copy.provider}</legend>
            {providers.map((id) => (
              <label className="assistant-team-permission" key={id}>
                <input
                  type="radio"
                  name="web-search-provider"
                  value={id}
                  checked={provider === id}
                  onChange={() => {
                    dirty();
                    setProvider(id);
                  }}
                />
                {copy[id]}
              </label>
            ))}
          </fieldset>
          {provider === "perplexity" &&
            (openRouter.length ? (
              <label>
                {copy.connection}
                <select
                  value={connectionId}
                  onChange={(e) => {
                    dirty();
                    setConnectionId(e.target.value);
                  }}
                >
                  <option value="">{copy.noConnection}</option>
                  {openRouter.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <p className="assistant-note">{copy.noConnections}</p>
            ))}
          {provider === "brave" && (
            <>
              <p className="assistant-note" role="status">
                {settings.hasBraveKey ? copy.braveKeyStored : copy.braveKeyMissing}
              </p>
              <label>
                {copy.braveKey}
                <input
                  type="password"
                  autoComplete="new-password"
                  value={key}
                  maxLength={1024}
                  onChange={(e) => {
                    dirty();
                    setKey(e.target.value);
                  }}
                />
              </label>
            </>
          )}
          {restart && (
            <RestartConfirmation
              affected={restart}
              busy={busy}
              onConfirm={() => save(false, true)}
              onCancel={() => {
                setRestart(null);
                setPending(null);
              }}
            />
          )}
          <div className="assistant-actions">
            <button className="button primary" disabled={busy}>
              {busy ? copy.saving : copy.save}
            </button>
            {provider === "brave" && settings.hasBraveKey && (
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => save(true)}
              >
                {copy.removeKey}
              </button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
