// OpenAI Responses upstream: builds `/responses` request bodies from the IR.
// Stream and response parsing live in upstream-responses-parse.js and are re-exported here.

import { decodeCarrier } from "./carrier.js";
import { effortForBudget, normalizeEffort } from "./mapping.js";

export {
  parseResponsesResponse,
  parseResponsesStream,
} from "./upstream-responses-parse.js";

const ENCRYPTED_REASONING = "reasoning.encrypted_content";
const ERROR_PREFIX = "[error] ";
/** OpenAI reasoning models accept minimal|low|medium|high; larger efforts are clamped. */
const UPSTREAM_EFFORT = Object.freeze({
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
});

const isObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const present = (value) => value !== undefined && value !== null;

/** Recursively sorts object keys so tool schemas serialize identically every time. */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isObject(value)) return value;
  const sorted = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortKeys(value[key]);
  return sorted;
}

function upstreamModel(ir, model) {
  if (typeof model === "string" && model !== "") return model;
  if (isObject(model) && typeof model.id === "string" && model.id !== "") return model.id;
  return ir.model;
}

function functionTool(tool, names) {
  const result = { type: "function", name: names.toUpstream(tool.name, tool.namespace) };
  if (typeof tool.description === "string" && tool.description !== "") {
    result.description = tool.description;
  }
  result.parameters = sortKeys(
    isObject(tool.schema) ? tool.schema : { type: "object", properties: {} },
  );
  if (tool.strict === true) result.strict = true;
  return result;
}

function customTool(tool, names) {
  const result = { type: "custom", name: names.toUpstream(tool.name, tool.namespace) };
  if (typeof tool.description === "string" && tool.description !== "") {
    result.description = tool.description;
  }
  if (isObject(tool.grammar)) result.format = sortKeys(tool.grammar);
  return result;
}

/** Hosted tools are native here: the client's own definition is kept when it was recorded. */
function buildTools(ir, names, drop) {
  const tools = [];
  for (const tool of ir.tools) {
    if (tool.kind === "custom") tools.push(customTool(tool, names));
    else if (tool.kind !== "hosted") tools.push(functionTool(tool, names));
    else if (isObject(tool.raw)) tools.push(sortKeys(tool.raw));
    else drop(`tools.${tool.hostedType ?? tool.name}`);
  }
  return tools;
}

function toolChoice(choice, names) {
  if (isObject(choice)) {
    return { type: "function", name: names.toUpstream(choice.name, choice.namespace) };
  }
  return choice;
}

function inputImage(part) {
  const url = present(part.data)
    ? `data:${part.mediaType};base64,${part.data}`
    : part.url;
  return {
    type: "input_image",
    image_url: url,
    detail: typeof part.detail === "string" ? part.detail : "auto",
  };
}

const inputPart = (part) =>
  part.type === "text" ? { type: "input_text", text: part.text } : inputImage(part);

function textOf(parts, separator) {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join(separator);
}

function systemText(parts, drop) {
  if (parts.some((part) => part.type !== "text")) drop("system.image");
  return textOf(parts, "\n\n");
}

const message = (role, content) => ({ type: "message", role, content });

function toolOutput(result, ids, callKinds) {
  const callId = ids.toUpstream(result.callId);
  const type =
    callKinds.get(result.callId) === "custom"
      ? "custom_tool_call_output"
      : "function_call_output";
  const prefix = result.isError ? ERROR_PREFIX : "";
  let output;
  if (result.parts.some((part) => part.type === "image")) {
    output = result.parts.map(inputPart);
    if (prefix) output.unshift({ type: "input_text", text: prefix.trim() });
  } else output = `${prefix}${textOf(result.parts, "\n")}`;
  return { type, call_id: callId, output };
}

/** Tool results become output items; other parts are grouped into user messages in order. */
function userItems(entry, ctx, callKinds, drop) {
  const items = [];
  let content = [];
  const flush = () => {
    if (content.length > 0) items.push(message("user", content));
    content = [];
  };
  for (const part of entry.parts) {
    if (part.type === "toolResult") {
      flush();
      items.push(toolOutput(part, ctx.ids, callKinds));
    } else if (part.type === "text" || part.type === "image")
      content.push(inputPart(part));
    else drop(`user.${part.type}`);
  }
  flush();
  return items;
}

/** Only reasoning that came from a Responses upstream can be replayed (encrypted). */
function reasoningItem(part) {
  const carrier = decodeCarrier(part.carrier);
  if (carrier?.origin !== "responses" || !carrier.payload) return null;
  const summary = part.summary ?? part.text;
  return {
    type: "reasoning",
    summary:
      typeof summary === "string" && summary !== ""
        ? [{ type: "summary_text", text: summary }]
        : [],
    encrypted_content: carrier.payload,
  };
}

function callItem(part, ctx, callKinds) {
  callKinds.set(part.id, part.kind);
  const callId = ctx.ids.toUpstream(part.id);
  const name = ctx.names.toUpstream(part.name, part.namespace);
  if (part.kind === "custom") {
    return { type: "custom_tool_call", call_id: callId, name, input: part.input };
  }
  return {
    type: "function_call",
    call_id: callId,
    name,
    arguments: part.input === "" ? "{}" : part.input,
  };
}

