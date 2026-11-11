import { commonCopy } from "../../lib/i18n/messages/common.js";
import {
  credentialListCopy as copy,
  tokenCheckCopy,
} from "../../lib/i18n/messages/repositories.js";
import React, { useState } from "react";
import api from "../../lib/api.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { hostHasPort } from "./hosts.js";
import TokenCheckStatus from "./TokenCheckStatus.jsx";
export default function CredentialList({
  credentials,
  cloning = false,
  setModal,
  label,
  checked = () => {},
  extra,
  marker,
}) {
  const [checking, setChecking] = useState(null);
  const [errors, setErrors] = useState({});
  const check = async (credential) => {
    setChecking(credential.id);
    setErrors(({ [credential.id]: _, ...rest }) => rest);
    try {
      checked(
        await api(`/git-credentials/${encodeURIComponent(credential.id)}/check`, "POST"),
      );
    } catch (error) {
      setErrors((items) => ({ ...items, [credential.id]: error.message }));
    } finally {
      setChecking(null);
    }
  };
  if (!credentials.length)
    return <p className="repository-empty">{copy.repositoryEmpty}</p>;
  return (
    <ul className="github-access-list" aria-label={label}>
      {credentials.map((credential) => (
        <li className="github-access-card" key={credential.id}>
          <div className="github-access-top">
            <div className="github-access-name">
              <h2>{credential.name}</h2>
              {marker?.(credential)}
              {credential.agentDefault && (
                <span className="repository-agent-badge">
                  {copy.repositoryAgentBadge}
                </span>
              )}
              <code>{credential.host}</code>
              {hostHasPort(credential.host) && (
                <p className="field-description">{copy.repositoryDetailsDescription}</p>
              )}
            </div>
            <div className="repository-actions github-access-actions">
              {extra?.(credential)}
              {credential.hasSecret && (
                <button
                  className="button secondary compact"
                  disabled={cloning || checking !== null}
                  aria-label={tokenCheckCopy.checkAriaLabel(credential.name)}
                  onClick={() => check(credential)}
                >
                  {checking === credential.id
                    ? tokenCheckCopy.checking
                    : tokenCheckCopy.check}
                </button>
              )}
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
          <dl className="github-access-facts">
            <div>
              <dt>{copy.columnToken}</dt>
              <dd>
                <TokenCheckStatus
                  hasSecret={credential.hasSecret}
                  check={credential.tokenCheck}
                >
                  <ErrorMessage error={errors[credential.id]} />
                </TokenCheckStatus>
              </dd>
            </div>
            <div>
              <dt>{copy.columnCommitIdentity}</dt>
              <dd className="github-access-identity">
                {credential.commitIdentity ? (
                  `${credential.commitIdentity.name} <${credential.commitIdentity.email}>`
                ) : (
                  <span className="github-access-unset">{copy.commitIdentityUnset}</span>
                )}
              </dd>
            </div>
          </dl>
        </li>
      ))}
    </ul>
  );
}
