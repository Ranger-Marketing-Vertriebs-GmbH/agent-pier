import api from "../../lib/api.js";

// Task ids may hold a colon (Codex shells: "<threadId>:<processId>").
const taskPath = (sessionId, taskId, action) =>
  `/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}/${action}`;

/** A subagent's messages: { messages, partial, truncated }. */
export const readTaskTranscript = (sessionId, taskId, signal) =>
  api(taskPath(sessionId, taskId, "transcript"), "GET", undefined, signal);

/** The tail of a shell's output: { text, truncated, gone }. */
export const readTaskOutput = (sessionId, taskId, signal) =>
  api(taskPath(sessionId, taskId, "output"), "GET", undefined, signal);

/** Stops a running task; rejects with the server's code, translated text and reason. */
export const stopTask = (sessionId, taskId) =>
  api(taskPath(sessionId, taskId, "stop"), "POST");
