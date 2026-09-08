import React, { useEffect } from "react";
import useResource from "../../lib/useResource.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { requestCopy as copy } from "../../lib/i18n/de/requests.js";
import NativeRequest from "./NativeRequest.jsx";
import "./requests.css";
export default function RequestPanel({ session, active, openTerminal, onStateChange }) {
  const resource = useResource(
    active ? `/sessions/${encodeURIComponent(session.id)}/requests` : null,
    { poll: 1500 },
  );
  const blocked =
    resource.loading ||
    Boolean(resource.error) ||
    Boolean(resource.data?.requests.length);
  useEffect(() => {
    onStateChange?.({ sessionId: session.id, blocked });
  }, [session.id, blocked, onStateChange]);
  if (!resource.error && !resource.data?.requests.length) return null;
  return (
    <section className="native-requests" aria-label={copy.title}>
      <ErrorMessage error={resource.error} />
      {resource.data?.requests.map((request) => (
        <NativeRequest
          key={`${request.id}:${request.revision}`}
          request={request}
          updated={resource.update}
          openTerminal={openTerminal}
        />
      ))}
    </section>
  );
}
