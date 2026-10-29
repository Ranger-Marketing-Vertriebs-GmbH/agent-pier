import { agentChatsCopy as copy } from "../../../lib/i18n/messages/agent-chats.js";

/**
 * The chat bar's Summarize now (AGENTPIER-263): null where the owner may not summarise
 * (an archived or user's chat); else { run, reason }, with the first reason it cannot
 * run now. It runs the long-chat hint's action (useLongChat); what the server refuses
 * beyond this (nothing left to summarise) shows as the chat's error.
 */
export default function summariseAction({
  shown,
  longChat,
  available,
  working,
  compacting,
  empty,
}) {
  if (!shown) return null;
  const reason = compacting
    ? copy.summariseRunning
    : working || longChat.busy
      ? copy.summariseWorking
      : empty
        ? copy.summariseEmpty
        : !available
          ? copy.summariseUnavailable
          : "";
  return { run: longChat.summarise, reason };
}
