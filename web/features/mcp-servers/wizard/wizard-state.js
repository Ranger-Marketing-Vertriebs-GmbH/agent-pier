// The new-server wizard: the steps of each path, where the owner may go, and the
// draft. The draft lives in memory only; the address carries the step alone.
import { mcpServerValues } from "../mcp-server-save.js";

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

export const stepOrder = (path) => orders[path] ?? ["source"];

/** The indicator's stages; a path without a package has no Install stage. */
export const stages = (path) =>
  path === "package"
    ? ["source", "setup", "install", "connect"]
    : ["source", "setup", "connect"];

export const stageIndex = (path, step) => stages(path).indexOf(stageOf[step] ?? "source");

export function initialWizard() {
  return {
    path: null,
    visited: ["source"],
    draft: {
      ...mcpServerValues(null),
      signIn: "none",
      argRows: [],
      agents: [],
      origin: "manual",
      hints: {},
    },
    fieldError: null,
    serverId: null,
    finished: false,
    connect: null,
    notice: "",
  };
}

export function wizardReducer(state, action) {
  switch (action.type) {
    case "choose":
      return {
        ...state,
        path: action.path,
        visited: ["source", action.path],
        draft: { ...state.draft, ...pathValues[action.path] },
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
    case "reset":
      return initialWizard();
    case "dismiss":
      return { ...state, notice: "" };
    default:
      return state;
  }
}

/** Whether the owner may open `step` now (visited, not closed by a save). */
export function reachable(state, step) {
  if (step === "source") return !state.serverId;
  const order = stepOrder(state.path);
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
    [...stepOrder(state.path)].reverse().find((step) => reachable(state, step)) ??
    "source"
  );
}

export function nextStep(state, step) {
  const order = stepOrder(state.path);
  return order[order.indexOf(step) + 1] ?? null;
}

export function previousStep(state, step) {
  const order = stepOrder(state.path);
  const before = order[order.indexOf(step) - 1];
  return before && reachable(state, before) ? before : null;
}

/** The step that shows a refused field; the name sits on the path's set-up step. */
export const stepOfField = (path, field) => fieldSteps[field] ?? path;

/** Typed input that is not saved yet: closing asks before it is dropped. */
export const isDirty = (state) => Boolean(state.path) && !state.serverId;

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

/** SSE when the address path ends in /sse, else HTTP. */
export function guessTransport(url) {
  try {
    return /\/sse\/?$/.test(new URL(url).pathname) ? "sse" : "http";
  } catch {
    return "http";
  }
}
