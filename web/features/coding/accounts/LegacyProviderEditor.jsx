import React, { useEffect, useRef } from "react";
import { connectionCopy } from "../../../lib/i18n/messages/connections.js";
import ProviderFields from "../../providers/ProviderFields.jsx";
import useAccountProvider from "../../providers/useAccountProvider.js";

/**
 * The legacy per-account provider of an older managed account. It keeps its own
 * catalog state and reports the selection to the draft; the parent remounts it to
 * discard the selection.
 */
export default function LegacyProviderEditor({ account, onChange }) {
  const provider = useAccountProvider(account, account.tool);
  const report = useRef(onChange);
  report.current = onChange;
  const value = provider.changed ? { selection: provider.selection } : null;
  const key = JSON.stringify(value);
  useEffect(() => {
    report.current({ value, ready: provider.ready, providerId: provider.providerId });
    // `key` captures every change of `value`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, provider.ready, provider.providerId]);
  return (
    <>
      <p className="field-description">{connectionCopy.legacyHelp}</p>
      <ProviderFields controller={provider} tool={account.tool} />
    </>
  );
}
