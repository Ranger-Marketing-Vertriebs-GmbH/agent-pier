import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Icon from "../../components/Icon.jsx";
import { backgroundTasksCopy as copy } from "../../lib/i18n/messages/chat.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import ChatTranscript from "./ChatTranscript.jsx";
import { taskTitle } from "./BackgroundTaskCard.jsx";
import { readTaskOutput, readTaskTranscript } from "./task-actions.js";

/**
 * Loads the entry's transcript or output once, again when the chat frame reports a
 * change of this entry (its status or `updatedAt`) and on `reload`; never on a timer.
 */
function useTaskRead(session, entry, view) {
  const [state, setState] = useState({ result: null, error: "", loading: true });
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const read = view === "output" ? readTaskOutput : readTaskTranscript;
    // The old content stays visible while it reloads.
    setState((current) => ({ ...current, loading: true }));
    read(session.id, entry.id, controller.signal).then(
      (result) => setState({ result, error: "", loading: false }),
      (error) => {
        if (!controller.signal.aborted)
          setState((current) => ({ ...current, error: error.message, loading: false }));
      },
    );
    return () => controller.abort();
  }, [session.id, entry.id, entry.status, entry.updatedAt, view, reloads]);
  return { ...state, reload: () => setReloads((count) => count + 1) };
}

function Transcript({ result, session, openFile }) {
  const messages = Array.isArray(result.messages) ? result.messages : [];
  return (
    <>
      {result.partial && <p className="task-detail-note">{copy.transcriptPartial}</p>}
      {result.truncated && (
        <p className="task-detail-note">{copy.transcriptTruncated(messages.length)}</p>
      )}
      {messages.length ? (
        <div className="task-detail-transcript">
          <ChatTranscript
            messages={messages}
            live={false}
            tool={session.tool}
            sandboxProfile={session.sandbox?.profile}
            sessionId={session.id}
            cwd={session.cwd}
            openFile={openFile}
          />
        </div>
      ) : (
        <p className="task-detail-note">{copy.transcriptEmpty}</p>
      )}
    </>
  );
}

function Output({ result }) {
  if (result.gone) return <p className="task-detail-note">{copy.outputGone}</p>;
  return (
    <>
      {result.truncated && <p className="task-detail-note">{copy.outputTruncated}</p>}
      {result.text ? (
        <pre className="task-detail-output">{result.text}</pre>
      ) : (
        <p className="task-detail-note">{copy.outputEmpty}</p>
      )}
    </>
  );
}

/**
 * The transcript of a subagent or the output of a shell, shown in place of the list
 * inside the background tasks sheet, with a way back to the list.
 */
export default function BackgroundTaskDetail({ entry, view, session, openFile, onBack }) {
  const { result, error, loading, reload } = useTaskRead(session, entry, view);
  const back = useRef(null);
  useLayoutEffect(() => back.current?.focus(), []);
  return (
    <section className="background-task-detail" aria-busy={loading || undefined}>
      <div className="task-detail-head">
        <button
          ref={back}
          type="button"
          className="icon-button"
          aria-label={copy.back}
          title={copy.back}
          onClick={onBack}
        >
          <Icon name="back" />
        </button>
        <h3
          className={entry.kind === "shell" && !entry.description ? "task-command" : ""}
        >
          {taskTitle(entry)}
        </h3>
        {view === "output" && (
          <button
            type="button"
            className="button secondary compact"
            onClick={reload}
            disabled={loading}
          >
            {commonCopy.refresh}
          </button>
        )}
      </div>
      {loading && !result && (
        <p className="task-detail-note" role="status">
          {copy.loading}
        </p>
      )}
      <ErrorMessage error={error} />
      {result &&
        (view === "output" ? (
          <Output result={result} />
        ) : (
          <Transcript result={result} session={session} openFile={openFile} />
        ))}
    </section>
  );
}
