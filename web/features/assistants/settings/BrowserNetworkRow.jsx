import React, { useState } from "react";
import { ToggleRow } from "../../../components/ListRow.jsx";
import ConfirmDialog from "../../../components/ConfirmDialog.jsx";
import api from "../../../lib/api.js";
import { assistantBrowserCopy as copy } from "../../../lib/i18n/messages/assistant-browser.js";

/** Global owner setting, saved independently of the agent's capability draft. */
export default function BrowserNetworkRow({ network, refresh }) {
  const [next, setNext] = useState(null);
  if (!network) return null;
  const status =
    network.active === null
      ? copy.networkNextStart
      : network.active !== network.allowPrivateNetwork
        ? network.active
          ? copy.networkPendingOff
          : copy.networkPendingOn
        : network.active
          ? copy.networkActive
          : copy.networkBlocked;
  const save = async () => {
    await api("/assistant-browser-network", "PUT", {
      revision: network.revision,
      allowPrivateNetwork: next,
      confirmRestart: true,
    });
    setNext(null);
    await refresh?.();
  };
  return (
    <>
      <ToggleRow
        label={copy.networkTitle}
        sub={`${copy.networkDescription} ${status}`}
        checked={network.allowPrivateNetwork}
        onChange={setNext}
      />
      {next !== null && (
        <ConfirmDialog
          focusCancel
          title={next ? copy.networkEnableTitle : copy.networkDisableTitle}
          body={[
            next ? copy.networkEnableBody : copy.networkDisableBody,
            copy.networkRestart,
          ]}
          confirmLabel={copy.networkSave}
          onConfirm={save}
          onCancel={() => setNext(null)}
        />
      )}
    </>
  );
}
