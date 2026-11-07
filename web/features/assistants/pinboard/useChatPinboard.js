import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useMobileLayout from "../../../lib/useMobileLayout.js";
import useKeptScroll from "../useKeptScroll.js";
import usePinboard from "./usePinboard.js";

/**
 * The pinboard of an agent chat in the owner's app: shown in place of the transcript
 * (phones, panes) or docked beside it (desktop). `open` / `setOpen(bool)` show and
 * hide it; `openPinboard(listId | null)` shows it scrolled to a list (`focusListId`),
 * as does `initialPinboard` (`{ listId } | null`) on mount and whenever its value
 * changes. A user's own agent has no pinboard (`enabled` false). On phones and in
 * panes (`pane`) it is the chat's tab (`tab`), else it docks beside the chat
 * (`docked`); the transcript (`output`, `stick`) keeps its place meanwhile.
 */
export default function useChatPinboard(assistant, initialPinboard, chat) {
  const enabled = assistant.userAccess?.mode !== "own";
  const { view, error, markSeen } = usePinboard(enabled ? assistant.id : null);
  const wanted = enabled && initialPinboard ? `${initialPinboard.listId ?? ""}` : null;
  const [state, setState] = useState(() => ({
    open: wanted !== null,
    focusListId: wanted || null,
  }));
  const applied = useRef(wanted);
  useEffect(() => {
    if (wanted === applied.current) return;
    applied.current = wanted;
    if (wanted !== null) setState({ open: true, focusListId: wanted || null });
  }, [wanted]);
  const openPinboard = useCallback(
    (listId = null) => setState({ open: true, focusListId: listId }),
    [],
  );
  const setOpen = useCallback((open) => setState({ open, focusListId: null }), []);
  const context = useMemo(
    () => ({ openPinboard: enabled ? openPinboard : null }),
    [enabled, openPinboard],
  );
  const open = enabled && state.open;
  const compact = useMobileLayout() || Boolean(chat.pane);
  useKeptScroll(chat.output, chat.stick, open && compact);
  return {
    enabled,
    open,
    tab: open && compact,
    docked: open && !compact,
    setOpen,
    focusListId: state.focusListId,
    view,
    error,
    markSeen,
    fresh: view?.fresh ?? 0,
    context,
  };
}
