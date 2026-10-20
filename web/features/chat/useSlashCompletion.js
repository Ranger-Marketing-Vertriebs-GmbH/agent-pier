import { useEffect, useId, useState } from "react";
import {
  builtinSlashCommands,
  mergeSlashCommands,
  slashMatches,
} from "./slash-commands.js";

const discoveryTools = new Set(["claude", "codex", "opencode"]);
// The server checks for changes itself; a page asks again after this long.
const refreshMs = 30000;
// Discovered commands per session, shared by every chat of this page.
const discovered = new Map();
// Every mounted completion re-renders when a read finishes, even one that started
// the read under an earlier draft.
const listeners = new Set();

/**
 * The session's discovered slash commands, read once the draft starts with a slash.
 * `failed` means the chat offers only the built-ins.
 */
function useDiscoveredCommands(session, request, wanted) {
  const key = `${session.id}:${session.accountId}:${session.tool}`;
  const [, setVersion] = useState(0);
  const entry = discovered.get(key);
  useEffect(() => {
    const listener = () => setVersion((value) => value + 1);
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, []);
  useEffect(() => {
    if (!wanted || !request || !discoveryTools.has(session.tool)) return;
    const current = discovered.get(key);
    if (current?.loading || (current && Date.now() - current.at < refreshMs)) return;
    discovered.set(key, { ...current, loading: true });
    request(`/sessions/${encodeURIComponent(session.id)}/chat/slash-commands`)
      .then(
        (result) => ({ at: Date.now(), commands: result?.commands || [] }),
        // Keep what an earlier read found; say only when nothing could be read.
        () => ({ at: Date.now(), commands: current?.commands || [], failed: !current }),
      )
      .then((next) => {
        discovered.set(key, next);
        for (const listener of listeners) listener();
      });
  }, [key, request, session.id, session.tool, wanted]);
  return entry || { commands: [] };
}

export default function useSlashCompletion({
  session,
  request,
  text,
  setText,
  setSent,
  input,
  disabled,
}) {
  const id = useId();
  const [focused, setFocused] = useState(false);
  const [selection, setSelection] = useState({ query: "", index: 0 });
  const [dismissed, setDismissed] = useState(null);
  const query = `${session.id}:${session.accountId}:${session.tool}:${text}`;
  const found = useDiscoveredCommands(
    session,
    request,
    focused && !disabled && text.startsWith("/"),
  );
  const commands = mergeSlashCommands(builtinSlashCommands(session.tool), found.commands);
  const matches = slashMatches(commands, text);
  const open = focused && !disabled && dismissed !== query && matches.length > 0;
  const selected =
    selection.query === query ? Math.min(selection.index, matches.length - 1) : 0;
  const choose = (command) => {
    setText(`/${command.name} `);
    setSent(false);
    input.current?.focus({ preventScroll: true });
  };
  const onKeyDown = (event) => {
    if (
      !open ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229 ||
      event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return false;
    if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      setSelection({
        query,
        index:
          (selected + (event.key === "ArrowDown" ? 1 : -1) + matches.length) %
          matches.length,
      });
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setDismissed(query);
      return true;
    }
    if (["Tab", "Enter"].includes(event.key)) {
      event.preventDefault();
      if (!event.repeat) choose(matches[selected]);
      return true;
    }
    return false;
  };
  return {
    id,
    open,
    matches,
    selected,
    choose,
    onKeyDown,
    builtinOnly: Boolean(found.failed),
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
  };
}
