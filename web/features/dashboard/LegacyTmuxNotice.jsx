import React from "react";
import { systemStatusCopy as copy } from "../../lib/i18n/messages/system-status.js";
import Icon from "../../components/Icon.jsx";

/**
 * Names the sessions that still run on the tmux server of a release from before the
 * rename; it disappears once none is left (server/features/sessions/legacy-tmux-server.js).
 */
export default function LegacyTmuxNotice({ status, className = "" }) {
  const sessions = Array.isArray(status?.sessions) ? status.sessions : [];
  if (!sessions.length) return null;
  return (
    <div
      className={`system-status-warning legacy-tmux-notice ${className}`.trim()}
      role="status"
    >
      <Icon name="info" size={16} />
      <div>
        <p>
          <strong>{copy.legacyTmuxTitle(sessions.length)}</strong>
          {copy.legacyTmux(sessions.length)}
        </p>
        <ul aria-label={copy.legacyTmuxSessions}>
          {sessions.map((session) => (
            <li key={session.id}>{session.name || session.id}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
