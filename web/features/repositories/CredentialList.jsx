import { commonCopy } from "../../lib/i18n/messages/common.js";
import { credentialListCopy as copy } from "../../lib/i18n/messages/repositories.js";
import React from "react";
import { hostHasPort } from "./hosts.js";
export default function CredentialList({ credentials, cloning = false, setModal }) {
  if (!credentials.length)
    return <p className="repository-empty">{copy.repositoryEmpty}</p>;
  return (
    <div
      className="github-access-table"
      role="table"
      aria-labelledby="github-access-title"
    >
      <div className="github-access-row github-access-head" role="row">
        <span role="columnheader">{copy.columnAccess}</span>
        <span role="columnheader">{copy.columnToken}</span>
        <span role="columnheader">{copy.columnCommitIdentity}</span>
        <span role="columnheader" aria-hidden="true" />
      </div>
      {credentials.map((credential) => (
        <div className="github-access-row" role="row" key={credential.id}>
          <div role="cell" className="github-access-name">
            <h3>{credential.name}</h3>
            {credential.agentDefault && (
              <span className="repository-agent-badge">{copy.repositoryAgentBadge}</span>
            )}
            <code>{credential.host}</code>
            {hostHasPort(credential.host) && (
              <p className="field-description">{copy.repositoryDetailsDescription}</p>
            )}
          </div>
          <div role="cell" className="github-access-token">
            <span
              className={`github-access-dot ${credential.hasSecret ? "saved" : "missing"}`}
              aria-hidden="true"
            />
            {credential.hasSecret ? copy.tokenSaved : copy.tokenMissing}
          </div>
          <div role="cell" className="github-access-identity">
            {credential.commitIdentity &&
              `${credential.commitIdentity.name} <${credential.commitIdentity.email}>`}
          </div>
          <div role="cell" className="repository-actions">
            <button
              className="button secondary compact"
              disabled={cloning}
              aria-label={commonCopy.editNamedItem(credential.name)}
              onClick={() =>
                setModal({
                  credential,
                })
              }
            >
              {commonCopy.edit}
            </button>
            <button
              className="button secondary compact"
              disabled={cloning}
              aria-label={copy.buttonAriaLabel(credential.name)}
              onClick={() =>
                setModal({
                  credential,
                  deleting: true,
                })
              }
            >
              {commonCopy.delete}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
