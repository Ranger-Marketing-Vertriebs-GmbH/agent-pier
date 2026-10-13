import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  mentionMatches,
  mentionQuery,
} from "../../../server/features/assistants/member-mentions.js";

const shown = 8;

/**
 * The lead's members that can be @mentioned, in the shape the parser and the
 * composer use: `{ id, name, role, lifetime, route }`. Archived members and member
 * chats have none, matching what the server accepts as a mention.
 */
export function leadMembers(lead, { assistants = [], members = [], conversations = [] }) {
  if (lead.teamMemberId) return [];
  return assistants
    .filter((a) => a.parentAssistantId === lead.id && a.teamMemberId && !a.archivedAt)
    .flatMap((a) => {
      const record = members.find((m) => m.assistantId === a.id);
      if (record?.archivedAt) return [];
      const chat = conversations.find(
        (c) =>
          c.assistantId === a.id &&
          !c.archivedAt &&
          (!c.channel || c.channel === "agentpier"),
      );
      return [
        {
          id: a.id,
          name: a.name,
          role: record?.role || "",
          lifetime: a.lifetime === "permanent" ? "permanent" : "temporary",
          route: chat
            ? { view: "agents", assistantId: a.id, conversationId: chat.id }
            : { view: "agents", assistantId: a.id, agentSettings: true },
        },
      ];
    });
}

/**
 * The @mention autocomplete of a lead's composer: what is typed after "@" before
 * the caret filters the members; arrows move, Enter or Tab inserts
 * "@<exact name> ", Escape closes until the next "@". `onText` stores new text.
 */
export default function useMemberMention({ members, text, field, onText }) {
  const listId = useId();
  const [caret, setCaret] = useState(null);
  const [dismissed, setDismissed] = useState(-1);
  const [pick, setPick] = useState({ key: "", index: 0 });
  const placed = useRef(null);
  const found = members.length && caret !== null ? mentionQuery(text, caret) : null;
  const typed = found?.query ?? "";
  // "@Max " after a whole name: the mention is complete, Enter sends.
  const complete =
    /\s$/.test(typed) &&
    members.some(
      (m) => m.name.toLocaleLowerCase() === typed.trimEnd().toLocaleLowerCase(),
    );
  const options =
    found && found.start !== dismissed && !complete
      ? mentionMatches(typed, members).slice(0, shown)
      : [];
  const open = options.length > 0;
  const key = `${found?.start}:${typed}`;
  const active = open
    ? pick.key === key
      ? Math.min(pick.index, options.length - 1)
      : 0
    : -1;
  useEffect(() => {
    if (dismissed >= 0 && found?.start !== dismissed) setDismissed(-1);
  }, [dismissed, found?.start]);
  // A press outside the field and the list closes it until the caret moves again.
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event) => {
      const list = document.getElementById(listId);
      if (field.current?.contains(event.target) || list?.contains(event.target)) return;
      setCaret(null);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open, listId, field]);
  // After an insertion the caret goes behind the inserted name and its space.
  useLayoutEffect(() => {
    const element = field.current;
    if (placed.current === null || !element) return;
    const at = placed.current;
    placed.current = null;
    element.focus();
    element.setSelectionRange(at, at);
    setCaret(at);
  }, [text, field]);
  const sync = useCallback(() => {
    const element = field.current;
    setCaret(
      element && element.selectionStart === element.selectionEnd
        ? element.selectionStart
        : null,
    );
  }, [field]);
  const choose = (member) => {
    if (!found) return;
    const before = text.slice(0, found.start);
    const after = text.slice(caret).replace(/^ /, "");
    const insert = `@${member.name} `;
    placed.current = before.length + insert.length;
    setDismissed(found.start);
    onText(before + insert + after);
  };
  const move = (step) =>
    setPick({ key, index: (active + step + options.length) % options.length });
  function onKeyDown(event) {
    if (!open || event.nativeEvent?.isComposing) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp")
      move(event.key === "ArrowDown" ? 1 : -1);
    else if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab")
      choose(options[active]);
    else if (event.key === "Escape") {
      // Closes the list, not the drawer around the chat.
      event.stopPropagation();
      setDismissed(found.start);
    } else return false;
    event.preventDefault();
    return true;
  }
  return {
    enabled: members.length > 0,
    open,
    options,
    active,
    listId,
    optionId: (index) => `${listId}-${index}`,
    hover: (index) => setPick({ key, index }),
    choose,
    onKeyDown,
    sync,
  };
}
