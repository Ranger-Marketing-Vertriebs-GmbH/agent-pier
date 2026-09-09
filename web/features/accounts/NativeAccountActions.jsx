import React, { useState } from "react";
import api from "../../lib/api.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { accountsPageCopy as copy } from "../../lib/i18n/messages/accounts.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";

export default function NativeAccountActions({ account, state, act, refresh, auth }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const native = !account.provider && !account.internal;
  if (!native) return null;
  const selected =
    (state.defaultAccountIds?.[account.tool] || `local-${account.tool}`) === account.id;
  return (
    <>
      {auth === "authenticated" ? (
        <span className="badge">{copy.signedIn}</span>
      ) : (
        account.kind === "managed" &&
        !account.hasSecret && (
          <button
            className="button secondary compact"
            disabled={!state.tools.find((tool) => tool.id === account.tool)?.installed}
            onClick={() => act("login", account)}
          >
            {commonCopy.signIn}
          </button>
        )
      )}
      {selected ? (
        <span className="badge">{copy.defaultAccount}</span>
      ) : (
        <button
          className="button secondary compact"
          aria-label={copy.useDefaultAccount(account.name)}
          disabled={busy}
          onClick={async () => {
            if (busy) return;
            setBusy(true);
            setError("");
            try {
              await api("/preferences", "PATCH", {
                defaultAccountIds: { [account.tool]: account.id },
              });
              await refresh();
            } catch (failure) {
              setError(failure.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {copy.setDefaultAccount}
        </button>
      )}
      <ErrorMessage error={error} />
    </>
  );
}
