import { useEffect, useRef, useState } from "react";
import { assistantApi } from "../assistants/assistant-api.js";
import useAssistants from "../assistants/useAssistants.js";
import { connectionMissing } from "../assistants/connection-state.js";

/**
 * Opens an agent as its sidebar row does: its latest own chat, else a new main chat;
 * an agent without its connection, a team member and a user's own agent open their
 * settings instead.
 */
export default function useOpenAgent(navigate) {
  const { conversations = [], models = [], refresh } = useAssistants();
  const [busy, setBusy] = useState(null),
    [error, setError] = useState("");
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  async function run(assistant) {
    setError("");
    if (
      assistant.teamMemberId ||
      connectionMissing(assistant, models) ||
      assistant.userAccess?.mode === "own"
    ) {
      navigate({ view: "agents", assistantId: assistant.id, agentSettings: true });
      return;
    }
    const chat = conversations
      .filter(
        (c) =>
          c.assistantId === assistant.id &&
          !c.archivedAt &&
          (!c.channel || c.channel === "agentpier") &&
          typeof c.userId !== "string",
      )
      .sort(
        (a, b) =>
          (b.main === true) - (a.main === true) ||
          String(b.lastActivityAt || b.createdAt).localeCompare(
            String(a.lastActivityAt || a.createdAt),
          ),
      )[0];
    if (chat) {
      navigate({ view: "agents", assistantId: assistant.id, conversationId: chat.id });
      return;
    }
    setBusy(assistant.id);
    try {
      const conversation = await assistantApi.open(assistant.id);
      await refresh();
      if (alive.current)
        navigate({
          view: "agents",
          assistantId: assistant.id,
          conversationId: conversation.id,
        });
    } catch (problem) {
      if (alive.current) setError(problem.message);
    } finally {
      if (alive.current) setBusy(null);
    }
  }
  return { run, busy, error };
}
