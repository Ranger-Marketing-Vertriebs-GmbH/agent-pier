import React, { useEffect, useState } from "react";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { assistantApi } from "./assistant-api.js";
export default function SpeechSettings() {
  const copy = assistantCopy.speech;
  const [settings, setSettings] = useState(null),
    [key, setKey] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    assistantApi
      .speech(controller.signal)
      .then(setSettings)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, []);
  async function save(removeApiKey = false) {
    setBusy(true);
    setError("");
    try {
      const next = await assistantApi.saveSpeech({
        revision: settings.revision,
        model: settings.model,
        language: settings.language,
        ...(removeApiKey ? { removeApiKey: true } : key ? { apiKey: key } : {}),
      });
      setSettings(next);
      setKey("");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
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
            {settings.hasSecret ? copy.saved : copy.missing}
          </p>
          <label>
            {copy.key}
            <input
              type="password"
              autoComplete="new-password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              maxLength={1024}
            />
          </label>
          <div className="assistant-model-fields">
            <label>
              {copy.model}
              <input
                required
                value={settings.model}
                onChange={(e) => setSettings({ ...settings, model: e.target.value })}
              />
            </label>
            <label>
              {copy.language}
              <select
                value={settings.language}
                onChange={(e) => setSettings({ ...settings, language: e.target.value })}
              >
                <option value="auto">{copy.auto}</option>
                <option value="de">{copy.german}</option>
                <option value="en">{copy.english}</option>
              </select>
            </label>
          </div>
          <div className="assistant-actions">
            <button className="button primary" disabled={busy}>
              {copy.save}
            </button>
            {settings.hasSecret && (
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => save(true)}
              >
                {copy.remove}
              </button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
