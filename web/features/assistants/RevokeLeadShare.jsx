import React, { useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import { leadShareCopy as copy } from "../../lib/i18n/messages/lead-shares.js";
import { revokeLeadShare } from "./lead-shares.js";
import "./lead-shares.css";

/**
 * Revokes one share a lead agent gave its permanent member, after a confirmation:
 * the member loses that access at once (docs/ui-guide.md#confirmations).
 */
export default function RevokeLeadShare({ share, what, onRevoked }) {
  const [open, setOpen] = useState(false);
  const member = share.memberName || share.agentName || "";
  return (
    <>
      <button
        type="button"
        className="button destructive compact"
        data-revoke-share={share.id}
        aria-label={copy.revokeLabel(what, member)}
        onClick={() => setOpen(true)}
      >
        {copy.revoke}
      </button>
      {open && (
        <ConfirmDialog
          title={copy.confirmTitle(what, member)}
          body={copy.confirmBody(share.leadName || "")}
          confirmLabel={copy.confirmLabel}
          destructive
          onCancel={() => setOpen(false)}
          onConfirm={async () => {
            await revokeLeadShare(share.id);
            setOpen(false);
            onRevoked?.();
          }}
        />
      )}
    </>
  );
}
