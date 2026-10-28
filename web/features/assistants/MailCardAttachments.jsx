import React from "react";
import { locale } from "../../lib/i18n/index.js";
import { formatBytes } from "../../lib/format-bytes.js";
import { assistantMailCopy } from "../../lib/i18n/messages/assistant-mail.js";
import SshCommandText from "./SshCommandText.jsx";

// Where an attachment comes from: the file's path (with its project), or the draft
// or forwarded original it already sits in.
function Source({ source }) {
  const card = assistantMailCopy.card;
  if (source?.kind === "original") return card.fromOriginal;
  if (!source?.path) return card.inDraft;
  return (
    <>
      <code>
        <SshCommandText command={source.path} line />
      </code>
      {source.kind === "project" && source.projectName && (
        <>
          {" "}
          (<SshCommandText command={source.projectName} line />)
        </>
      )}
    </>
  );
}

/**
 * Every attachment of an agent's mail card (MailApprovalCard.jsx): its name, size,
 * type, where it comes from and its full SHA-256, the bytes the approval sends.
 */
export default function MailCardAttachments({ attachments }) {
  const card = assistantMailCopy.card;
  if (!attachments?.length) return null;
  return (
    <section className="mail-approval-attachments" aria-label={card.attachments}>
      <strong>{card.attachments}</strong>
      <ul>
        {attachments.map((a, i) => (
          <li key={i} data-field="attachment">
            <span>
              {a.name ? (
                <code>
                  <SshCommandText command={a.name} line />
                </code>
              ) : (
                card.unnamed
              )}
              {" · "}
              {formatBytes(a.size, locale)}
              {" · "}
              <SshCommandText command={String(a.type ?? "")} line />
            </span>
            <span>
              <Source source={a.source} />
            </span>
            <span>
              {card.hash} <code className="mail-approval-hash">{a.sha256}</code>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
