import useTalk, { useTalkStatus } from "../talk/useTalk.js";

/**
 * Talk mode in an agent chat (AGENTPIER-291), shown where `shown` (the owner's own
 * chats, not a task member's): `{ shown, talk, status }`. `turn` is useTalk's view of
 * the chat's latest turn; `deliver(text)` sends what was spoken.
 */
export default function useChatTalk({ conversationId, shown, available, turn, deliver }) {
  const status = useTalkStatus(shown);
  const talk = useTalk({
    conversationId,
    enabled: shown && available,
    turn,
    deliver,
  });
  return { shown, talk, status };
}
