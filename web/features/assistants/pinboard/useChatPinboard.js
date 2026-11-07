import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useMobileLayout from "../../../lib/useMobileLayout.js";
import useKeptScroll from "../useKeptScroll.js";
import usePinboard from "./usePinboard.js";

/**
 * The pinboard of an agent chat in the owner's app: shown in place of the transcript
 * (phones, panes) or docked beside it (desktop). `open` / `setOpen(bool)` show and
 * hide it; `openPinboard(listId | null)` shows it scrolled to a list (`focusListId`),
 * as does `initialPinboard` (`{ listId, onClose? } | null`; `onClose` runs when it
 * is hidden, or at once for an agent without a pinboard) on mount and whenever its
 * value changes. A user's own agent has no pinboard (`enabled` false). On phones and
 * in panes (`pane`) it is the chat's tab (`tab`), else it docks beside the chat
 * (`docked`); the transcript (`output`, `stick`) keeps its place meanwhile.
 * `reading` (`{ listId, entryId } | null`, set by `setReading`) is the file the
 * reader shows; on a phone it fills the screen (`fullScreen`).
 */
export default function useChatPinboard(assistant, initialPinboard, chat) {
  const enabled = assistant.userAccess?.mode !== "own";
  const { view, error, markSeen } = usePinboard(enabled ? assistant.id : null);
  const wanted = enabled && initialPinboard ? `${initialPinboard.listId ?? ""}` : null;
  const [state, setState] = useState(() => ({
    open: wanted !== null,
    focusListId: wanted || null,
    reading: null,
  }));
  const applied = useRef(wanted);
  useEffect(() => {
    if (wanted === applied.current) return;
    applied.current = wanted;
    if (wanted !== null)
      setState({ open: true, focusListId: wanted || null, reading: null });
  }, [wanted]);
  const openPinboard = useCallback(
    (listId = null) => setState({ open: true, focusListId: listId, reading: null }),
    [],
  );
  const link = useRef(initialPinboard);
  link.current = initialPinboard;
  const setOpen = useCallback((open) => {
    setState({ open, focusListId: null, reading: null });
    // The address that opened the pinboard drops its link (`initialPinboard.onClose`).
    if (!open) link.current?.onClose?.();
  }, []);
  // An agent without a pinboard drops a pinboard link at once.
  const linked = Boolean(initialPinboard);
  useEffect(() => {
    if (!enabled && linked) link.current?.onClose?.();
  }, [enabled, linked]);
  // Opening a file consumes the list a link or card scrolled to: Back returns to
  // where the owner was, not to that list.
  const setReading = useCallback(
    (reading) =>
      setState((current) => ({
        ...current,
        reading,
        focusListId: reading ? null : current.focusListId,
      })),
    [],
  );
  const context = useMemo(
    () => ({ openPinboard: enabled ? openPinboard : null }),
    [enabled, openPinboard],
  );
  const open = enabled && state.open;
  const phone = useMobileLayout();
  const compact = phone || Boolean(chat.pane);
  useKeptScroll(chat.output, chat.stick, open && compact);
  const reading =
    open && state.reading && view?.lists.some((list) => list.id === state.reading.listId)
      ? state.reading
      : null;
  return {
    enabled,
    open,
    tab: open && compact,
    docked: open && !compact,
    setOpen,
    focusListId: state.focusListId,
    reading,
    setReading,
    fullScreen: Boolean(reading) && phone && !chat.pane,
    view,
    error,
    markSeen,
    fresh: view?.fresh ?? 0,
    context,
  };
}
