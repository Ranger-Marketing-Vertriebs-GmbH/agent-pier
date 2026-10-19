import React, { useId } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow from "../../../components/ListRow.jsx";
import useResource from "../../../lib/useResource.js";
import { leadShareCopy as copy } from "../../../lib/i18n/messages/lead-shares.js";
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
 * lead for information. The owner revokes any share or grant.
 */
export default function LeadSharesGroup({ assistant }) {
  const id = useId();
  const list = useResource(leadSharesPath({ memberId: assistant.id }));
  const shares = list.data?.shares || [];
  const grants = list.data?.memberGrants || [];
  const temporary = assistant.lifetime !== "permanent";
  return (
    <section id="agent-lead-shares" aria-labelledby={id}>
      <GroupLabel id={id} hint={temporary ? copy.taskHint : copy.hint}>
        {copy.title}
      </GroupLabel>
      <ErrorMessage error={list.error} />
      <ListCard labelledBy={id}>
        {!list.data && !list.error && (
          <p role="status" className="agent-row-note">
            {copy.loading}
          </p>
        )}
        {list.data && !shares.length && !grants.length && (
          <p className="agent-row-note">{copy.empty}</p>
        )}
        {shares.map((share) => (
          <ListRow
            key={share.id}
            className="lead-share-row"
            label={shareName(share)}
            sub={`${copy.via(share.leadName || "")} · ${shareDetail(share)}`}
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
            sub={`${copy.via(grant.leadName || "")} · ${memberGrantDetail(grant)}${
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
