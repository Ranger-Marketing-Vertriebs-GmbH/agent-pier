import { extensionProfiles } from "../features/extensions/sharedProfiles.js";
import { sharingCopy } from "../lib/i18n/messages/sharing.js";
import { commonCopy } from "../lib/i18n/messages/common.js";
import React, { useState } from "react";
export default function ProfilePage({
  accounts = [],
  shared = false,
  request,
  profileId,
  onProfileChange,
  className = "",
  eyebrow,
  subtitle,
  title,
  description,
  component: Profile,
  loadingRole = "status",
}) {
  const profiles = extensionProfiles(accounts, shared);
  const [accountId, setAccountId] = useState("");
  const [busy, setBusy] = useState(false);
  const account =
    profiles.find((item) => item.id === (profileId ?? accountId)) ||
    (!profileId ? profiles[0] : null);
  return (
    <div className={`page extensions-page${className ? ` ${className}` : ""}`}>
      <div className="page-topline">
        <span>{eyebrow}</span>
        <span className="subtle">{subtitle}</span>
      </div>
      <header className="page-heading">
        <div>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
      </header>
      <label className="extension-profile">
        {shared ? sharingCopy.cli : commonCopy.profile}
        <select
          aria-label={shared ? sharingCopy.cli : commonCopy.profile}
          disabled={busy}
          value={account?.id || ""}
          onChange={(event) =>
            onProfileChange
              ? onProfileChange(event.target.value)
              : setAccountId(event.target.value)
          }
        >
          {profiles.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
              {shared ? "" : ` · ${item.tool}`}
            </option>
          ))}
        </select>
      </label>
      {shared && <p className="field-description">{sharingCopy.description}</p>}
      {account ? (
        <Profile
          key={account.id}
          account={account}
          request={request}
          setParentBusy={setBusy}
        />
      ) : (
        <p className="loading" role={loadingRole}>
          {commonCopy.profilesLoading}
        </p>
      )}
    </div>
  );
}
