import { commonCopy } from "../../lib/i18n/messages/common.js";
import StatusDot from "../../components/StatusDot.jsx";
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
    <div className="github-access-table" role="table" aria-label={label}>
      <div className="github-access-row github-access-head" role="row">
        <span role="columnheader">{copy.columnAccess}</span>
        <span role="columnheader">{copy.columnToken}</span>
        <span role="columnheader">{copy.columnCommitIdentity}</span>
        <span role="columnheader" aria-hidden="true" />
      </div>
      {credentials.map((credential) => (
        <div className="github-access-row" role="row" key={credential.id}>
          <div role="cell" className="github-access-name">
            <h2>{credential.name}</h2>
            {credential.agentDefault && (
              <span className="repository-agent-badge">{copy.repositoryAgentBadge}</span>
            )}
            <code>{credential.host}</code>
            {hostHasPort(credential.host) && (
              <p className="field-description">{copy.repositoryDetailsDescription}</p>
            )}
          </div>
          <div role="cell" className="github-access-token">
            <StatusDot
              tone={credential.hasSecret ? "ok" : "idle"}
              className="github-access-dot"
            />
            <div>
              {credential.hasSecret ? copy.tokenSaved : copy.tokenMissing}
              {credential.hasSecret && <TokenCheckStatus check={credential.tokenCheck} />}
              {errors[credential.id] && <ErrorMessage error={errors[credential.id]} />}
            </div>
          </div>
          <div role="cell" className="github-access-identity">
            {credential.commitIdentity &&
              `${credential.commitIdentity.name} <${credential.commitIdentity.email}>`}
          </div>
          <div role="cell" className="repository-actions">
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
      ))}
    </div>
  );
}
