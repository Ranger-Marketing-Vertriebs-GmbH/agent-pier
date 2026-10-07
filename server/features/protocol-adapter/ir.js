// Intermediate representation (IR) shared by all adapter directions, with validators
// that throw a TypeError naming the offending path.

import { STOP_REASONS } from "./mapping.js";

export const ROLES = Object.freeze(["system", "user", "assistant"]);
export const TOOL_KINDS = Object.freeze(["function", "custom", "hosted"]);
export const CALL_KINDS = Object.freeze(["function", "custom"]);
export const THINKING_MODES = Object.freeze([
  "disabled",
  "enabled",
  "adaptive",
  "between_tools",
]);
export const THINKING_DISPLAYS = Object.freeze(["summarized", "omitted", "updates"]);
export const BLOCK_KINDS = Object.freeze(["text", "reasoning", "toolCall"]);
export const ERROR_KINDS = Object.freeze([
  "auth",
  "permission",
  "notFound",
  "rateLimit",
  "overloaded",
  "invalidRequest",
  "contextLength",
  "server",
  "timeout",
  "network",
]);

function shapeError(path, expected) {
  throw new TypeError(`${path}: expected ${expected}`);
}

const isObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isAbsent = (value) => value === undefined || value === null;

function object(value, path) {
  if (!isObject(value)) shapeError(path, "an object");
}
function string(value, path) {
  if (typeof value !== "string") shapeError(path, "a string");
}
function optionalString(value, path) {
  if (value !== undefined) string(value, path);
}
function boolean(value, path) {
  if (typeof value !== "boolean") shapeError(path, "a boolean");
}
function count(value, path) {
  if (!Number.isInteger(value) || value < 0) shapeError(path, "a non-negative integer");
}
function optionalNumber(value, path) {
  if (!isAbsent(value) && !Number.isFinite(value)) shapeError(path, "a number or null");
}
function oneOf(value, allowed, path) {
  if (!allowed.includes(value)) shapeError(path, `one of ${allowed.join("|")}`);
}
function array(value, path, check) {
  if (!Array.isArray(value)) shapeError(path, "an array");
  value.forEach((item, index) => check(item, `${path}[${index}]`));
}
function cacheMark(value, path) {
  if (value !== undefined) oneOf(value, ["ephemeral"], path);
}

const PART_CHECKS = {
  text(part, path) {
    string(part.text, `${path}.text`);
    cacheMark(part.cache, `${path}.cache`);
  },
  image(part, path) {
    string(part.mediaType, `${path}.mediaType`);
    optionalString(part.data, `${path}.data`);
    optionalString(part.url, `${path}.url`);
    if (part.data === undefined && part.url === undefined)
      shapeError(path, "data or url");
    optionalString(part.detail, `${path}.detail`);
    cacheMark(part.cache, `${path}.cache`);
  },
  toolCall(part, path) {
    string(part.id, `${path}.id`);
    string(part.name, `${path}.name`);
    optionalString(part.namespace, `${path}.namespace`);
    oneOf(part.kind, CALL_KINDS, `${path}.kind`);
    string(part.input, `${path}.input`);
  },
  toolResult(part, path) {
    string(part.callId, `${path}.callId`);
    array(part.parts, `${path}.parts`, resultPart);
    boolean(part.isError, `${path}.isError`);
    cacheMark(part.cache, `${path}.cache`);
  },
  reasoning(part, path) {
    optionalString(part.text, `${path}.text`);
    optionalString(part.summary, `${path}.summary`);
    optionalString(part.carrier, `${path}.carrier`);
    if (part.redacted !== undefined && part.redacted !== true) {
      shapeError(`${path}.redacted`, "true or absent");
    }
  },
};

function irPart(part, path) {
  object(part, path);
  oneOf(part.type, Object.keys(PART_CHECKS), `${path}.type`);
  PART_CHECKS[part.type](part, path);
}

function resultPart(part, path) {
  object(part, path);
  oneOf(part.type, ["text", "image"], `${path}.type`);
  PART_CHECKS[part.type](part, path);
}

function irMessage(message, path) {
  object(message, path);
  oneOf(message.role, ROLES, `${path}.role`);
  array(message.parts, `${path}.parts`, irPart);
}

function irTool(tool, path) {
  object(tool, path);
  string(tool.name, `${path}.name`);
  optionalString(tool.namespace, `${path}.namespace`);
  oneOf(tool.kind, TOOL_KINDS, `${path}.kind`);
  if (tool.description !== undefined) string(tool.description, `${path}.description`);
  if (tool.kind === "hosted") string(tool.hostedType, `${path}.hostedType`);
  if (tool.schema !== undefined) object(tool.schema, `${path}.schema`);
  if (tool.strict !== undefined) boolean(tool.strict, `${path}.strict`);
  // `grammar` is the custom tool's format; `raw` keeps a hosted tool as the client sent it.
  if (tool.grammar !== undefined) {
    object(tool.grammar, `${path}.grammar`);
    string(tool.grammar.syntax, `${path}.grammar.syntax`);
    string(tool.grammar.definition, `${path}.grammar.definition`);
  }
  if (tool.raw !== undefined) object(tool.raw, `${path}.raw`);
}

