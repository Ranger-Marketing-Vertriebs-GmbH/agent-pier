// Codex client (OpenAI Responses wire format): parses requests into the adapter IR.
// Fields the IR cannot carry are reported in `dropped`; `previous_response_id` is
// reported in `rejected` because the adapter keeps no server-side conversation state.

import { mediaTypeFromUrl } from "./client-messages.js";
import { assertIrRequest } from "./ir.js";
import { normalizeEffortWithInfo } from "./mapping.js";

/** Top-level fields that are parsed, mapped to hints, or deliberately ignored. */
const KNOWN_FIELDS = new Set([
  "model",
  "instructions",
  "input",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "store",
  "stream",
  "include",
  "service_tier",
  "prompt_cache_key",
  "text",
  "client_metadata",
  "max_output_tokens",
  "temperature",
  "top_p",
  "metadata",
  "user",
  "previous_response_id",
]);
const FUNCTION_TOOL_FIELDS = new Set([
  "type",
  "name",
  "description",
  "strict",
  "parameters",
]);
const CUSTOM_TOOL_FIELDS = new Set(["type", "name", "description", "format"]);
const MESSAGE_ROLES = Object.freeze({
  user: "user",
  assistant: "assistant",
  system: "system",
  developer: "system",
});
const SUMMARIES = Object.freeze({
  auto: "auto",
  concise: "auto",
  detailed: "auto",
  none: "none",
});
const TOOL_CHOICES = ["auto", "none", "required"];

const isObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isAbsent = (value) => value === undefined || value === null;

function shapeError(path, expected) {
  throw new TypeError(`${path}: expected ${expected}`);
}

function requireString(value, path) {
  if (typeof value !== "string") shapeError(path, "a string");
  return value;
}

function requireObject(value, path) {
  if (!isObject(value)) shapeError(path, "an object");
  return value;
}

// --- content parts -------------------------------------------------------------------

function textPart(value) {
  return value === "" ? null : { type: "text", text: value };
}

function imagePart(item, path, drop) {
  if (isAbsent(item.image_url)) {
    drop(isAbsent(item.file_id) ? "input_image" : "input_image.file_id");
    return null;
  }
  const url = requireString(item.image_url, `${path}.image_url`);
  const detail = isAbsent(item.detail)
    ? {}
    : { detail: requireString(item.detail, `${path}.detail`) };
  const base64 = /^data:([^;,]+);base64,(.*)$/is.exec(url);
  if (base64) {
    return {
      type: "image",
      mediaType: base64[1].toLowerCase(),
      data: base64[2],
      ...detail,
    };
  }
  return { type: "image", mediaType: mediaTypeFromUrl(url), url, ...detail };
}

const CONTENT_PARSERS = {
  input_text: (item, path) => textPart(requireString(item.text, `${path}.text`)),
  output_text: (item, path) => textPart(requireString(item.text, `${path}.text`)),
  refusal: (item, path) => textPart(requireString(item.refusal, `${path}.refusal`)),
  input_image: imagePart,
};

function contentParts(content, path, drop) {
  if (typeof content === "string") return [textPart(content)].filter(Boolean);
  if (!Array.isArray(content)) shapeError(path, "a string or an array");
  return content
    .map((item, index) => {
      const itemPath = `${path}[${index}]`;
      requireObject(item, itemPath);
      if (!Object.hasOwn(CONTENT_PARSERS, item.type)) {
        drop(`content.${item.type}`);
        return null;
      }
      return CONTENT_PARSERS[item.type](item, itemPath, drop);
    })
    .filter(Boolean);
}

// --- input items ---------------------------------------------------------------------

function toolCallPart(item, path, kind, inputField) {
  const part = {
    type: "toolCall",
    id: requireString(item.call_id, `${path}.call_id`),
    name: requireString(item.name, `${path}.name`),
    kind,
    input: requireString(item[inputField] ?? "", `${path}.${inputField}`),
  };
  if (!isAbsent(item.namespace)) {
    part.namespace = requireString(item.namespace, `${path}.namespace`);
  }
  return part;
}