function assistantItems(entry, ctx, callKinds, drop, state) {
  const items = [];
  let texts = [];
  const flush = () => {
    const joined = texts.join("");
    if (joined !== "") {
      items.push(message("assistant", [{ type: "output_text", text: joined }]));
    }
    texts = [];
  };
  for (const part of entry.parts) {
    if (part.type === "text") {
      texts.push(part.text);
      continue;
    }
    flush();
    if (part.type === "toolCall") items.push(callItem(part, ctx, callKinds));
    else if (part.type === "reasoning") {
      const item = reasoningItem(part);
      if (item) {
        items.push(item);
        state.replayed = true;
      } else drop("assistant.reasoning");
    } else drop(`assistant.${part.type}`);
  }
  flush();
  return items;
}

/**
 * Input items for the IR. System text before the first other message joins `instructions`;
 * later system messages become `developer` messages at their position.
 */
function buildInput(ir, ctx, drop) {
  const callKinds = new Map();
  const state = { replayed: false };
  const instructions = [systemText(ir.system, drop)];
  const input = [];
  for (const entry of ir.messages) {
    if (entry.role === "system") {
      const content = systemText(entry.parts, drop);
      if (content === "") continue;
      if (input.length === 0) instructions.push(content);
      else input.push(message("developer", [{ type: "input_text", text: content }]));
    } else if (entry.role === "user") {
      input.push(...userItems(entry, ctx, callKinds, drop));
    } else input.push(...assistantItems(entry, ctx, callKinds, drop, state));
  }
  return {
    instructions: instructions.filter((text) => text !== "").join("\n\n"),
    input,
    replayed: state.replayed,
  };
}

function reasoningConfig(thinking) {
  if (!thinking || (thinking.mode !== "enabled" && thinking.mode !== "adaptive")) {
    return undefined;
  }
  let effort;
  if (present(thinking.effort)) effort = normalizeEffort(thinking.effort);
  else if (present(thinking.budgetTokens))
    effort = effortForBudget(thinking.budgetTokens);
  else effort = normalizeEffort(undefined);
  if (effort === "none") return undefined;
  const reasoning = { effort: UPSTREAM_EFFORT[effort] };
  if (thinking.display !== "omitted" && thinking.summary !== "none") {
    reasoning.summary = "auto";
  }
  return reasoning;
}

function applySampling(body, sampling, drop) {
  if (present(sampling.maxOutputTokens))
    body.max_output_tokens = sampling.maxOutputTokens;
  if (present(sampling.temperature)) body.temperature = sampling.temperature;
  if (present(sampling.topP)) body.top_p = sampling.topP;
  if (Array.isArray(sampling.stop) && sampling.stop.length > 0) drop("sampling.stop");
}

function textFormat(output) {
  if (output?.format !== "json_schema") return undefined;
  const format = {
    type: "json_schema",
    name: output.name,
    schema: sortKeys(output.schema),
  };
  if (output.strict !== undefined) format.strict = output.strict;
  return { format };
}

/**
 * Responses request for an IR request. `store` is always false, so no item ids are sent
 * and reasoning is replayed only through `encrypted_content`. Keys are inserted in a fixed
 * order and tool schemas are key-sorted so identical prefixes serialize identically.
 * IR hints are never sent; they are listed in `dropped`.
 */
export function buildResponsesRequest(ir, ctx) {
  const capabilities = ctx.capabilities ?? {};
  const dropped = [];
  const drop = (name) => dropped.push(name);
  for (const key of Object.keys(ir.hints ?? {})) drop(`hints.${key}`);

  const { instructions, input, replayed } = buildInput(ir, ctx, drop);
  const body = { model: upstreamModel(ir, ctx.model) };
  if (instructions !== "") body.instructions = instructions;
  body.input = input;
  const tools = buildTools(ir, ctx.names, drop);
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = toolChoice(ir.toolChoice, ctx.names);
    if (
      capabilities.parallelToolCalls === true &&
      typeof ir.parallelToolCalls === "boolean"
    ) {
      body.parallel_tool_calls = ir.parallelToolCalls;
    }
  }
  const reasoning =
    capabilities.reasoningEffort === false ? undefined : reasoningConfig(ir.thinking);
  if (reasoning) body.reasoning = reasoning;
  if (reasoning || replayed) body.include = [ENCRYPTED_REASONING];
  applySampling(body, ir.sampling ?? {}, drop);
  const format = textFormat(ir.output);
  if (format) body.text = format;
  const cacheKey = ir.cache?.key ?? ctx.sessionKey;
  if (
    capabilities.promptCacheKey === true &&
    typeof cacheKey === "string" &&
    cacheKey !== ""
  ) {
    body.prompt_cache_key = cacheKey;
  }
  body.store = false;
  body.stream = ir.stream === true;
  return { path: "/responses", body, dropped: [...new Set(dropped)] };
}
