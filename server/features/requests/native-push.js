import net from "node:net";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { messages, send } from "./wire.js";

// Push hints a native owner sends over its authenticated broker channel. They never
// carry requests: `activity` asks the server to read the session's chat now, the
// stream messages carry reply text while the CLI generates it (chat/reply-streams.js),
// `prompt` tells whether the CLI took a submitted prompt (chat/delivery-acceptance.js),
// `preparing` names the tool call the model is writing (live status). `binding` is
// the one push that is answered: a hook that cannot read the process list asks the
// server to write its receipt (sessions/native-session-binding.js, `claim`).
export const maxReplyText = 64 * 1024;
const RUN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
// The CLI events a push may name; anything else is just "activity".
const activityEvents = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "PermissionRequest",
  "PreToolUse",
  "Elicitation",
  "SessionEnd",
  "turn/started",
  "turn/completed",
  "thread/status/changed",
  "session.status",
]);
const text = (value, limit = maxReplyText) =>
  typeof value === "string" && value.length <= limit && !value.includes("\0");
const label = (value) =>
  typeof value === "string" && LABEL.test(value) ? value : undefined;

/** The validated push message, or null when it is none (a request message). */
export function nativePushValue(message) {
  const invalid = () => {
    throw Error("Invalid native push");
  };
  if (message.type === "activity")
    return {
      type: "activity",
      ...(activityEvents.has(message.event) ? { event: message.event } : {}),
      ...(message.event === "Stop" && text(message.lastAssistantMessage)
        ? { lastAssistantMessage: message.lastAssistantMessage }
        : {}),
      // Who started a Claude turn: the owner's prompt or Claude's generated input.
      ...(message.event === "UserPromptSubmit" &&
      ["owner", "generated"].includes(message.prompt)
        ? { prompt: message.prompt }
        : {}),
      // A turn that ended at the CLI's rate limit or usage quota, and its message.
      ...(["StopFailure", "turn/completed"].includes(message.event) &&
      message.failure === "usage-limit"
        ? {
            failure: "usage-limit",
            ...(text(message.detail, 500) ? { detail: message.detail } : {}),
          }
        : {}),
    };
  if (message.type === "stream") {
    if (
      !RUN.test(message.runId || "") ||
      !Number.isInteger(message.from) ||
      message.from < 0 ||
      message.from > maxReplyText ||
      !text(message.text)
    )
      invalid();
    return {
      type: "stream",
      runId: message.runId,
      from: message.from,
      text: message.text,
      ...(label(message.thread) ? { thread: message.thread } : {}),
      ...(label(message.turn) ? { turn: message.turn } : {}),
    };
  }
  if (message.type === "stream-end") {
    if (message.runId !== undefined && !RUN.test(message.runId || "")) invalid();
    return {
      type: "stream-end",
      ...(message.runId ? { runId: message.runId } : {}),
      ...(label(message.turn) ? { turn: message.turn } : {}),
    };
  }
  if (message.type === "claude-display") {
    if (
      !label(message.turnId) ||
      !label(message.messageId) ||
      !Number.isInteger(message.index) ||
      message.index < 0 ||
      message.index > 100000 ||
      typeof message.final !== "boolean" ||
      !text(message.delta)
    )
      invalid();
    return {
      type: "claude-display",
      turnId: message.turnId,
      messageId: message.messageId,
      index: message.index,
      final: message.final,
      delta: message.delta,
    };
  }
  // The tool call the model is writing now (OpenCode plugin), by name; none: over.
  if (message.type === "preparing") {
    if (
      message.name !== undefined &&
      (typeof message.name !== "string" || !/^[^\0-\x1f\x7f]{1,120}$/.test(message.name))
    )
      invalid();
    return { type: "preparing", ...(message.name ? { name: message.name } : {}) };
  }
  if (message.type === "binding") {
    const optional = (value, limit) => value === null || (text(value, limit) && value);
    if (
      !text(message.token, 200) ||
      !message.token ||
      !optional(message.providerSessionId, 300) ||
      !optional(message.cwd, 4096) ||
      !Number.isSafeInteger(message.pid) ||
      message.pid <= 1
    )
      invalid();
    return {
      type: "binding",
      token: message.token,
      providerSessionId: message.providerSessionId,
      cwd: message.cwd,
      pid: message.pid,
    };
  }
  // Whether the CLI took a submitted prompt (Codex proxy): confirms chat deliveries.
  if (message.type === "prompt-ready") return { type: "prompt-ready" };
  if (message.type === "prompt") {
    if (
      !["accepted", "dropped"].includes(message.kind) ||
      !Number.isInteger(message.imageCount) ||
      message.imageCount < 0 ||
      message.imageCount > 1000
    )
      invalid();
    return {
      type: "prompt",
      kind: message.kind,
      imageCount: message.imageCount,
      ...(message.kind === "dropped" && text(message.reason, 500) && message.reason
        ? { reason: message.reason }
        : {}),
    };
  }
  return null;
}

/** What an activity push tells the push notifications besides its event. */
export function activityDetail(push) {
  // A turn ended at the CLI's usage limit (session-limited push), or who started a
  // Claude turn (session-completed push).
  if (!push.failure && !push.prompt) return [];
  return [
    Object.fromEntries(
      ["failure", "detail", "prompt"]
        .filter((key) => push[key] !== undefined)
        .map((key) => [key, push[key]]),
    ),
  ];
}

/**
 * One push from a short-lived hook process: connect, authenticate like every native
 * owner, send, close. It settles within `timeout` whatever the broker does, so a
 * stopped server never holds the CLI's hook. With `reply` (a message type) it waits
 * for the broker's message of that type and resolves with it instead of `true`.
 */
export function pushNative(
  message,
  { env = process.env, timeout = 1500, reply: awaited } = {},
) {
  return new Promise((resolve) => {
    let socket,
      done = false;
    const finish = (sent) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve(sent);
    };
    const timer = setTimeout(() => finish(false), timeout);
    try {
      const launch = JSON.parse(fs.readFileSync(env.AGENTPIER_REQUEST_FILE, "utf8"));
      if (launch.token !== env.AGENTPIER_REQUEST_TOKEN) return finish(false);
      socket = net.createConnection(launch.socketPath);
      socket.on("error", () => finish(false));
      socket.on("close", () => finish(false));
      socket.on("connect", () =>
        send(socket, {
          type: "hello",
          sessionId: launch.id,
          token: launch.token,
          epoch: randomUUID(),
        }),
      );
      messages(
        socket,
        (reply) => {
          if (awaited && reply.type === awaited) return finish(reply);
          if (reply.type !== "ready") return;
          send(socket, message);
          // The broker reads the line before it sees the end of the stream.
          if (!awaited) socket.end(() => finish(true));
        },
        () => finish(false),
      );
    } catch {
      finish(false);
    }
  });
}