function toolResultPart(item, path, drop) {
  return {
    type: "toolResult",
    callId: requireString(item.call_id, `${path}.call_id`),
    parts: isAbsent(item.output) ? [] : contentParts(item.output, `${path}.output`, drop),
    isError: false,
  };
}

function joinedTexts(list, path, types) {
  if (!Array.isArray(list)) return null;
  const texts = list
    .filter((entry) => isObject(entry) && types.includes(entry.type))
    .map((entry, index) => requireString(entry.text, `${path}[${index}].text`));
  return texts.length > 0 ? texts.join("\n\n") : null;
}

function reasoningPart(item, path) {
  const part = { type: "reasoning" };
  const text = joinedTexts(item.content, `${path}.content`, ["reasoning_text", "text"]);
  if (text !== null) part.text = text;
  const summary = joinedTexts(item.summary, `${path}.summary`, ["summary_text"]);
  if (summary !== null) part.summary = summary;
  if (!isAbsent(item.encrypted_content)) {
    part.carrier = requireString(item.encrypted_content, `${path}.encrypted_content`);
  }
  return part;
}

/** Each parser returns `{ role, parts, results? }` or null for a dropped item. */
const ITEM_PARSERS = {
  message(item, path, drop) {
    if (!Object.hasOwn(MESSAGE_ROLES, item.role)) {
      shapeError(`${path}.role`, "user|assistant|system|developer");
    }
    if (!isAbsent(item.phase)) drop("message.phase");
    const parts = contentParts(item.content, `${path}.content`, drop);
    return { role: MESSAGE_ROLES[item.role], parts };
  },
  function_call: (item, path) => ({
    role: "assistant",
    parts: [toolCallPart(item, path, "function", "arguments")],
  }),
  custom_tool_call: (item, path) => ({
    role: "assistant",
    parts: [toolCallPart(item, path, "custom", "input")],
  }),
  reasoning: (item, path) => ({ role: "assistant", parts: [reasoningPart(item, path)] }),
  function_call_output: (item, path, drop) => ({
    role: "user",
    parts: [toolResultPart(item, path, drop)],
    results: true,
  }),
  custom_tool_call_output: (item, path, drop) => ({
    role: "user",
    parts: [toolResultPart(item, path, drop)],
    results: true,
  }),
};

function parseItem(item, path, drop) {
  requireObject(item, path);
  const type = item.type ?? (isAbsent(item.role) ? undefined : "message");
  if (!Object.hasOwn(ITEM_PARSERS, type)) {
    drop(`input.${type}`);
    return null;
  }
  return ITEM_PARSERS[type](item, path, drop);
}

/**
 * Consecutive assistant-side items (reasoning, text, tool calls) form one assistant turn
 * and consecutive tool outputs one user turn, as the Messages and Chat upstreams expect.
 */
function appendTurn(messages, turn) {
  const last = messages.at(-1);
  const mergeable =
    last &&
    last.role === turn.role &&
    (turn.role === "assistant" || (turn.results && last.results));
  if (mergeable) last.parts.push(...turn.parts);
  else messages.push({ ...turn, parts: [...turn.parts] });
}

function parseInput(input, drop) {
  if (typeof input === "string") {
    return input === "" ? [] : [{ role: "user", parts: [{ type: "text", text: input }] }];
  }
  if (!Array.isArray(input)) shapeError("input", "a string or an array");
  const messages = [];
  input.forEach((item, index) => {
    const turn = parseItem(item, `input[${index}]`, drop);
    if (turn && turn.parts.length > 0) appendTurn(messages, turn);
  });
  return messages.map(({ role, parts }) => ({ role, parts }));
}

/** `instructions` plus every system message before the first conversation turn. */
function splitSystem(body, messages) {
  const system = [];
  if (!isAbsent(body.instructions)) {
    const part = textPart(requireString(body.instructions, "instructions"));
    if (part) system.push(part);
  }
  let start = 0;
  while (start < messages.length && messages[start].role === "system") {
    system.push(...messages[start].parts);
    start += 1;
  }
  return { system, messages: messages.slice(start) };
}

