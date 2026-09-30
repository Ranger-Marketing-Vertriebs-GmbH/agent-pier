import { useId, useState } from "react";
import { builtinSlashCommands, slashMatches } from "./slash-commands.js";

export default function useSlashCompletion({
  session,
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
  const commands = builtinSlashCommands(session.tool);
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
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
  };
}