function toolChoice(value, path) {
  if (isObject(value)) {
    string(value.name, `${path}.name`);
    optionalString(value.namespace, `${path}.namespace`);
    return;
  }
  oneOf(value, ["auto", "none", "required"], path);
}

function sampling(value, path) {
  object(value, path);
  if (!isAbsent(value.maxOutputTokens)) {
    if (!Number.isInteger(value.maxOutputTokens) || value.maxOutputTokens < 1) {
      shapeError(`${path}.maxOutputTokens`, "a positive integer or null");
    }
  }
  optionalNumber(value.temperature, `${path}.temperature`);
  optionalNumber(value.topP, `${path}.topP`);
  if (value.stop !== undefined) array(value.stop, `${path}.stop`, string);
}

function thinking(value, path) {
  object(value, path);
  oneOf(value.mode, THINKING_MODES, `${path}.mode`);
  if (!isAbsent(value.budgetTokens)) count(value.budgetTokens, `${path}.budgetTokens`);
  if (!isAbsent(value.effort)) string(value.effort, `${path}.effort`);
  if (!isAbsent(value.summary)) oneOf(value.summary, ["auto", "none"], `${path}.summary`);
  if (!isAbsent(value.display))
    oneOf(value.display, THINKING_DISPLAYS, `${path}.display`);
}

function output(value, path) {
  object(value, path);
  oneOf(value.format, ["text", "json_schema"], `${path}.format`);
  if (value.format === "json_schema") {
    string(value.name, `${path}.name`);
    object(value.schema, `${path}.schema`);
    if (value.strict !== undefined) boolean(value.strict, `${path}.strict`);
  }
}

function cache(value, path) {
  object(value, path);
  if (value.key !== null && value.key !== undefined) string(value.key, `${path}.key`);
}

/** Validates an IrRequest; returns it unchanged or throws a TypeError with a path. */
export function assertIrRequest(ir) {
  const path = "request";
  object(ir, path);
  string(ir.model, `${path}.model`);
  array(ir.system, `${path}.system`, irPart);
  array(ir.messages, `${path}.messages`, irMessage);
  array(ir.tools, `${path}.tools`, irTool);
  toolChoice(ir.toolChoice, `${path}.toolChoice`);
  if (!isAbsent(ir.parallelToolCalls)) {
    boolean(ir.parallelToolCalls, `${path}.parallelToolCalls`);
  }
  sampling(ir.sampling, `${path}.sampling`);
  if (!isAbsent(ir.thinking)) thinking(ir.thinking, `${path}.thinking`);
  if (!isAbsent(ir.output)) output(ir.output, `${path}.output`);
  if (!isAbsent(ir.cache)) cache(ir.cache, `${path}.cache`);
  boolean(ir.stream, `${path}.stream`);
  if (!isAbsent(ir.hints)) object(ir.hints, `${path}.hints`);
  return ir;
}

function irError(error, path) {
  object(error, path);
  oneOf(error.kind, ERROR_KINDS, `${path}.kind`);
  if (!isAbsent(error.status)) count(error.status, `${path}.status`);
  string(error.message, `${path}.message`);
  optionalNumber(error.retryAfter, `${path}.retryAfter`);
}

function blockToolCall(value, path) {
  object(value, path);
  string(value.id, `${path}.id`);
  string(value.name, `${path}.name`);
  optionalString(value.namespace, `${path}.namespace`);
  oneOf(value.kind, CALL_KINDS, `${path}.kind`);
}

const EVENT_CHECKS = {
  start(event, path) {
    string(event.id, `${path}.id`);
    string(event.model, `${path}.model`);
  },
  blockStart(event, path) {
    count(event.index, `${path}.index`);
    oneOf(event.kind, BLOCK_KINDS, `${path}.kind`);
    if (event.kind === "toolCall") blockToolCall(event.toolCall, `${path}.toolCall`);
  },
  textDelta(event, path) {
    count(event.index, `${path}.index`);
    string(event.text, `${path}.text`);
  },
  reasoningDelta(event, path) {
    count(event.index, `${path}.index`);
    optionalString(event.text, `${path}.text`);
    optionalString(event.summary, `${path}.summary`);
  },
  reasoningCarrier(event, path) {
    count(event.index, `${path}.index`);
    string(event.carrier, `${path}.carrier`);
  },
  toolInputDelta(event, path) {
    count(event.index, `${path}.index`);
    string(event.fragment, `${path}.fragment`);
  },
  blockStop(event, path) {
    count(event.index, `${path}.index`);
  },
  usage(event, path) {
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning"]) {
      count(event[key], `${path}.${key}`);
    }
    boolean(event.estimated, `${path}.estimated`);
  },
  stop(event, path) {
    oneOf(event.reason, STOP_REASONS, `${path}.reason`);
    optionalString(event.stopSequence, `${path}.stopSequence`);
  },
  error(event, path) {
    irError(event.error, `${path}.error`);
  },
};

/** Validates an IrEvent; returns it unchanged or throws a TypeError with a path. */
export function assertIrEvent(event) {
  const path = "event";
  object(event, path);
  oneOf(event.type, Object.keys(EVENT_CHECKS), `${path}.type`);
  EVENT_CHECKS[event.type](event, path);
  return event;
}