// --- tools ---------------------------------------------------------------------------

function dropUnknownKeys(tool, known, drop) {
  for (const key of Object.keys(tool)) if (!known.has(key)) drop(`tools.${key}`);
}

function withDescription(parsed, tool, path) {
  if (!isAbsent(tool.description)) {
    parsed.description = requireString(tool.description, `${path}.description`);
  }
  return parsed;
}

function functionTool(tool, path, drop, namespace) {
  dropUnknownKeys(tool, FUNCTION_TOOL_FIELDS, drop);
  const parsed = {
    name: requireString(tool.name, `${path}.name`),
    ...namespace,
    kind: "function",
    schema: tool.parameters ?? { type: "object" },
  };
  if (typeof tool.strict === "boolean") parsed.strict = tool.strict;
  return withDescription(parsed, tool, path);
}

function customTool(tool, path, drop, namespace) {
  dropUnknownKeys(tool, CUSTOM_TOOL_FIELDS, drop);
  const parsed = {
    name: requireString(tool.name, `${path}.name`),
    ...namespace,
    kind: "custom",
  };
  const format = tool.format;
  if (format?.type === "grammar") {
    parsed.grammar = {
      syntax: requireString(format.syntax, `${path}.format.syntax`),
      definition: requireString(format.definition, `${path}.format.definition`),
    };
  } else if (!isAbsent(format) && format.type !== "text") {
    drop("tools.custom.format");
  }
  return withDescription(parsed, tool, path);
}

const MEMBER_PARSERS = { function: functionTool, custom: customTool };

function namespaceTools(tool, path, drop, descriptions) {
  const name = requireString(tool.name, `${path}.name`);
  if (!isAbsent(tool.description)) {
    descriptions[name] = requireString(tool.description, `${path}.description`);
  }
  if (!Array.isArray(tool.tools)) shapeError(`${path}.tools`, "an array");
  return tool.tools.map((member, index) => {
    const memberPath = `${path}.tools[${index}]`;
    requireObject(member, memberPath);
    if (!Object.hasOwn(MEMBER_PARSERS, member.type)) {
      shapeError(`${memberPath}.type`, "function|custom");
    }
    return MEMBER_PARSERS[member.type](member, memberPath, drop, { namespace: name });
  });
}

/** Hosted tools keep the client's object so a Responses upstream receives it unchanged. */
function hostedTool(tool, path) {
  const hostedType = tool.type;
  const name = isAbsent(tool.name)
    ? hostedType
    : requireString(tool.name, `${path}.name`);
  return { name, kind: "hosted", hostedType, raw: tool };
}

function parseTools(tools, drop) {
  const descriptions = {};
  if (isAbsent(tools)) return { tools: [], descriptions };
  if (!Array.isArray(tools)) shapeError("tools", "an array");
  const parsed = tools.flatMap((tool, index) => {
    const path = `tools[${index}]`;
    requireObject(tool, path);
    requireString(tool.type, `${path}.type`);
    if (tool.type === "namespace") return namespaceTools(tool, path, drop, descriptions);
    if (Object.hasOwn(MEMBER_PARSERS, tool.type)) {
      return [MEMBER_PARSERS[tool.type](tool, path, drop, {})];
    }
    return [hostedTool(tool, path)];
  });
  return { tools: parsed, descriptions };
}

function parseToolChoice(choice, drop) {
  if (isAbsent(choice)) return "auto";
  if (TOOL_CHOICES.includes(choice)) return choice;
  if (isObject(choice) && (choice.type === "function" || choice.type === "custom")) {
    const parsed = { name: requireString(choice.name, "tool_choice.name") };
    if (!isAbsent(choice.namespace)) {
      parsed.namespace = requireString(choice.namespace, "tool_choice.namespace");
    }
    return parsed;
  }
  drop("tool_choice");
  return "auto";
}

