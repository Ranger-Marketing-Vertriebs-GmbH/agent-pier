import { commonCopy } from "../../lib/i18n/messages/common.js";
import { credentialListCopy as copy } from "../../lib/i18n/messages/repositories.js";
import React from "react";
import { hostHasPort } from "./hosts.js";
export default function CredentialList({ credentials, cloning, setModal }) {
  return (
    <div className="repository-credentials">
      {credentials.length ? (
        credentials.map((credential) => (
          <article className="repository-credential" key={credential.id}>
            <div className="repository-details">
              <h3>{credential.name}</h3>
              <p>{credential.host}</p>
              <span className="repository-secret-state">
                {credential.hasSecret ? copy.tokenSaved : copy.tokenMissing}
              </span>
              {credential.agentDefault && (
                <span className="repository-agent-badge">
                  {copy.repositoryAgentBadge}
                </span>
              )}
              {hostHasPort(credential.host) && <p>{copy.repositoryDetailsDescription}</p>}
            </div>
            <div className="repository-actions">
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
          </article>
        ))
      ) : (
        <p className="repository-empty">{copy.repositoryEmpty}</p>
      )}
    </div>
  );
}
