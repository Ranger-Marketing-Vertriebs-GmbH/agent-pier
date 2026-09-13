import { commonCopy } from "../../lib/i18n/messages/common.js";
import { credentialDialogCopy as copy } from "../../lib/i18n/messages/repositories.js";
import Modal from "../../components/Modal.jsx";
import useAsyncAction from "../../lib/useAsyncAction.js";
import api from "../../lib/api.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import React, { useState } from "react";
import { hostOrigin, hostHasPort } from "./hosts.js";
export default function CredentialDialog({
  credential,
  credentials,
  deleting,
  close,
  saved,
}) {
  const { busy, error, run, lock } = useAsyncAction();
  const [identityName, setIdentityName] = useState(
    credential?.commitIdentity?.name || "",
  );
  const [identityEmail, setIdentityEmail] = useState(
    credential?.commitIdentity?.email || "",
  );
  const [identityError, setIdentityError] = useState("");
  const [host, setHost] = useState(credential?.host || "https://github.com");
  const [chosenDefault, setChosenDefault] = useState(
    credential ? Boolean(credential.agentDefault) : null,
  );
  const firstOnHost = !credentials.some(
    (item) => item.id !== credential?.id && hostOrigin(item.host) === hostOrigin(host),
  );
  const agentDefault = firstOnHost || Boolean(chosenDefault);
  const dismiss = () => {
    if (!lock.current) close();
  };
  return (
    <Modal
      className="repository-dialog"
      title={
        deleting
          ? copy.repositoryDialogTitle
          : credential
            ? commonCopy.editToken
            : commonCopy.addToken
      }
      close={dismiss}
      closeDisabled={busy}
      dismissOnBackdrop={false}
      closeIcon="×"
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (lock.current) return;
          const form = new FormData(event.currentTarget);
          setIdentityError("");
          if (
            !deleting &&
            (identityName || identityEmail) &&
            (!identityName.trim() ||
              /[<>\x00-\x1f\x7f]/.test(identityName) ||
              !/^[^\s<>@]+@[^\s<>@]+$/.test(identityEmail))
          ) {
            setIdentityError(copy.commitIdentityInvalid);
            return;
          }
          await run(async () => {
            const body = {
              name: form.get("name")?.trim(),
              host: form.get("host")?.trim(),
            };
            body.agentDefault = agentDefault;
            if (identityName || identityEmail)
              body.commitIdentity = {
                name: identityName.trim(),
                email: identityEmail.trim(),
              };
            else if (credential?.commitIdentity) body.commitIdentity = null;
            if (form.get("token")) body.token = form.get("token");
            const result = await api(
              credential
                ? `/git-credentials/${encodeURIComponent(credential.id)}`
                : "/git-credentials",
              deleting ? "DELETE" : credential ? "PATCH" : "POST",
              deleting ? undefined : body,
            ).catch((failure) => {
              if (failure.message === "INVALID_COMMIT_IDENTITY")
                throw new Error(copy.commitIdentityInvalid);
              throw failure;
            });
            saved(result, deleting ? credential.id : null);
            close();
          });
        }}
      >
        <fieldset className="form-content repository-fields" disabled={busy}>
          {deleting ? (
            <p className="confirm-copy">
              {copy.deleteCredentialPrefix}
              {credential.name}
              {copy.deleteCredentialSuffix}
            </p>
          ) : (
            <>
              <p className="field-description">{copy.multipleProfilesDescription}</p>
              <label>
                {commonCopy.profileName}
                <input
                  name="name"
                  required
                  autoFocus
                  maxLength={100}
                  defaultValue={credential?.name || ""}
                  placeholder={copy.profileNamePlaceholder}
                />
              </label>
              <label>
                {commonCopy.githubHost}
                <input
                  name="host"
                  required
                  value={host}
                  onChange={(event) => setHost(event.target.value)}
                  placeholder="https://github.example.com"
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </label>
              <p className="field-description">{copy.enterpriseHostDescription}</p>
              <label>
                {copy.commitName}
                <input
                  name="commitName"
                  maxLength={100}
                  value={identityName}
                  onChange={(event) => setIdentityName(event.target.value)}
                  required={Boolean(identityEmail)}
                  autoComplete="off"
                />
              </label>
              <label>
                {copy.commitEmail}
                <input
                  name="commitEmail"
                  type="email"
                  maxLength={254}
                  value={identityEmail}
                  onChange={(event) => setIdentityEmail(event.target.value)}
                  required={Boolean(identityName)}
                  autoComplete="off"
                />
              </label>
              <p className="field-description">{copy.commitIdentityHint}</p>
              {hostHasPort(host) && (
                <p className="field-description">{copy.githubCliPortRestriction}</p>
              )}
              <label className="repository-agent-choice">
                <input
                  type="checkbox"
                  name="agentDefault"
                  checked={agentDefault}
                  disabled={firstOnHost}
                  onChange={(event) => setChosenDefault(event.target.checked)}
                />
                <span>{copy.repositoryAgentChoiceLabel}</span>
              </label>
              {firstOnHost && (
                <p className="field-description">
                  {copy.firstCredentialDefaultDescription}
                </p>
              )}
              <label>
                {copy.formContentFieldLabel}
                <input
                  name="token"
                  type="password"
                  required={!credential || !credential.hasSecret}
                  autoComplete="new-password"
                  spellCheck={false}
                  placeholder={
                    credential?.hasSecret
                      ? copy.savedTokenPlaceholder
                      : "GitHub Access Token"
                  }
                />
              </label>
              <p className="field-description">
                {credential?.hasSecret
                  ? copy.blankTokenPreservesSecret
                  : copy.tokenPrivacyDescription}
              </p>
            </>
          )}
          <ErrorMessage error={identityError || error} />
        </fieldset>
        <div className="dialog-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={dismiss}
          >
            {commonCopy.cancel}
          </button>
          <button className={`button ${deleting ? "danger" : "primary"}`} disabled={busy}>
            {busy
              ? commonCopy.pending
              : deleting
                ? commonCopy.deleteToken
                : commonCopy.saveToken}
          </button>
        </div>
      </form>
    </Modal>
  );
}
