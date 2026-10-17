import React, { useId, useState } from "react";
import GroupLabel from "../../../components/GroupLabel.jsx";
import Segmented from "../../../components/Segmented.jsx";
import { leadRequestCopy as copy } from "../../../lib/i18n/messages/lead-requests.js";
import LeadRequestCard from "../LeadRequestCard.jsx";

const finished = new Set(["completed", "failed", "cancelled", "declined"]);

/**
 * Settings → Work → Teams: the questions and tasks a lead sent its members, grouped
 * by member, open ones first and newest first within each side.
 */
export default function MemberRequests({
  assistant,
  requests,
  members = [],
  busy,
  act,
  navigate,
}) {
  const labelId = useId();
  const own = requests.filter((r) => r.parentAssistantId === assistant.id);
  const done = own.filter((r) => finished.has(r.phase));
  const open = own.filter((r) => !finished.has(r.phase));
  const [view, setView] = useState("open");
  const shown = [...(view === "open" ? open : done)].reverse();
  // The member's chat, where its whole answer is.
  const memberChat = (r) => {
    const m = members.find((x) => x.id === r.memberId);
    return m?.conversationId
      ? { view: "agents", assistantId: m.assistantId, conversationId: m.conversationId }
      : null;
  };
  const byMember = new Map();
  for (const r of shown) {
    if (!byMember.has(r.memberId)) byMember.set(r.memberId, []);
    byMember.get(r.memberId).push(r);
  }
  return (
    <section className="agent-member-requests" aria-labelledby={labelId}>
      <GroupLabel id={labelId} hint={copy.listHint}>
        {copy.listTitle}
      </GroupLabel>
      {own.length ? (
        <div className="agent-teams">
          <Segmented
            label={copy.listTitle}
            className="agent-teams-filter"
            value={view}
            onChange={setView}
            options={[
              { value: "open", label: copy.open(open.length) },
              { value: "finished", label: copy.finished(done.length) },
            ]}
          />
          {[...byMember].map(([memberId, list]) => (
            <div
              key={memberId}
              className="agent-member-request-group"
              role="group"
              aria-label={list[0].memberName}
            >
              <h4>{list[0].memberName}</h4>
              {list.map((r) => (
                <LeadRequestCard
                  key={r.id}
                  request={r}
                  busy={busy}
                  act={act}
                  memberChat={memberChat(r)}
                  navigate={navigate}
                />
              ))}
            </div>
          ))}
        </div>
      ) : (
        <p className="agent-teams-empty">{copy.none}</p>
      )}
    </section>
  );
}
