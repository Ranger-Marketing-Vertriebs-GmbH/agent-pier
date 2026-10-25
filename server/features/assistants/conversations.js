import { queuedView } from "./queued-dispatch.js";
import { createHash } from "node:crypto";
import { assistantProblem } from "./assistant-validation.js";
import { actionNotes } from "./assistant-action-notifications.js";
import { requestsWithSources, turnKey, withMessageSources } from "./message-source.js";
import { shownTurnText } from "./plain-turn-text.js";
import {
  requestsWithAttachments,
  withAttachments,
  withSharedFiles,
} from "./attachment-history.js";
import { withRoutineResults } from "./routine-results.js";
import { areaResult, eventArea } from "./agent-event-area.js";
import { withMemoryNotes } from "./memory-notes.js";
import { peerNotes } from "./peer-notes.js";
import { turnKind } from "./goal-turns.js";
import { historyTextLimit } from "./history-text.js";
import { cachedWindow } from "./assistant-store.js";
import { completePage, historyReads, withoutMarks } from "./history-completion.js";
import { confirmFromTranscript } from "./run-confirmation.js";
import { imageResultArtifact } from "./generated-images.js";
import { fileRequest } from "./agent-share-store.js";
// A compaction marker (OpenClaw 2026.10.3: a system message with
// `__openclaw.kind: "compaction"` and its token counts) is a chat note only where the
// chat asks for it (`compactions`); every other reader sees the turns alone.
const tokenCount = (n) => (Number.isFinite(n) && n >= 0 ? n : null);
function compactionNote(m) {
  const meta = m.__openclaw;
  return {
    id: `compaction:${meta.id}`,
    role: "event",
    event: "compaction",
    tokensBefore: tokenCount(meta.tokensBefore),
    tokensAfter: tokenCount(meta.tokensAfter),
    timestamp: m.timestamp || 0,
    runId: null,
  };
}
export function publicMessages(messages = [], { compactions = false } = {}) {
  const seen = new Set();
  return messages.flatMap((m) => {
    if (
      compactions &&
      m?.role === "system" &&
      m.__openclaw?.kind === "compaction" &&
      typeof m.__openclaw.id === "string" &&
      !seen.has(`compaction:${m.__openclaw.id}`)
    ) {
      seen.add(`compaction:${m.__openclaw.id}`);
      return [compactionNote(m)];
    }
    if (!["user", "assistant"].includes(m.role)) return [];
    // OpenClaw's own turns (2026.10.7 shows an exec completion's event turn in the
    // history; 2026.10.3 hid its heartbeat) are never the owner's words.
    if (m.role === "user" && m.provenance?.kind === "internal_system") return [];
    const raw =
      typeof m.content === "string"
        ? m.content
        : (m.content || [])
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n");
    const text = m.role === "user" ? shownTurnText(raw) : raw;
    if (!text) return [];
    const id =
      m.__openclaw?.id ||
      createHash("sha256")
        .update(JSON.stringify([m.role, m.timestamp, text]))
        .digest("hex");
    if (seen.has(id)) return [];
    seen.add(id);
    const key = m.role === "user" && turnKey(m);
    const image = imageResultArtifact(m);
    return [
      {
        id,
        role: m.role,
        text,
        timestamp: m.timestamp || 0,
        runId: m.__openclaw?.runId || null,
        // Internal: links the turn to its attempt (message-source.js), never served.
        ...(key && { turnKey: key }),
        // Internal: the image a background image turn delivers (imageResults).
        ...(image !== null && { imageArtifact: image }),
      },
    ];
  });
}
// Turns AgentPier itself submits for synthesis carry attributed reports, not owner
// words. The ledger keeps their exact text for audit; the visible history shows a
// compact event in their place.
export const internalKinds = new Set([
  "team-result",
  "coding-result",
  "member-result",
  // A sibling's answer in the asking member's chat (peer-requests.js).
  "peer-result",
  "memory-result",
  // The memory step before a summary (memory-write-policy.js memoryStep).
  "memory-step",
  // A lead's note that its member's task chat grew long (member-long-chats.js).
  "member-long-chat",
  "ssh-result",
  "sftp-result",
  // AgentPier asks the agent to continue its open work goal (goal-turns.js).
  "goal-continuation",
]);
function hideInternal(messages, requests, contexts, attempts) {
  const kindFor = (id) => {
    const kind = turnKind(contexts.get(id));
    return internalKinds.has(kind) ? kind : null;
  };
  const internal = requests
    .map((r) => [r, kindFor(r.id)])
    .filter(([, kind]) => kind !== null);
  if (!internal.length) return { messages, requests };
  // A turn's delivery key names its request; the text decides only without one.
  const entryOf = (m) => {
    if (m.turnKey && attempts.has(m.turnKey)) {
      const id = attempts.get(m.turnKey);
      const kind = kindFor(id);
      return kind ? [id, kind] : null;
    }
    const found = internal.find(([r]) => m.text === r.text || m.text.endsWith(r.text));
    return found ? [found[0].id, found[1]] : null;
  };
  return {
    messages: messages.map((m) => {
      const entry = m.role === "user" && entryOf(m);
      if (!entry) return m;
      const [id, kind] = entry;
      return {
        id: m.id,
        role: "event",
        event: kind,
        ...(kind === "goal-continuation" && {
          goalTitle: contexts.get(id).goal.title,
        }),
        timestamp: m.timestamp,
        runId: m.runId,
      };
    }),
    requests: requests.map((r) => {
      const kind = internal.find(([x]) => x === r)?.[1];
      if (!kind) return r;
      const { text: _text, ...rest } = r;
      return { ...rest, internal: kind };
    }),
  };
}
/**
 * One message of a conversation read on its own with AgentPier's text limit
 * instead of OpenClaw's page default (8000 characters per message); null when
 * the Gateway does not serve it.
 */
