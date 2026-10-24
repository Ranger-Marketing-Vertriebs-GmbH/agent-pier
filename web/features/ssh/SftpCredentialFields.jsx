import React from "react";
import Segmented from "../../components/Segmented.jsx";
import { sshCopy as copy } from "../../lib/i18n/messages/ssh.js";

/** Sign-in choice, password and allowed folder of an SFTP host. */
export default function SftpCredentialFields({
  draft,
  change,
  hasPassword,
  passwordRequired,
  keySelect,
}) {
  return (
    <>
      <div className="ssh-field">
        <span>{copy.signIn}</span>
        <Segmented
          label={copy.signIn}
          value={draft.auth}
          onChange={(value) => change("auth", value)}
          options={[
            { value: "password", label: copy.signInPassword },
            { value: "key", label: copy.signInKey },
          ]}
        />
      </div>
      {draft.auth === "password" ? (
        <label>
          {copy.password}
          <input
            type="password"
            autoComplete="new-password"
            required={passwordRequired}
            maxLength={1024}
            value={draft.password}
            onChange={(event) => change("password", event.target.value)}
          />
          <small className="ssh-action-hint">
            {hasPassword ? copy.passwordSaved : copy.passwordHint}
          </small>
        </label>
      ) : (
        keySelect
      )}
      <label>
        {copy.remoteRoot}
        <input
          type="text"
          maxLength={1024}
          placeholder="/srv/files"
          value={draft.remoteRoot}
          onChange={(event) => change("remoteRoot", event.target.value)}
        />
        <small className="ssh-action-hint">{copy.remoteRootHint}</small>
      </label>
    </>
  );
}
