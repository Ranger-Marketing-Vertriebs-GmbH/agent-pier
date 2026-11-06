// Prompts the TUI submits and still waits to hear about; the oldest is forgotten first.
const maxPrompts = 64;
const imageInputs = new Set(["image", "localImage"]);

function remember(map, key, value) {
  map.delete(key);
  map.set(key, value);
  if (map.size > maxPrompts) map.delete(map.keys().next().value);
}

/**
 * Whether Codex took a prompt the TUI submitted (`turn/start`, `turn/steer`), from
 * the app-server's own messages: its `userMessage` item carries the request's
 * `clientUserMessageId` (`accepted`); a start whose turn completes after a blocking
 * hook and without that item was `dropped`. A blocked steer has no reliable sign and
 * reports nothing; requests without a client id (title generation) are not prompts.
 * `onEvent({ kind, at, imageNames: null, imageCount, reason? })`.
 */
export function codexPromptAcceptance(onEvent) {
  // clientUserMessageId → { threadId, imageCount, start, turnId?, blocked?, reason? }
  const prompts = new Map();
  // A turn/start's RPC id → its clientUserMessageId, until the response names the turn.
  const starts = new Map();
  const pendingStart = (turnId) =>
    typeof turnId === "string"
      ? [...prompts.values()].find((prompt) => prompt.start && prompt.turnId === turnId)
      : undefined;
  const report = (kind, prompt, extra = {}) =>
    onEvent({
      kind,
      at: Date.now(),
      imageNames: null,
      imageCount: prompt.imageCount,
      ...extra,
    });
  return {
    /** A TUI → app-server message. */
    outgoing(message) {
      const { method, params } = message ?? {};
      if (method !== "turn/start" && method !== "turn/steer") return;
      const clientId = params?.clientUserMessageId;
      if (typeof clientId !== "string" || !clientId || !Array.isArray(params.input))
        return;
      const start = method === "turn/start";
      remember(prompts, clientId, {
        threadId: params.threadId,
        imageCount: params.input.filter((input) => imageInputs.has(input?.type)).length,
        start,
      });
      if (start && message.id !== undefined)
        remember(starts, JSON.stringify(message.id), clientId);
    },
    /** An app-server → TUI message. */
    incoming(message) {
      if (!message || typeof message !== "object") return;
      const { method, params } = message;
      if (method === undefined && message.id !== undefined) {
        const key = JSON.stringify(message.id);
        const prompt = prompts.get(starts.get(key));
        starts.delete(key);
        const turnId = message.result?.turn?.id;
        if (prompt && typeof turnId === "string") prompt.turnId = turnId;
        return;
      }
      if (method === "item/started" && params?.item?.type === "userMessage") {
        const clientId = params.item.clientId;
        const prompt = typeof clientId === "string" && prompts.get(clientId);
        if (!prompt || prompt.threadId !== params.threadId) return;
        prompts.delete(clientId);
        report("accepted", prompt);
        return;
      }
      if (method === "hook/completed" && params?.run?.status === "blocked") {
        const prompt = pendingStart(params.turnId);
        if (!prompt) return;
        prompt.blocked = true;
        const reason = params.run.entries?.find?.(
          (entry) => typeof entry?.text === "string" && entry.text,
        )?.text;
        if (reason) prompt.reason = reason;
        return;
      }
      if (method === "turn/completed") {
        const turnId = params?.turn?.id;
        if (typeof turnId !== "string") return;
        for (const [clientId, prompt] of prompts)
          if (prompt.start && prompt.turnId === turnId) {
            prompts.delete(clientId);
            if (prompt.blocked)
              report("dropped", prompt, prompt.reason ? { reason: prompt.reason } : {});
          }
      }
    },
  };
}
