import { useMemo, useRef, useState } from "react";
import {
  emptyHistoryView,
  shownHistory,
  withLive,
  withOlder,
} from "../assistants/agent-history-view.js";
import useAgentConversationStream from "../assistants/useAgentConversationStream.js";
import useAwaitingConfirmation from "../assistants/unconfirmed-turn.js";
import { takeBack } from "../assistants/queued-message.js";
import { sharedDrafts } from "../assistants/useAssistants.js";
import { userApi } from "./user-api.js";
import { useRetry } from "../assistants/run-steps.js";

const settled = new Set(["completed", "failed", "cancelled"]);

/**
 * One of a user's chats: its live window over the agent chat feed (read through
 * /api/me), the draft, sending, the queued message, Stop and the review of an
 * uncertain turn. The owner's chat (AssistantChat.jsx) does the same with his routes;
 * her chat has no teams, members or lead requests. `histories` keeps the last window
 * of each opened chat (agent-offline.js), so it shows while offline. `onCreated(id)`
 * opens the chat a `/new` started.
 */
export default function useUserConversation(
  conversationId,
  { histories, readOnly, onCreated },
) {
  const drafts = sharedDrafts;
  const [text, setText] = useState(() => drafts.get(conversationId));
  const [view, setView] = useState(() => {
    const cached = histories.get(conversationId);
    return cached ? withLive(emptyHistoryView, cached) : emptyHistoryView;
  });
  const history = useMemo(() => shownHistory(view), [view]);
  const [unreachable, setUnreachable] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const typed = useRef(text);
  typed.current = text;
  const appending = useRef({ busy: false, last: null });
  const feed = useAgentConversationStream(conversationId, {
    initial: histories.get(conversationId),
    feed: userApi.feed,
    onLive: (live) => {
      setView((current) => withLive(current, live));
      histories.set(conversationId, live);
    },
    onReachable: (reachable) => setUnreachable(!reachable),
  });
  const refresh = feed.refresh;
  const latest = history.requests?.at(-1);
  const active =
    latest?.attempt && !latest.attempt.reviewedAt && !settled.has(latest.attempt.state);
  const awaiting = useAwaitingConfirmation(
    latest?.attempt,
    `${history.messages.length}:${feed.stream?.text?.length ?? 0}`,
  );
  const uncertain =
    !awaiting && ["uncertain", "interrupted"].includes(latest?.attempt?.state);
  const queued = history.queued || null;
  const available = !readOnly && !unreachable;
  const run = async (action) => {
    setError("");
    try {
      return await action();
    } catch (e) {
      setError(e.message);
      return false;
    }
  };
  async function deliver(submitted, ids, accepted) {
    setBusy(true);
    try {
      return await run(async () => {
        const result = await userApi.send(
          conversationId,
          ids.length ? { ...submitted, attachments: ids } : submitted,
        );
        accepted?.();
        // `/new` started a chat (chat-commands.js): it opens instead.
        if (result?.created) await onCreated?.(result.created);
        else await refresh();
        return true;
      });
    } finally {
      setBusy(false);
    }
  }
  // While the agent works, or a message still waits, the next one is queued.
  async function queue(ids) {
    if (!available || (!text.trim() && !ids.length)) return false;
    const append = appending.current;
    if (append.busy) return false;
    const submitted = text;
    const content = JSON.stringify([text, ids]);
    if (append.last?.content !== content)
      append.last = { content, id: crypto.randomUUID() };
    append.busy = true;
    try {
      return await run(async () => {
        await userApi.queue(conversationId, {
          text,
          ...(ids.length ? { attachments: ids } : {}),
          appendId: append.last.id,
        });
        append.last = null;
        if (drafts.get(conversationId) === submitted) {
          drafts.clear(conversationId);
          setText("");
        }
        await refresh();
        return true;
      });
    } finally {
      append.busy = false;
    }
  }
  async function send(event, ids = []) {
    event.preventDefault();
    if (active || queued || history.compacting) return queue(ids);
    if (!available || busy || (!text.trim() && !ids.length)) return false;
    const submitted = drafts.delivery(conversationId);
    return deliver(submitted, ids, () => {
      if (drafts.acknowledge(conversationId, submitted.clientRequestId)) setText("");
    });
  }
  async function takeBackQueued(attachments) {
    await run(async () => {
      const back = await userApi.takeBackQueued(conversationId);
      const value = takeBack(back.text, typed.current);
      setText(value);
      drafts.set(conversationId, value);
      attachments.restore(back.attachments || []);
    });
    await refresh();
  }
  // `beforePrepend` runs right before the older page lands, to keep the reader's place.
  const earlier = (beforePrepend) =>
    run(async () => {
      const page = await userApi.history(conversationId, history.nextBefore);
      beforePrepend?.();
      setView((current) => withOlder(current, page));
    });
  const stop = () =>
    run(async () => {
      await userApi.cancel(latest.attempt.id);
      await refresh();
      return true;
    });
  const retry = useRetry({ active, stop, deliver, setBusy });
  async function recover() {
    setBusy(true);
    await run(async () => {
      await userApi.recover(latest.attempt.id);
      await refresh();
    });
    setBusy(false);
  }
  return {
    drafts,
    text,
    setText,
    view,
    history,
    feed,
    latest,
    active: Boolean(active),
    awaiting,
    uncertain,
    shownAttempt: awaiting
      ? { ...latest.attempt, state: "unconfirmed" }
      : latest?.attempt,
    queued,
    available,
    unreachable,
    error: error || feed.error,
    setError,
    busy,
    refresh,
    send,
    takeBackQueued,
    earlier,
    stop,
    retry,
    recover,
  };
}
