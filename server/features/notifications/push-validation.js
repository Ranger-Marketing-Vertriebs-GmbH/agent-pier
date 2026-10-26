import { serverMessages } from "../../lib/i18n/de.js";
import { isIP } from "node:net";
import { ECDH } from "node:crypto";
import { problem } from "../../lib/storage.js";
export function pushId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value))
    throw problem(serverMessages.notifications.invalidId);
  return value;
}
function key(value, length) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value))
    throw problem(serverMessages.notifications.invalidSubscriptionKey);
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== length || bytes.toString("base64url") !== value)
    throw problem(serverMessages.notifications.invalidSubscriptionKey);
  return bytes;
}
export function pushSubscription(input) {
  if (!input || typeof input.endpoint !== "string" || input.endpoint.length > 4096)
    throw problem(serverMessages.notifications.invalidSubscription);
  let url;
  try {
    url = new URL(input.endpoint);
  } catch {
    throw problem(serverMessages.notifications.invalidEndpoint);
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    isIP(hostname.replace(/^\[|\]$/g, "")) ||
    !hostname.includes(".") ||
    hostname.endsWith(".") ||
    /\.(?:localhost|local|internal)$/.test(hostname) ||
    !/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)
  )
    throw problem(serverMessages.notifications.publicHttpsRequired);
  const publicKey = key(input.keys?.p256dh, 65);
  key(input.keys?.auth, 16);
  try {
    ECDH.convertKey(publicKey, "prime256v1", undefined, undefined, "uncompressed");
  } catch {
    throw problem(serverMessages.notifications.invalidPublicKey);
  }
  return {
    endpoint: url.href,
    keys: { p256dh: input.keys.p256dh, auth: input.keys.auth },
  };
}
/** Every kind the server sends; the service worker words each one. */
export const pushKinds = [
  "permission",
  "question",
  "session-ended",
  "session-completed",
  "session-waiting",
  "pipeline-gate",
  // A run ended: completed, or failed (a cancelled run notifies nobody).
  "pipeline-completed",
  "pipeline-failed",
  // An agent waits for approval: a shell or SSH command, a coding task, a memory
  // entry, a member permission or a team proposal.
  "agent-approval",
  "agent-checkin",
  // A routine, reminder or hook result in an agent's main chat.
  "agent-routine",
  // A hook went over its hourly limit: further events wake nobody this hour.
  "agent-hook-throttled",
  // An agent's own Telegram bot still runs after the owner revoked it.
  "telegram-revocation",
  // A saved GitHub token was rejected, expired or expires soon.
  "github-token",
  // Free space on the data directory's volume fell below 10 %.
  "disk-space",
  "test",
];
export const inboxItemTypes = ["question", "approval", "gate", "action", "team"];
export const approvalSubjects = [
  "exec",
  "ssh",
  "coding",
  "memory",
  "grant",
  "hook",
  "sshAccess",
  "team",
];

// Kinds about one agent; a notice opens its chat when it names one.
const agentKinds = [
  "agent-checkin",
  "agent-routine",
  "agent-hook-throttled",
  "agent-approval",
];

/** The identifiers of an event; any other field of the input is dropped. */
export function pushPayload(input) {
  if (!pushKinds.includes(input?.kind)) throw problem("Invalid notification kind.");
  const payload = { kind: input.kind, eventId: pushId(input.eventId) };
  if (input.kind === "telegram-revocation") {
    if (input.assistantId !== undefined) payload.assistantId = pushId(input.assistantId);
  } else if (input.kind.startsWith("pipeline-")) payload.runId = pushId(input.runId);
  else if (agentKinds.includes(input.kind)) {
    payload.assistantId = pushId(input.assistantId);
    // The chat it was written to; the notice opens it.
    if (input.conversationId !== undefined)
      payload.conversationId = pushId(input.conversationId);
  } else if (!["test", "github-token", "disk-space"].includes(input.kind))
    payload.sessionId = pushId(input.sessionId);
  return payload;
}

const textLimits = { label: 200, tool: 40, project: 200, stage: 200, preview: 4000 };

/**
 * An emitter's event: its identifiers, plus the names and the preview text a device
 * may see at a higher detail level (push-content.js filters and redacts them per
 * device), the inbox item it waits as, and whether Telegram delivered it as well.
 */
export function pushEvent(input) {
  const event = pushPayload(input);
  for (const [key, limit] of Object.entries(textLimits))
    if (typeof input[key] === "string" && input[key].trim())
      event[key] = input[key].slice(0, limit);
  if (input.kind === "agent-approval") {
    if (!approvalSubjects.includes(input.subject))
      throw problem("Invalid notification kind.");
    event.subject = input.subject;
  }
  if (input.inbox !== undefined) {
    if (!inboxItemTypes.includes(input.inbox?.type))
      throw problem("Invalid notification kind.");
    event.inbox = { type: input.inbox.type, id: pushId(input.inbox.id) };
  }
  if (input.telegram === true) event.telegram = true;
  return event;
}

const linkPattern =
  /^\/(?:|inbox(?:\/(?:question|approval|gate|action|team)\/[A-Za-z0-9_-]{1,120})?|sessions\/[A-Za-z0-9_-]{1,120}\/chat|pipelines\/runs\/[A-Za-z0-9_-]{1,120}|agents(?:\/[A-Za-z0-9_-]{1,120}\/(?:settings|chats\/[A-Za-z0-9_-]{1,120}))?|settings\/(?:github|notifications))$/;

const messageKeys = [
  "v",
  "kind",
  "eventId",
  "link",
  "tag",
  "renotify",
  "count",
  "subject",
  "label",
  "tool",
  "project",
  "stage",
  "preview",
];

/**
 * A payload built for one device (push-content.js), checked again before sending:
 * only its known fields leave the host, within the 1 KB budget.
 */
export function pushMessage(input) {
  const payload = {};
  for (const key of messageKeys)
    if (input?.[key] !== undefined) payload[key] = input[key];
  if (!pushKinds.includes(payload?.kind) || payload.v !== 2)
    throw problem("Invalid notification kind.");
  pushId(payload.eventId);
  if (typeof payload.link !== "string" || !linkPattern.test(payload.link))
    throw problem("Invalid notification kind.");
  const text = JSON.stringify(payload);
  if (Buffer.byteLength(text, "utf8") > 1024) throw problem("Invalid notification kind.");
  return text;
}