export async function conversationMessage(service, id, messageId) {
  const conversation = service.store.getConversation(id);
  const client = service.runtime.client;
  const generation = service.runtime.generation;
  // Like a history page: no read while the runtime is swapped or recovering.
  const unsettled = () =>
    service.maintenance ||
    service.recovering ||
    service.closed ||
    service.runtime.generation !== generation ||
    service.runtime.client !== client;
  if (!client?.ready || typeof messageId !== "string" || unsettled()) return null;
  const page = await client.call("chat.history", {
    sessionKey: conversation.runtimeSessionKey,
    messageId,
    limit: 1,
    maxChars: historyTextLimit,
  });
  if (unsettled()) return null;
  return publicMessages(page?.messages).find((m) => m.id === messageId)?.text ?? null;
}
// Cached messages are flat records of primitive fields.
function sameMessage(a, b) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}
// Single reads of cut messages, per service: running ones and retry delays.
const pageReads = new WeakMap();
function readsOf(service) {
  if (!pageReads.has(service))
    pageReads.set(
      service,
      historyReads({ now: () => (service.now ? service.now() : Date.now()) }),
    );
  return pageReads.get(service);
}
export async function conversationHistory(service, id, { before, limit = 100 } = {}) {
  const conversation = service.store.getConversation(id);
  const offset = before ? Number(before) : 0;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 1000000 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw assistantProblem("invalid");
  let messages = service.store.messages(id),
    nextBefore = null,
    stale = true,
    longChat = false;
  const client = service.runtime.client;
  const maintenanceEpoch = service.maintenanceEpoch || 0;
  const generation = service.runtime.generation;
  // A deleted user's chat never reads its native session back (user-release.js).
  const released = () => service.store.getConversation(id).userReleased;
  if (client?.ready && !service.maintenance && !service.recovering && !released()) {
    try {
      const history = await client.call("chat.history", {
        sessionKey: conversation.runtimeSessionKey,
        limit,
        offset,
      });
      if (released()) throw assistantProblem("notFound", 404);
      // Generated images on the page join the share store once (generated-images.js).
      service.generatedImages?.scan(conversation, history.messages || []);
      // The page cuts every text at OpenClaw's 8000 characters; cut ones are
      // completed from the cache or read on their own (history-text.js).
      const page = await completePage(
        publicMessages(history.messages, { compactions: true }),
        {
          known: new Map(messages.map((m) => [m.id, m])),
          read: (messageId) => conversationMessage(service, id, messageId),
          reads: readsOf(service),
          scope: id,
        },
      );
      if (
        service.maintenance ||
        service.recovering ||
        service.closed ||
        (service.maintenanceEpoch || 0) !== maintenanceEpoch ||
        service.runtime.generation !== generation ||
        service.runtime.client !== client ||
        released()
      )
        throw assistantProblem("unavailable", 503);
      const merged = new Map(messages.map((m) => [m.id, m]));
      for (const m of page) merged.set(m.id, m);
      const cached = cachedWindow(
        [...merged.values()].sort((a, b) => a.timestamp - b.timestamp),
      );
      // Reconciliation reads every 2 s during a run; an unchanged page writes nothing.
      if (
        cached.length !== messages.length ||
        cached.some((m, i) => !sameMessage(m, messages[i]))
      )
        service.store.cacheMessages(id, cached);
      messages = page;
      stale = false;
      // Unless its person hid the hint at a size not clearly outgrown (long-chats.js).
      longChat =
        offset === 0 &&
        longContext(history.sessionInfo) &&
        !service.longChats?.hidden(conversation, history.sessionInfo.totalTokens);
      // The turn's own message proves a send whose acknowledgement was lost.
      confirmFromTranscript(service, id, page);
      if (history.hasMore)
        nextBefore = String(offset + (history.messages?.length || limit));
    } catch {
      /* Last known history stays available when Gateway connectivity is lost. */
    }
  }
  if (stale) {
    const end = Math.max(0, messages.length - offset);
    messages = messages.slice(Math.max(0, end - limit), end);
    if (end > limit) nextBefore = String(offset + limit);
  }
  const files = service.attachments?.forConversation(id) || new Map();
  const requests = requestsWithAttachments(
    service.ledger
      .requests(id)
      .map((r) => ({ ...r, attempt: service.ledger.attemptFor(r.id) })),
    files,
  );
  // One trusted-context lookup per request and one attempt query per history read.
  const contexts = new Map(
    service.teams ? requests.map((r) => [r.id, service.teams.store.context(r.id)]) : [],
  );
  const attempts = service.ledger.attemptRequests(id);
  messages = withAttachments(withoutMarks(messages), requests, {
    attempts,
    byRequest: files,
  });
  const visible = hideInternal(messages, requests, contexts, attempts);
  return {
    ...visible,
    goal: service.teams?.goals?.view(id) ?? null,
    requests: goAheadMarks(
      service,
      requestsWithSources(visible.requests, contexts),
      contexts,
    ),
    // Routine, check-in and hook results show in the chat's event area instead.
    messages: withSharedFiles(
      withMemoryNotes(
        withRoutineResults(
          withRunNotes(
            service,
            conversation,
            imageResults(
              service,
              id,
              withMessageSources(visible.messages, requests, { attempts, contexts }),
            ),
            nextBefore,
          ),
          service.routines?.results.forConversation(id) || [],
          { from: pageStart(nextBefore, messages) },
        ).filter((m) => !areaResult(m)),
        // Members' requests to each other join the lead's chat alike (peer-notes.js).
        [
          ...(service.memoryNotes?.forConversation(id) || []),
          ...peerNotes(service, id),
          ...(service.teams?.goals?.notes(id) ?? []),
        ],
        { from: pageStart(nextBefore, messages) },
      ),
      service.attachments?.sharedFor?.(id) || [],
      { from: pageStart(nextBefore, messages) },
    ),
    events: eventArea(service, conversation),
    queued: queuedView(service, id),
    nextBefore,
    stale,
    // While its person had it summarised (long-chats.js; "memory" while its memory
    // step runs first), or the active attempt's run summarises it (compactions.js).
    compacting:
      service.longChats?.phase(id) || summarising(service, conversation, requests),
    // That memory step saved nothing before the last summary (long-chats.js).
    ...(service.longChats?.memoryNotSaved(id) ? { memoryNotSaved: true } : {}),
    // How a summary ended that outlived its request (long-chats.js).
    ...(service.longChats?.outcome(id)
      ? { compactOutcome: service.longChats.outcome(id) }
      : {}),
    ...(longChat ? { longChat } : {}),
  };
}

