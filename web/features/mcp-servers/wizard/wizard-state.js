// The new-server wizard: the steps of each path, where the owner may go, and the
// draft. The draft lives in memory only; the address carries the step alone.
import { mcpServerValues } from "../mcp-server-save.js";
import { guessTransport, pasteLimit } from "./paste-shared.js";

export { guessTransport };

const orders = {
  package: ["source", "package", "settings", "install", "connect", "done"],
  remote: ["source", "remote", "settings", "review", "connect", "done"],
  command: ["source", "command", "settings", "review", "connect", "done"],
};
const saveSteps = { package: "install", remote: "review", command: "review" };
const stageOf = {
  source: "source",
  directory: "setup",
  paste: "setup",
  package: "setup",
  remote: "setup",
  command: "setup",
  settings: "setup",
  review: "setup",
  install: "install",
  connect: "connect",
  done: "connect",
};
const pathValues = {
  package: { transport: "stdio", source: "package" },
  command: { transport: "stdio", source: "command" },
  remote: { transport: "http", source: "command" },
};
// Fields a refusal names, by the step that shows them (the name sits on set-up).
const fieldSteps = {
  url: "remote",
  command: "command",
  packageName: "package",
  packageVersion: "package",
  packageConstraints: "package",
  env: "settings",
  headers: "settings",
  args: "settings",
  cwd: "settings",
};

// Entries that add their own step between Source and the path's set-up step.
const entries = ["paste", "directory"];

/** A pasted block or a directory entry adds its step after Source. */
export const stepOrder = (path, via = null) => {
  const order = orders[path] ?? ["source"];
  if (!entries.includes(via)) return order;
  return path ? ["source", via, ...order.slice(1)] : ["source", via];
};

/** The indicator's stages; a path without a package has no Install stage. */
export const stages = (path) =>
  path === "package"
    ? ["source", "setup", "install", "connect"]
    : ["source", "setup", "connect"];

export const stageIndex = (path, step) => stages(path).indexOf(stageOf[step] ?? "source");

export function initialWizard() {
  return {
    path: null,
    via: null,
    // The pasted guide text and what was read from it: memory only, never sent.
    // `applied` is the server the draft came from, `done` those already saved.
    paste: { text: "", result: null, index: 0, applied: null, done: [] },
    visited: ["source"],
    draft: {
      ...mcpServerValues(null),
      signIn: "none",
      argRows: [],
      agents: [],
      origin: "manual",
      hints: {},
      directoryOrigin: null,
      urlTemplate: null,
    },
    fieldError: null,
    serverId: null,
    finished: false,
    connect: null,
    notice: "",
  };
}

/** The servers of the pasted block not saved yet, with their place in it. */
function waiting(paste) {
  if (!paste?.result?.ok) return { done: [], left: [] };
  const done = [...(paste.done ?? []), paste.applied ?? paste.index];
  const left = paste.result.servers
    .map((server, at) => ({ server, at }))
    .filter(({ at }) => !done.includes(at));
  return { done, left };
}

/** The next server of a pasted block that can be taken over; refused ones never return. */
function nextPasted(paste) {
  const { done, left } = waiting(paste);
  const first = left.find(({ server }) => !server.refused);
  return first ? { done, index: first.at } : null;
}

/** Whether "Add another server" still has servers of the pasted block to offer. */
export const pasteLeft = (paste) => Boolean(nextPasted(paste));

/** The names of the servers of the block that were refused and are still unsaved. */
export const pasteRefused = (paste) =>
  waiting(paste)
    .left.filter(({ server }) => server.refused)
    .map(({ server }) => server.name || server.key);

