import { sessionGithubCopy as copy } from "../../lib/i18n/messages/repositories.js";
import React, { useEffect, useState } from "react";
import api from "../../lib/api.js";
import Icon from "../../components/Icon.jsx";

const attention = new Set(["invalid", "expired", "expiring", "removed"]);

/** The GitHub profiles a session received, and whether its remote can use them. */
export default function SessionGithubStatus({ session }) {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    let alive = true;
    setStatus(null);
    api(`/sessions/${encodeURIComponent(session.id)}/github`)
      .then((data) => alive && setStatus(data))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [session.id, session.createdAt, session.restartGeneration]);
  const hosts = status?.hosts || [];
  // Sessions without a profile and an HTTPS or local remote have nothing to report.
  if (!status || (!hosts.length && status.remote?.protocol !== "ssh")) return null;
  const problems = hosts.filter((item) => attention.has(item.tokenState));
  return (
    <span className="session-github-status">
      <span className="session-github" title={copy.label}>
        <Icon name="link" size={13} />
        {hosts.length
          ? hosts
              .map((item) =>
                item.name ? copy.profile(item.name, item.host) : copy.removed(item.host),
              )
              .join(", ")
          : copy.none}
      </span>
      {problems
        .filter((item) => item.tokenState !== "removed")
        .map((item) => (
          <span key={item.host} className="session-github-warning" role="status">
            {copy.tokenProblem(item.host)}
          </span>
        ))}
      {status.remote?.protocol === "ssh" && (
        <span className="session-github-warning" role="status">
          {copy.sshRemote}
        </span>
      )}
    </span>
  );
}
