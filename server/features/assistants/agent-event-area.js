import { hookMarkers } from "./agent-hook-prompt.js";
import { mainConversation } from "./routine-targets.js";
import { routineRunNotes } from "./routine-run-notes.js";

// The event area of an agent's main chat: what routines, check-ins and hooks did,
// kept out of the transcript. Routine and check-in rows come from RoutineResults,
// hook rows only from HookEvents (a hook's RoutineResults record only marks its
// committed reply in the transcript, so it can leave it). Reminders stay messages.
const areaLimit = 50;
const lineLimit = 160;
const hookStatus = {
  pending: "running",
  running: "running",
  done: "done",
  failed: "failed",
  throttled: "throttled",
};

/**
 * A hook run's prompt, should a transcript ever show it as a user turn: untrusted
 * payload that must never render as a message.
 */
const hookPrompt = (m) =>
  m.role === "user" &&
  typeof m.text === "string" &&
  m.text.includes("not a message from the owner") &&
  m.text.includes(hookMarkers.start) &&
  m.text.includes(hookMarkers.end);

/** Whether a transcript entry belongs to the event area instead of the messages. */
export function areaResult(message) {
  if (!message) return false;
  if (message.scheduled) return message.scheduled.kind !== "reminder";
  if (message.role === "event" && message.event === "routine-failed")
    return message.kind !== "reminder";
  return hookPrompt(message);
}

// A line without simple Markdown markers: emphasis, inline code, and a leading
// heading, list or quote marker. The area shows it as plain text.
const plain = (line) =>
  line
    .replace(/^(?:#{1,6}|[-*+]|>)\s+/, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/^[-*_\s]+$/, "")
    .trim();

/** The first non-empty line of a reply as plain text, at most 160 characters. */
export function firstLine(text) {
  const line =
    String(text ?? "")
      .split(/\r\n?|\n/)
      .map((l) => plain(l.trim()))
      .find(Boolean) ?? "";
  const chars = Array.from(line);
  return chars.length <= lineLimit ? line : `${chars.slice(0, lineLimit - 1).join("")}…`;
}

function routineRow(r, runNotes = []) {
  const ok = r.status === "ok";
  return {
    id: `routine:${r.id}`,
    source: r.kind === "heartbeat" ? "checkin" : "routine",
    name: r.name || "",
    at: r.at,
    status: ok ? "done" : "failed",
    firstLine: ok ? firstLine(r.text) : "",
    ...(ok && r.text ? { reply: r.text } : {}),
    ...(r.notes?.length ? { notes: r.notes } : {}),
    // Its SSH runs, SFTP jobs and memory note, as the transcript showed them.
    ...(runNotes.length ? { runNotes } : {}),
  };
}

function hookRow(event, hook) {
  const status = event.silent ? "silent" : hookStatus[event.status] || "failed";
  return {
    id: `hook:${event.id}`,
    source: "hook",
    name: hook?.name || "",
    ...(hook?.sender ? { sender: hook.sender } : {}),
    at: event.receivedAt,
    status,
    ...(event.duplicates > 0 ? { duplicates: event.duplicates } : {}),
    firstLine: firstLine(event.reply),
    ...(event.reply ? { reply: event.reply } : {}),
    hookId: event.hookId,
    // The event's row id, the detail route's `eventId` (never the sender's key).
    eventId: event.id,
    ...(event.test ? { test: true } : {}),
  };
}

function isMain(service, conversation) {
  if (conversation.channel !== "agentpier" || conversation.archivedAt) return false;
  if (conversation.main === true) return true;
  return (
    mainConversation(service.store, conversation.assistantId, conversation.userId ?? null)
      ?.id === conversation.id
  );
}

/**
 * The event area of a main chat (the owner's or a user's), newest first: its
 * routine and check-in results and, in the owner's main chat, the agent's hook
 * events (hooks run there only). Never a payload. Any other chat has none.
 */
export function eventArea(service, conversation) {
  if (!conversation || !isMain(service, conversation)) return [];
  const all = (service.routines?.results.forConversation(conversation.id) || []).filter(
    (r) => !r.kind || r.kind === "heartbeat",
  );
  const runNotes = routineRunNotes({
    results: all,
    actions: service.workflows?.store?.list(conversation.assistantId) || [],
    memoryNotes: service.memoryNotes?.forConversation(conversation.id) || [],
    conversationId: conversation.id,
  });
  const results = all.map((r) => routineRow(r, runNotes.get(r.id)));
  const hooks = service.routines?.hooks;
  const owners = typeof conversation.userId !== "string";
  const events =
    owners && hooks
      ? hooks.events
          .forAssistant(conversation.assistantId, { limit: areaLimit })
          // A deleted hook's tombstones (HookEvents.forget) are not shown.
          .flatMap((event) => {
            const hook = hooks.store.get(event.hookId);
            return hook ? [hookRow(event, hook)] : [];
          })
      : [];
  return [...results, ...events].sort((a, b) => b.at - a.at).slice(0, areaLimit);
}

/**
 * What a hook event's run started through AgentPier: its coding requests (the ids
 * the run noted, plus actions whose origin names the event) with their run links,
 * and its SSH and SFTP runs with the host. Only the agent's own actions.
 */
export function eventActions(workflows, assistantId, event) {
  const own = (a) => a && a.assistantId === assistantId;
  const ofEvent = (workflows?.store?.list(assistantId) || []).filter(
    (a) => own(a) && a.origin?.kind === "hook" && a.origin.eventId === event.id,
  );
  const codingIds = [
    ...new Set([
      ...(event.coding || []),
      ...ofEvent.filter((a) => a.payload?.action === "coding_start").map((a) => a.id),
    ]),
  ];
  const coding = codingIds.flatMap((actionId) => {
    const action = workflows?.get?.(actionId);
    if (!own(action)) return [];
    const run = workflows.liveRun?.(action)?.run || action.run;
    return [{ actionId, state: action.state, runUrl: run?.url ?? null }];
  });
  const remote = ofEvent
    .filter((a) => ["ssh", "sftp"].includes(a.payload?.action))
    .map((a) => ({
      actionId: a.id,
      kind: a.payload.action,
      host: a.payload.hostName || "",
      state: a.state,
    }));
  return { coding, remote };
}