export function wizardReducer(state, action) {
  switch (action.type) {
    case "choose":
      return {
        ...state,
        path: action.path,
        via: null,
        visited: ["source", action.path],
        draft: { ...state.draft, ...pathValues[action.path] },
        fieldError: null,
      };
    case "via":
      return { ...state, via: action.via, path: null, visited: ["source", action.via] };
    case "pasteText":
      // The parser refuses texts over its limit; this cap only bounds what memory
      // keeps.
      return {
        ...state,
        paste: { ...state.paste, text: String(action.text).slice(0, pasteLimit * 16) },
      };
    case "pasteResult":
      // Choosing another server of the same block keeps what is done; a new read clears it.
      return {
        ...state,
        paste:
          action.result === state.paste.result
            ? { ...state.paste, index: action.index }
            : {
                ...state.paste,
                result: action.result,
                index: action.index,
                applied: null,
                done: [],
              },
      };
    case "pasted": {
      const { path, ...values } = action.draft;
      return {
        ...state,
        path,
        paste: { ...state.paste, applied: action.index ?? state.paste.index },
        visited: ["source", "paste", path, "settings"],
        draft: { ...initialWizard().draft, ...pathValues[path], ...values },
        fieldError: null,
      };
    }
    case "fromDirectory": {
      // "Use this server" only fills the draft; nothing is installed or bound here.
      const { path, ...values } = action.draft;
      return {
        ...state,
        path,
        visited: ["source", "directory", path, "settings"],
        draft: { ...initialWizard().draft, ...pathValues[path], ...values },
        fieldError: null,
      };
    }
    case "switchToPackage":
      // An own command that names a package: AgentPier installs it instead.
      return {
        ...state,
        path: "package",
        via: null,
        visited: ["source", "package"],
        draft: {
          ...state.draft,
          ...pathValues.package,
          command: "",
          ...action.values,
          hints: { ...state.draft.hints, ...(action.values.hints ?? {}) },
        },
        fieldError: null,
      };
    case "set":
      return {
        ...state,
        draft: { ...state.draft, [action.key]: action.value },
        fieldError: state.fieldError?.field === action.key ? null : state.fieldError,
      };
    case "patch":
      return { ...state, draft: { ...state.draft, ...action.values } };
    case "visit":
      return state.visited.includes(action.step)
        ? state
        : { ...state, visited: [...state.visited, action.step] };
    case "refused":
      return { ...state, fieldError: action.fieldError };
    case "saved":
      return { ...state, serverId: action.id, fieldError: null };
    case "connected":
      return {
        ...state,
        connect: {
          results: action.results,
          diff: action.diff,
          consented: action.consented,
        },
      };
    case "finished":
      return { ...state, finished: true };
    case "lost":
      return { ...initialWizard(), notice: "lost" };
    case "reset": {
      // "Add another server" after a pasted block offers the servers still waiting.
      const next = action.keepPaste ? nextPasted(state.paste) : null;
      return next
        ? {
            ...initialWizard(),
            via: "paste",
            visited: ["source", "paste"],
            paste: { ...state.paste, ...next, applied: null },
          }
        : initialWizard();
    }
    case "dismiss":
      return { ...state, notice: "" };
    default:
      return state;
  }
}

/** Whether the owner may open `step` now (visited, not closed by a save). */
export function reachable(state, step) {
  if (step === "source") return !state.serverId;
  const order = stepOrder(state.path, state.via);
  if (!order.includes(step) || !state.visited.includes(step)) return false;
  if (state.finished) return step === "done";
  if (state.serverId) return order.indexOf(step) >= order.indexOf(saveSteps[state.path]);
  return true;
}

/** The step the address asks for when this visit can show it, else null. */
export const resolveStep = (state, requested = "source") =>
  reachable(state, requested) ? requested : null;

/** The furthest step the owner can open: where a refused address sends them. */
export function fallbackStep(state) {
  return (
    [...stepOrder(state.path, state.via)]
      .reverse()
      .find((step) => reachable(state, step)) ?? "source"
  );
}

export function nextStep(state, step) {
  const order = stepOrder(state.path, state.via);
  return order[order.indexOf(step) + 1] ?? null;
}

export function previousStep(state, step) {
  const order = stepOrder(state.path, state.via);
  const before = order[order.indexOf(step) - 1];
  return before && reachable(state, before) ? before : null;
}

/** The step that shows a refused field; the name sits on the path's set-up step. */
export const stepOfField = (path, field) => fieldSteps[field] ?? path;

/** Typed input that is not saved yet: closing asks before it is dropped. */
export const isDirty = (state) =>
  (Boolean(state.path) || Boolean(state.paste?.text)) && !state.serverId;

/**
 * The values `mcpServerStep` saves: the sign-in choice becomes `auth`, "No sign-in"
 * sends no headers, a Bearer row gets its prefix. CLIs are bound later, on Connect.
 */
export function saveValues(draft) {
  const bearer = (row) =>
    row.bearer && row.value && !/^bearer\s/i.test(row.value)
      ? { ...row, value: `Bearer ${row.value}` }
      : row;
  return {
    ...draft,
    auth: draft.signIn === "oauth" ? "oauth" : "headers",
    headers: draft.signIn === "headers" ? draft.headers.map(bearer) : [],
    // Argument rows become the newline list requestBody reads (empty lines drop).
    args: (draft.argRows ?? []).join("\n"),
    clis: [],
  };
}