/** The share of the model's context window from which a chat counts as long. */
export const longChatShare = 0.6;
/** A chat is long from this many tokens when the session names no window. */
export const longChatTokens = 100000;
/**
 * Whether the session's last model call read a long context (OpenClaw 2026.10.3
 * `sessionInfo`: `totalTokens` is the last prompt's size, current only while
 * `totalTokensFresh`; `contextTokens` is the model's window). Long means
 * `longChatShare` of the window, or `longChatTokens` without a known window.
 */
export function longContext(info) {
  if (info?.totalTokensFresh !== true || !Number.isFinite(info.totalTokens)) return false;
  const window = info.contextTokens;
  return (
    info.totalTokens >=
    (Number.isFinite(window) && window > 0 ? longChatShare * window : longChatTokens)
  );
}
/**
 * The background turn that delivers generated images answers the request that asked
 * for them: the request its copied image is stored under (generated-images.js), or
 * none yet. It carries `imageResult` and that `requestId`, so the owner's opt-in
 * window hides it with the request (owner-privacy.js).
 */
function imageResults(service, id, messages) {
  return messages.map(({ imageArtifact, ...message }) => {
    if (imageArtifact === undefined) return message;
    const row =
      imageArtifact && service.attachments?.shared?.artifact(id, imageArtifact)?.row;
    return { ...message, imageResult: true, requestId: fileRequest(row) };
  });
}
/**
 * A lead's turn handling a member's result changes files like the lead's own work
 * (member-result-writes.js), but never runs what needs the owner's own message (SSH);
 * when it tried (LeadRequests.refusedChange), its request is marked `goAhead`, so the chat offers
 * the owner a one-tap "go ahead" that sends a real owner message.
 */
