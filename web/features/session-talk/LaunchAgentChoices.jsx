import React, { useEffect } from "react";
import GrantPicker from "../../components/GrantPicker.jsx";
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
      <GrantPicker
        stacked
        entries={list.map((agent) => ({ id: agent.id, name: agent.name }))}
        selected={selected}
        onChange={change}
        typeLabel={copy.grantType}
        listLabel={copy.title}
        heading={copy.title}
      />
      <p>{copy.hint}</p>
    </div>
  );
}
