// Codex app-server notifications as streamed reply text: each agent message item is
// one run; its deltas append, its completion or the end of its turn ends it.
// `target` is a NativeRequestChannel (streamDelta/streamEnd).
export function codexReplyObserver(target) {
  return function observe(message) {
    const params = message?.params;
    try {
      if (message?.method === "item/agentMessage/delta") {
        if (
          typeof params?.itemId === "string" &&
          typeof params.delta === "string" &&
          params.delta
        )
          target.streamDelta(params.itemId, params.delta, {
            ...(typeof params.threadId === "string" ? { thread: params.threadId } : {}),
            ...(typeof params.turnId === "string" ? { turn: params.turnId } : {}),
          });
      } else if (
        message?.method === "item/completed" &&
        params?.item?.type === "agentMessage" &&
        typeof params.item.id === "string"
      ) {
        // The completed item carries the whole text: the last delta may be missing.
        if (typeof params.item.text === "string")
          target.streamText(params.item.id, params.item.text);
        target.streamEnd(params.item.id);
      } else if (message?.method === "turn/completed") {
        const turn = params?.turn?.id ?? params?.turnId;
        if (typeof turn === "string") target.streamEnd(undefined, { turn });
      }
    } catch {
      /* Streaming is advisory; the native protocol never waits for it. */
    }
  };
}
