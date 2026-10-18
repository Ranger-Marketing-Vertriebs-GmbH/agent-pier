import React, { useEffect, useState } from "react";
import api from "../../lib/api.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Icon from "../../components/Icon.jsx";
import { formatTimestamp } from "../../lib/i18n/index.js";
import { inboxCopy as copy } from "../../lib/i18n/messages/inbox.js";

/** How an item that no longer waits ended (GET /inbox/<type>/<id>). */
export default function InboxStale({ type, id }) {
  const [status, setStatus] = useState(null),
    [error, setError] = useState("");
  useEffect(() => {
    let alive = true,
      timer;
    const read = () =>
      api(`/inbox/${encodeURIComponent(type)}/${encodeURIComponent(id)}`)
        .then((next) => {
          if (!alive) return;
          setStatus(next);
          // Still listed as waiting: the list is about to change, so ask again.
          if (next.state === "pending") timer = setTimeout(read, 1000);
        })
        .catch((e) => alive && setError(e.message));
    read();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [type, id]);
  if (error) return <ErrorMessage error={error} />;
  if (!status || status.state === "pending")
    return (
      <p className="loading" role="status">
        {copy.loading}
      </p>
    );
  if (status.state !== "done")
    return (
      <section className="inbox-stale" role="status">
        <h2>{copy.gone.title}</h2>
        <p>{copy.gone.text}</p>
      </section>
    );
  return (
    <section className="inbox-stale done" role="status">
      <h2>
        <Icon name="check" size={18} />
        {copy.done.title}
      </h2>
      <p>
        {(status.decision && copy.decisions[status.decision]) ||
          copy.done[status.outcome] ||
          copy.done.answered}
      </p>
      {status.at && (
        <small>
          {[copy.done.at(formatTimestamp(status.at)), copy.channels[status.channel]]
            .filter(Boolean)
            .join(" · ")}
        </small>
      )}
    </section>
  );
}
