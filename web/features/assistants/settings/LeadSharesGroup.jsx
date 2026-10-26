import React, { useId } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow from "../../../components/ListRow.jsx";
import useResource from "../../../lib/useResource.js";
import { leadShareCopy as copy } from "../../../lib/i18n/messages/lead-shares.js";
import { assistantSettingsCopy as settingsCopy } from "../../../lib/i18n/messages/assistant-settings.js";
import {
  leadSharesPath,
  memberGrantDetail,
  memberGrantName,
  shareDetail,
  shareName,
} from "../lead-shares.js";
import RevokeLeadShare from "../RevokeLeadShare.jsx";

/**
 * A member's access shared by its lead agent, kept apart from the access the owner
 * granted it: a permanent member's shares (Work tab), a task-bound member's grants
 * of folders, MCP servers, shell and SSH (Capabilities tab), and coding through the
 * lead for information. The owner revokes any share or grant. With `lead` the group
 * lists what this agent shares with its own members instead (Team tab).
 */
export default function LeadSharesGroup({ assistant, lead = false }) {
  const id = useId();
  const list = useResource(
    leadSharesPath(lead ? { leadId: assistant.id } : { memberId: assistant.id }),
  );
  const shares = list.data?.shares || [];
  const grants = list.data?.memberGrants || [];
  const temporary = assistant.lifetime !== "permanent";
  // A lead's row names the member it shares with; a member's row names its lead.
  const who = (row) =>
    lead
      ? settingsCopy.sharedTo(row.memberName || row.agentName || "")
      : copy.via(row.leadName || "");
  return (
    <section id={lead ? "agent-member-shares" : "agent-lead-shares"} aria-labelledby={id}>
      <GroupLabel
        id={id}
        hint={
          lead
            ? settingsCopy.sharedWithMembersHint
            : temporary
              ? copy.taskHint
              : copy.hint
        }
      >
        {lead ? settingsCopy.sharedWithMembers : copy.title}
      </GroupLabel>
      <ErrorMessage error={list.error} />
      <ListCard labelledBy={id}>
        {!list.data && !list.error && (
          <p role="status" className="agent-row-note">
            {copy.loading}
          </p>
        )}
        {list.data && !shares.length && !grants.length && (
          <p className="agent-row-note">
            {lead ? settingsCopy.sharedWithMembersEmpty : copy.empty}
          </p>
        )}
        {shares.map((share) => (
          <ListRow
            key={share.id}
            className="lead-share-row"
            label={shareName(share)}
            sub={`${who(share)} · ${shareDetail(share)}`}
          >
            <RevokeLeadShare
              share={share}
              what={shareName(share)}
              onRevoked={list.refresh}
            />
          </ListRow>
        ))}
        {grants.map((grant) => (
          <ListRow
            key={grant.id}
            className="lead-share-row"
            label={memberGrantName(grant)}
            sub={`${who(grant)} · ${memberGrantDetail(grant)}${
              grant.revocable ? "" : ` · ${copy.codingFixed}`
            }`}
          >
            {grant.revocable && (
              <RevokeLeadShare
                share={grant}
                what={memberGrantName(grant)}
                onRevoked={list.refresh}
              />
            )}
          </ListRow>
        ))}
      </ListCard>
    </section>
  );
}