function goAheadMarks(service, requests, contexts) {
  const teams = service.teams?.store;
  if (!teams) return requests;
  return requests.map((r) => {
    const context = contexts.get(r.id);
    if (r.internal !== "member-result" || context?.kind !== "member-result") return r;
    return teams.find(context.requestId)?.resultWriteRefused
      ? { ...r, goAhead: true }
      : r;
  });
}
// Only the conversation's active attempt (its id is the Gateway run's idempotency key,
// runtimeRunId the run id) can be summarising; a cancelled one never is.
const settled = new Set(["completed", "failed", "cancelled"]);
function summarising(service, conversation, requests) {
  const run = service.compactions?.run(conversation.runtimeSessionKey);
  const attempt = requests.at(-1)?.attempt;
  if (!run || !attempt || attempt.reviewedAt || settled.has(attempt.state)) return false;
  return run === attempt.runtimeRunId || run === attempt.id;
}
const pageStart = (nextBefore, messages) =>
  nextBefore && messages.length ? messages[0].timestamp : -Infinity;
// Coding and SSH run notes join the page they fall into. A page reaches from its first
// message (or the very start when no earlier page exists) to the present; the
// client keeps the newer copy of a note that an older page repeats.
function withRunNotes(service, conversation, messages, nextBefore) {
  const actions = service.workflows?.store.list(conversation.assistantId) || [];
  const from = nextBefore && messages.length ? messages[0].timestamp : -Infinity;
  const notes = actionNotes(actions, conversation.id).filter((n) => n.timestamp >= from);
  if (!notes.length) return messages;
  return [...messages, ...notes]
    .map((m, i) => [m, i])
    .sort(([x, i], [y, j]) => x.timestamp - y.timestamp || i - j)
    .map(([m]) => m);
}
