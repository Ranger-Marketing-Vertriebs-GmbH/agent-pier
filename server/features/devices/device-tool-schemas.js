import { z } from "zod";
import { ACTIONS } from "./device-actions.js";
import { KEY_NAMES, LOG_PRIORITIES, MAX_KEY_COUNT, SCROLLS } from "./device-input.js";

/*
 * The arguments of each device action (device-actions.js) as a tool takes them, in
 * one place for every kind of caller: the session tools (device-mcp.js, one tool
 * per action) and the agents' tool (assistants/agent-devices.js, one tool with an
 * `action`; its JSON schema in assistants/team-plugin/device-tool.js is checked
 * against these shapes by tests/unit/agent-device-tool.test.js). A field with one
 * name has one meaning and one set of limits in every action that takes it.
 */
const coordinate = z.number().int().min(0).max(10000);

/** The fields, by the name they have in every action that takes them. */
export const deviceFields = Object.freeze({
  // A device's id or its name.
  device: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  element: z.number().int().min(1).max(10000),
  x: coordinate,
  y: coordinate,
  longPress: z.boolean(),
  scroll: z.enum(SCROLLS),
  x1: coordinate,
  y1: coordinate,
  x2: coordinate,
  y2: coordinate,
  durationMs: z.number().int().min(50).max(5000),
  key: z.enum(KEY_NAMES),
  count: z.number().int().min(1).max(MAX_KEY_COUNT),
  text: z.string().min(1).max(1000),
  // A path on the AgentPier host, inside the caller's own area.
  path: z.string().min(1).max(4096),
  // An absolute path of a file on the device.
  devicePath: z.string().min(1).max(1024),
  package: z.string().min(1).max(200),
  activity: z.string().min(1).max(300),
  all: z.boolean(),
  url: z.string().min(1).max(2048),
  lines: z.number().int().min(1).max(1000),
  tag: z.string().min(1).max(64),
  priority: z.enum(LOG_PRIORITIES),
  command: z.string().min(1).max(8000),
  timeoutMs: z.number().int().min(1000).max(120000),
});

// Per action: the fields it needs, and after them the ones it may take.
const takes = {
  list: [[], []],
  create: [["name"], []],
  start: [["device"], []],
  stop: [["device"], []],
  reset: [["device"], []],
  delete: [["device"], []],
  screenshot: [["device"], []],
  ui: [["device"], []],
  tap: [["device"], ["element", "x", "y", "longPress"]],
  swipe: [["device"], ["scroll", "x1", "y1", "x2", "y2", "durationMs"]],
  key: [["device", "key"], ["count"]],
  type: [["device", "text"], []],
  install: [["device", "path"], []],
  push: [["device", "path", "devicePath"], []],
  pull: [["device", "devicePath", "path"], []],
  app_launch: [["device", "package"], ["activity"]],
  app_stop: [["device", "package"], []],
  apps: [["device"], ["all"]],
  open_url: [["device", "url"], []],
  logs: [["device"], ["lines", "package", "tag", "priority"]],
  shell: [["device", "command"], ["timeoutMs"]],
};

/** `{ required: [name], optional: [name] }` of every action. */
export const actionFields = Object.freeze(
  Object.fromEntries(
    ACTIONS.map((action) => {
      const [required, optional] = takes[action];
      return [action, Object.freeze({ required, optional })];
    }),
  ),
);

/**
 * The zod shape of `action`'s arguments. `describe` (`{ field: text }`) adds what a
 * caller reads about a field, in its own words.
 */
export function actionShape(action, describe = {}) {
  const { required, optional } = actionFields[action];
  const field = (name) =>
    describe[name] ? deviceFields[name].describe(describe[name]) : deviceFields[name];
  return {
    ...Object.fromEntries(required.map((name) => [name, field(name)])),
    ...Object.fromEntries(optional.map((name) => [name, field(name).optional()])),
  };
}

/** The strict schema of every action's arguments. */
export const actionSchemas = Object.freeze(
  Object.fromEntries(
    ACTIONS.map((action) => [action, z.strictObject(actionShape(action))]),
  ),
);

/** Actions that destroy something on a device or replace a file. */
export const destructiveActions = Object.freeze([
  "reset",
  "delete",
  "install",
  "push",
  "pull",
  "app_stop",
  "shell",
]);
/** Actions that only read. */
export const readOnlyActions = Object.freeze([
  "list",
  "screenshot",
  "ui",
  "apps",
  "logs",
]);
/** Actions only a run the owner started may take (assistants/agent-device-origin.js). */
export const managingActions = Object.freeze(["create", "reset", "delete"]);
