import ErrorMessage from "../../components/ErrorMessage.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { conversationPickerCopy as copy } from "../../lib/i18n/messages/chat.js";
import React, { useEffect, useRef, useState, useCallback } from "react";
export default function ConversationPicker({
  session,
  request,
  selected,
  choose,
  cancel,
}) {
  const [choices, setChoices] = useState([]),
    [value, setValue] = useState(selected || ""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await request(`/sessions/${session.id}/chat/choices`);
      if (mounted.current) setChoices(result.choices);
    } catch (err) {
      if (mounted.current) setError(err.message);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [request, session.id]);
  useEffect(() => {
    mounted.current = true;
    refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);
  return (
    <form
      className="conversation-picker"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError("");
        try {
          choose(
            await request(`/sessions/${session.id}/chat/bind`, "POST", {
              providerSessionId: value,
            }),
          );
        } catch (err) {
          setError(err.message);
        } finally {
          if (mounted.current) setBusy(false);
        }
      }}
    >
      <h3>{commonCopy.bindConversation}</h3>
      <p>{copy.conversationScopeDescription}</p>
      <label>
        {commonCopy.conversation}
        <select
          aria-label={commonCopy.conversation}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          disabled={loading || busy}
        >
          <option value="">
            {loading ? copy.conversationPickerOption : commonCopy.chooseConversation}
          </option>
          {choices.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.title} · {choice.id.slice(0, 8)}
            </option>
          ))}
        </select>
      </label>
      {!loading && !choices.length && <p>{copy.noConversationsDescription}</p>}
      {error && <ErrorMessage error={error} />}
      <div className="picker-actions">
        <button
          type="button"
          className="button secondary compact"
          onClick={refresh}
          disabled={loading || busy}
        >
          {commonCopy.refresh}
        </button>
        {cancel && (
          <button type="button" className="button secondary compact" onClick={cancel}>
            {commonCopy.cancel}
          </button>
        )}
        <button className="button primary compact" disabled={!value || busy || loading}>
          {busy ? commonCopy.binding : commonCopy.bind}
        </button>
      </div>
    </form>
  );
}
