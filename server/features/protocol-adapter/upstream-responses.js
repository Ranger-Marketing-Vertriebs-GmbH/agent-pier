// OpenAI Responses upstream: builds `/responses` request bodies from the IR.
// Stream and response parsing live in upstream-responses-parse.js and are re-exported here.

import { decodeCarrier } from "./carrier.js";
import { clampMaxTokens, effortForBudget, resolveEffort } from "./mapping.js";
import {
  chosenTool,
  dropHints,
  imageUrl,
  isObject,
  present,
  strictFlag,
  textOf,
  upstreamModel,
} from "./shared.js";

export {
  parseResponsesResponse,
  parseResponsesStream,
} from "./upstream-responses-parse.js";

const ENCRYPTED_REASONING = "reasoning.encrypted_content";
const ERROR_PREFIX = "[error] ";
/**
 * Efforts every OpenAI reasoning model accepts: low|medium|high. `minimal` (rejected by
 * gpt-5.1+) and xhigh/max are clamped and counted as `reasoning.effort.clamped`.
 */
const UPSTREAM_EFFORT = Object.freeze({
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
});

function functionTool(tool, names, adjust) {
  const result = { type: "function", name: names.toUpstream(tool.name, tool.namespace) };
  if (typeof tool.description === "string" && tool.description !== "") {
    result.description = tool.description;
  }
  result.parameters = isObject(tool.schema)
    ? tool.schema
    : { type: "object", properties: {} };
  // Responses treats an omitted `strict` as strict mode; client tools are non-strict
  // unless they ask for strict mode and their schema qualifies.
  result.strict = strictFlag(tool, adjust);
  return result;
}

function customTool(tool, names) {
  const result = { type: "custom", name: names.toUpstream(tool.name, tool.namespace) };
  if (typeof tool.description === "string" && tool.description !== "") {
    result.description = tool.description;
  }
  if (isObject(tool.grammar)) result.format = tool.grammar;
  return result;
}

/**
 * Hosted tools are native here: the client's own definition is kept when it is a
 * Responses definition (`raw.type` equals the hosted type). Other clients' definitions,
 * e.g. Claude Code's versioned `web_search_20250305`, are dropped and counted.
 */
function buildTools(ir, names, drop, adjust) {
  const tools = [];
  for (const tool of ir.tools) {
    if (tool.kind === "custom") tools.push(customTool(tool, names));
    else if (tool.kind !== "hosted") tools.push(functionTool(tool, names, adjust));
    else if (isObject(tool.raw) && tool.raw.type === tool.hostedType)
      tools.push(tool.raw);
    else drop(`tools.${tool.hostedType ?? tool.name}`);
  }
  return tools;
}

/**
 * Responses `tool_choice`: a forced custom tool is `{ type: "custom", name }` and a forced
 * hosted tool `{ type: <hosted type> }` when its definition is forwarded; a choice naming
 * a dropped hosted tool becomes `auto` (counted).
 */
function toolChoice(ir, tools, names, adjust) {
  const choice = ir.toolChoice;
  if (!isObject(choice)) return choice;
  const tool = chosenTool(ir, choice);
  if (tool?.kind === "hosted") {
    if (tools.includes(tool.raw)) return { type: tool.hostedType };
    adjust("toolChoice.hostedToolDropped");
    return "auto";
  }
  const type = tool?.kind === "custom" ? "custom" : "function";
  return { type, name: names.toUpstream(choice.name, choice.namespace) };
}

function inputImage(part) {
  return {
    type: "input_image",
    image_url: imageUrl(part),
    detail: typeof part.detail === "string" ? part.detail : "auto",
  };
}

const inputPart = (part) =>
  part.type === "text" ? { type: "input_text", text: part.text } : inputImage(part);

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
      items.push(
        message("assistant", [{ type: "output_text", text: joined, annotations: [] }]),
      );
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

function reasoningConfig(thinking, adjust) {
  if (!thinking || (thinking.mode !== "enabled" && thinking.mode !== "adaptive")) {
    return undefined;
  }
  let effort;
  if (present(thinking.effort)) effort = resolveEffort(thinking.effort, adjust);
  else if (present(thinking.budgetTokens))
    effort = effortForBudget(thinking.budgetTokens);
  else effort = resolveEffort(undefined);
  if (effort === "none") return undefined;
  const reasoning = { effort: UPSTREAM_EFFORT[effort] };
  if (reasoning.effort !== effort) adjust("reasoning.effort.clamped");
  if (thinking.display !== "omitted" && thinking.summary !== "none") {
    reasoning.summary = "auto";
  }
  return reasoning;
}

function applySampling(body, sampling, model, drop, adjust) {
  if (present(sampling.maxOutputTokens)) {
    body.max_output_tokens = clampMaxTokens(sampling.maxOutputTokens, model, adjust);
  }
  if (present(sampling.temperature)) body.temperature = sampling.temperature;
  if (present(sampling.topP)) body.top_p = sampling.topP;
  if (Array.isArray(sampling.stop) && sampling.stop.length > 0) drop("sampling.stop");
}

function textFormat(output) {
  if (output?.format !== "json_schema") return undefined;
  const format = {
    type: "json_schema",
    name: typeof output.name === "string" && output.name !== "" ? output.name : "output",
    schema: output.schema,
  };
  if (output.strict !== undefined) format.strict = output.strict;
  return { format };
}

/**
 * Responses request for an IR request. `store` is always false, so no item ids are sent
 * and reasoning is replayed only through `encrypted_content`. Keys are inserted in a fixed
 * order and schemas pass through in client order (property order is meaningful to the
 * model and already stable per client), so identical prefixes serialize identically.
 * IR hints are never sent; they are listed in `dropped`.
 */
export function buildResponsesRequest(ir, ctx) {
  const capabilities = ctx.capabilities ?? {};
  const dropped = [];
  const adjustments = [];
  const drop = (name) => dropped.push(name);
  const adjust = (name) => adjustments.push(name);
  dropHints(ir, drop);

  const { instructions, input, replayed } = buildInput(ir, ctx, drop);
  const body = { model: upstreamModel(ir, ctx.model) };
  if (instructions !== "") body.instructions = instructions;
  body.input = input;
  const tools = buildTools(ir, ctx.names, drop, adjust);
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = toolChoice(ir, tools, ctx.names, adjust);
    if (
      capabilities.parallelToolCalls === true &&
      typeof ir.parallelToolCalls === "boolean"
    ) {
      body.parallel_tool_calls = ir.parallelToolCalls;
    }
  }
  const reasoning =
    capabilities.reasoningEffort === false
      ? undefined
      : reasoningConfig(ir.thinking, adjust);
  if (reasoning) body.reasoning = reasoning;
  if (reasoning || replayed) body.include = [ENCRYPTED_REASONING];
  applySampling(body, ir.sampling ?? {}, ctx.model, drop, adjust);
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
  return {
    path: "/responses",
    body,
    dropped: [...new Set(dropped)],
    adjustments: [...new Set(adjustments)],
  };
}
