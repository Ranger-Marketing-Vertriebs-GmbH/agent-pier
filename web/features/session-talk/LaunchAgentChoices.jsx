import React, { useEffect } from "react";
import CheckRow from "../../components/CheckRow.jsx";
import useResource from "../../lib/useResource.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { sessionTalkCopy } from "../../lib/i18n/messages/session-talk.js";
// The launch dialog's extension blocks share the SSH block's layout (`ssh-launch`).
import "../ssh/ssh.css";

const copy = sessionTalkCopy.launch;

/**
 * The new-session dialog's agents (coding CLIs only), sent as `agentAccessIds`: the
 * session may ask and tell them, and they may write to it, until it stops. Shown only
 * while the owner has agents; ones that left the list drop from the choice.
 */
export default function LaunchAgentChoices({ selected, change }) {
  const agents = useResource("/session-talk/agents");
  const list = agents.data?.agents;
  useEffect(() => {
    if (!list) return;
    const kept = selected.filter((id) => list.some((agent) => agent.id === id));
    if (kept.length !== selected.length) change(kept);
  }, [list, selected, change]);
  if (agents.error)
    return (
      <div className="ssh-launch">
        <p role="alert">{agents.error}</p>
        <button className="button" type="button" onClick={agents.refresh}>
          {commonCopy.retry}
        </button>
      </div>
    );
  if (!list?.length) return null;
  return (
    <div className="ssh-launch">
      <fieldset className="check-list">
        <legend>{copy.title}</legend>
        {list.map((agent) => (
          <CheckRow
            key={agent.id}
            title={agent.name}
            checked={selected.includes(agent.id)}
            onChange={(event) =>
              change(
                event.target.checked
                  ? [...selected, agent.id]
                  : selected.filter((id) => id !== agent.id),
              )
            }
          />
        ))}
      </fieldset>
      <p>{copy.hint}</p>
    </div>
  );
}
