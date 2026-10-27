import { useEffect, useRef, useState } from "react";
import { assistantApi } from "../assistants/assistant-api.js";
import useAssistants from "../assistants/useAssistants.js";
import { connectionMissing } from "../assistants/connection-state.js";

/**
 * The chats an agent row opens, as the sidebar lists them (AssistantSidebar.jsx): the
 * owner's own open chats, main chat first, then the most recently active; for a
 * user's own agent also hers.
 */
export function agentChats(assistant, conversations = []) {
  return conversations
    .filter(
      (c) =>
        c.assistantId === assistant.id &&
        !c.archivedAt &&
        (!c.channel || c.channel === "agentpier") &&
        (assistant.userAccess?.mode === "own" || typeof c.userId !== "string"),
    )
    .sort(
      (a, b) =>
        (b.main === true) - (a.main === true) ||
        String(b.lastActivityAt || b.createdAt).localeCompare(
          String(a.lastActivityAt || a.createdAt),
        ),
    );
}

/**
 * Opens an agent as its sidebar row does: an existing chat first; else a team member,
 * an agent without its connection and a user's own agent open their settings; else a
 * new main chat. Only the latest open navigates; a slower earlier one is ignored.
 */
export default function useOpenAgent(navigate) {
  const { conversations = [], models = [], refresh } = useAssistants();
  const [busy, setBusy] = useState(null),
    [error, setError] = useState("");
  const request = useRef(null);
  useEffect(
    () => () => {
      request.current = null;
    },
    [],
  );
  async function run(assistant) {
    const ticket = {};
    request.current = ticket;
    setError("");
    const chat = agentChats(assistant, conversations)[0];
    if (chat) {
      navigate({ view: "agents", assistantId: assistant.id, conversationId: chat.id });
      return;
    }
    if (
      assistant.teamMemberId ||
      connectionMissing(assistant, models) ||
      assistant.userAccess?.mode === "own"
    ) {
      navigate({ view: "agents", assistantId: assistant.id, agentSettings: true });
      return;
    }
    setBusy(assistant.id);
    try {
      const conversation = await assistantApi.open(assistant.id);
      await refresh();
      if (request.current === ticket)
        navigate({
          view: "agents",
          assistantId: assistant.id,
          conversationId: conversation.id,
        });
    } catch (problem) {
      if (request.current === ticket) setError(problem.message);
    } finally {
      if (request.current === ticket) setBusy(null);
    }
  }
  return { run, busy, error };
}
