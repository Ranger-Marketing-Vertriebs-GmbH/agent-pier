import { withoutPromptImagePaths } from "./prompt-image-paths.js";

// The OpenClaw adapter as an agent shared with users sees it (runtime-for.js): every
// text that becomes a prompt of such an agent (a turn's message, a reminder's, a
// routine's, a hook's or a check-in's job prompt) goes out without a local image
// path OpenClaw would load by itself (prompt-image-paths.js), whoever wrote it. The
// sessions and routines sub-ports are the only ways such text reaches OpenClaw.

const shared = new WeakMap();
const clean = (text) => (typeof text === "string" ? withoutPromptImagePaths(text) : text);

function sessionsOf(sessions) {
  return Object.freeze({
    ...sessions,
    send: ({ turn, ...rest }) =>
      sessions.send({ ...rest, turn: turn && { ...turn, message: clean(turn.message) } }),
    ...(sessions.on && { on: (connection) => sessionsOf(sessions.on(connection)) }),
  });
}

const routine = (value) =>
  value?.prompt
    ? { ...value, prompt: { ...value.prompt, text: clean(value.prompt.text) } }
    : value;

function routinesOf(routines) {
  return Object.freeze({
    ...routines,
    add: ({ routine: added, ...rest }) =>
      routines.add({ ...rest, routine: routine(added) }),
    update: ({ patch, ...rest }) => routines.update({ ...rest, patch: routine(patch) }),
    ...(routines.on && { on: (connection) => routinesOf(routines.on(connection)) }),
  });
}

/** `adapter` with the prompts of an agent shared with users cleaned (one per adapter). */
export function sharedAgentAdapter(adapter) {
  let wrapped = shared.get(adapter);
  if (!wrapped)
    shared.set(
      adapter,
      (wrapped = Object.freeze({
        ...adapter,
        sessions: sessionsOf(adapter.sessions),
        routines: routinesOf(adapter.routines),
      })),
    );
  return wrapped;
}
