import net from "node:net";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { messages, send } from "./wire.js";

// Push hints a native owner sends over its authenticated broker channel. They never
// carry requests: `activity` asks the server to read the session's chat now, the
// stream messages carry reply text while the CLI generates it (chat/reply-streams.js).
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
  return null;
}

/**
 * One push from a short-lived hook process: connect, authenticate like every native
 * owner, send, close. It settles within `timeout` whatever the broker does, so a
 * stopped server never holds the CLI's hook.
 */
export function pushNative(message, { env = process.env, timeout = 1500 } = {}) {
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
          if (reply.type !== "ready") return;
          send(socket, message);
          // The broker reads the line before it sees the end of the stream.
          socket.end(() => finish(true));
        },
        () => finish(false),
      );
    } catch {
      finish(false);
    }
  });
}
