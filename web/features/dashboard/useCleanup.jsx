import React, { useCallback, useEffect, useState } from "react";
import { systemStatusCopy as copy } from "../../lib/i18n/messages/system-status.js";
import api from "../../lib/api.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import { statusBytes } from "./system-status-format.js";

export const CLEANUP_API = "/system-status/cleanup";

/** A size, marked "at least" when the measurement stopped at its bound. */
export const cleanupSize = (bytes, partial = false) =>
  partial ? copy.cleanup.atLeast(statusBytes(bytes)) : statusBytes(bytes);

/**
 * One cleanup list, measured when it is opened (never with the status poll), with
 * the confirmation for the item chosen and the freed size afterwards.
 */
export function useCleanup(path) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const [freed, setFreed] = useState(null);
  const [pending, setPending] = useState(null);
  const load = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      setState({
        data: await api(`${CLEANUP_API}/${path}`),
        error: null,
        loading: false,
      });
    } catch (error) {
      setState((current) => ({ ...current, error, loading: false }));
    }
  }, [path]);
  useEffect(() => {
    load();
  }, [load]);
  const dialog = pending && (
    <ConfirmDialog
      destructive
      title={pending.title}
      body={pending.body}
      confirmLabel={pending.confirmLabel}
      onCancel={() => setPending(null)}
      onConfirm={async () => {
        const result = await api(pending.path, pending.method, pending.payload);
        setPending(null);
        setFreed(Number.isFinite(result?.bytes) ? result.bytes : 0);
        await load();
      }}
    >
      {pending.children}
    </ConfirmDialog>
  );
  const feedback = (
    <>
      {state.loading && !state.data && (
        <p className="hint" role="status">
          {copy.cleanup.measuring}
        </p>
      )}
      <ErrorMessage error={state.error?.message} />
      {freed !== null && (
        <p className="hint" role="status">
          {copy.cleanup.freed(statusBytes(freed))}
        </p>
      )}
      {dialog}
    </>
  );
  return { ...state, confirm: setPending, feedback };
}