// --- settings ------------------------------------------------------------------------

function parseThinking(reasoning, drop) {
  if (isAbsent(reasoning)) return null;
  requireObject(reasoning, "reasoning");
  if (reasoning.effort === "none") return { mode: "disabled" };
  const thinking = { mode: "enabled" };
  if (!isAbsent(reasoning.effort)) {
    const { effort, unknown } = normalizeEffortWithInfo(reasoning.effort);
    if (unknown) drop("reasoning.effort.unknown");
    thinking.effort = effort;
  }
  const summary = reasoning.summary ?? "none";
  if (Object.hasOwn(SUMMARIES, summary)) thinking.summary = SUMMARIES[summary];
  else {
    drop("reasoning.summary");
    thinking.summary = "none";
  }
  return thinking;
}

function parseOutput(text, drop) {
  const format = isObject(text) ? text.format : undefined;
  if (isAbsent(format) || format.type === "text") return null;
  if (format.type === "json_schema" && isObject(format.schema)) {
    const output = {
      format: "json_schema",
      name: requireString(format.name ?? "output", "text.format.name"),
      schema: format.schema,
    };
    if (typeof format.strict === "boolean") output.strict = format.strict;
    return output;
  }
  drop("text.format");
  return null;
}

function parseHints(body, descriptions) {
  const hints = {};
  const copy = (key, value) => {
    if (!isAbsent(value)) hints[key] = value;
  };
  copy("store", body.store);
  copy("include", body.include);
  copy("serviceTier", body.service_tier);
  copy("clientMetadata", body.client_metadata);
  copy("verbosity", isObject(body.text) ? body.text.verbosity : undefined);
  copy("reasoningContext", isObject(body.reasoning) ? body.reasoning.context : undefined);
  copy("metadata", body.metadata);
  copy("user", body.user);
  if (Object.keys(descriptions).length > 0) hints.namespaceDescriptions = descriptions;
  return hints;
}

function parseSampling(body) {
  return {
    maxOutputTokens: body.max_output_tokens ?? null,
    temperature: body.temperature ?? null,
    topP: body.top_p ?? null,
    stop: [],
  };
}

function rejection(body) {
  if (isAbsent(body.previous_response_id)) return {};
  return {
    rejected: {
      kind: "invalidRequest",
      status: 400,
      message: "previous_response_id is not supported; send the full conversation input",
    },
  };
}

/**
 * Parses a Codex `POST /responses` body into an IrRequest. Throws a TypeError naming
 * the path for malformed input; unsupported fields are listed in `dropped`, and a
 * request the adapter must refuse carries an IrError in `rejected`. Codex headers carry
 * no translation-relevant data, so `_headers` is accepted for interface symmetry.
 */
export function parseResponsesRequest(body, _headers = {}) {
  if (!isObject(body)) shapeError("body", "an object");
  const dropped = new Set();
  const drop = (name) => dropped.add(name);
  for (const key of Object.keys(body)) if (!KNOWN_FIELDS.has(key)) drop(key);

  const model = requireString(body.model, "model");
  const { system, messages } = splitSystem(body, parseInput(body.input ?? [], drop));
  const { tools, descriptions } = parseTools(body.tools, drop);
  const ir = {
    model,
    system,
    messages,
    tools,
    toolChoice: parseToolChoice(body.tool_choice, drop),
    parallelToolCalls:
      typeof body.parallel_tool_calls === "boolean" ? body.parallel_tool_calls : null,
    sampling: parseSampling(body),
    thinking: parseThinking(body.reasoning, drop),
    output: parseOutput(body.text, drop),
    cache: {
      key: isAbsent(body.prompt_cache_key)
        ? null
        : requireString(body.prompt_cache_key, "prompt_cache_key"),
    },
    stream: body.stream === true,
    hints: parseHints(body, descriptions),
  };
  return { ir: assertIrRequest(ir), dropped: [...dropped], ...rejection(body) };
}
