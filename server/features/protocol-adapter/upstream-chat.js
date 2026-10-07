// Chat Completions upstream: builds `/chat/completions` request bodies from the IR.
// Stream and response parsing live in upstream-chat-parse.js and are re-exported here.

import { decodeCarrier } from "./carrier.js";
import { clampMaxTokens, effortForBudget, resolveEffort } from "./mapping.js";
import {
  chosenTool,
  customToolDescription,
  customToolSchema,
  dropHints,
  imageUrl,
  isObject,
  present,
  textOf,
  upstreamModel,
} from "./shared.js";

export { parseChatResponse, parseChatStream } from "./upstream-chat-parse.js";

const IMAGE_PLACEHOLDER = "[image attached in the next message]";
const ERROR_PREFIX = "[error] ";

function functionTool(tool, names) {
  const custom = tool.kind === "custom";
  const description = custom ? customToolDescription(tool) : tool.description;
  const fn = { name: names.toUpstream(tool.name, tool.namespace) };
  if (typeof description === "string" && description !== "") fn.description = description;
  fn.parameters = custom
    ? customToolSchema()
    : isObject(tool.schema)
      ? tool.schema
      : { type: "object", properties: {} };
  if (!custom && tool.strict === true) fn.strict = true;
  return { type: "function", function: fn };
}

function buildTools(ir, names, drop) {
  const tools = [];
  for (const tool of ir.tools) {
    if (tool.kind === "hosted") drop(`tools.${tool.hostedType ?? tool.name}`);
    else tools.push(functionTool(tool, names));
  }
  return tools;
}

function toolChoice(choice, names) {
  if (isObject(choice)) {
    return {
      type: "function",
      function: { name: names.toUpstream(choice.name, choice.namespace) },
    };
  }
  return choice;
}

function imagePart(part) {
  const image = { url: imageUrl(part) };
  if (typeof part.detail === "string") image.detail = part.detail;
  return { type: "image_url", image_url: image };
}

/** Plain string for a single text part, content parts otherwise. */
function userContent(parts) {
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
  return parts.map((part) =>
    part.type === "text" ? { type: "text", text: part.text } : imagePart(part),
  );
}

function systemMessage(parts, drop, path) {
  if (parts.some((part) => part.type !== "text")) drop(`${path}.image`);
  const text = textOf(parts, "\n\n");
  return text === "" ? null : { role: "system", content: text };
}

function toolMessage(result, ids, images) {
  const resultImages = result.parts.filter((part) => part.type === "image");
  images.push(...resultImages);
  let content = textOf(result.parts, "\n");
  if (content === "" && resultImages.length > 0) content = IMAGE_PLACEHOLDER;
  if (result.isError) content = `${ERROR_PREFIX}${content}`;
  return { role: "tool", tool_call_id: ids.toUpstream(result.callId), content };
}

/** Tool results become `tool` messages; their images and other parts follow as user. */
function userMessages(message, ids, drop) {
  const out = [];
  const rest = [];
  const images = [];
  for (const part of message.parts) {
    if (part.type === "toolResult") out.push(toolMessage(part, ids, images));
    else if (part.type === "text" || part.type === "image") rest.push(part);
    else drop(`user.${part.type}`);
  }
  const parts = [...images, ...rest];
  if (parts.length > 0) out.push({ role: "user", content: userContent(parts) });
  return out;
}

function reasoningText(part) {
  if (typeof part.text === "string" && part.text !== "") return part.text;
  const carrier = decodeCarrier(part.carrier);
  if (carrier?.origin === "chat" && carrier.payload) return carrier.payload;
  if (typeof part.summary === "string" && part.summary !== "") return part.summary;
  return null;
}

function toolCallEntry(part, names, ids) {
  const args =
    part.kind === "custom"
      ? JSON.stringify({ input: part.input })
      : part.input === ""
        ? "{}"
        : part.input;
  return {
    id: ids.toUpstream(part.id),
    type: "function",
    function: { name: names.toUpstream(part.name, part.namespace), arguments: args },
  };
}

function assistantMessage(message, ctx, replay, drop) {
  const texts = [];
  const reasoning = [];
  const calls = [];
  for (const part of message.parts) {
    if (part.type === "text") texts.push(part.text);
    else if (part.type === "toolCall")
      calls.push(toolCallEntry(part, ctx.names, ctx.ids));
    else if (part.type === "reasoning") {
      const text = replay ? reasoningText(part) : null;
      if (text !== null) reasoning.push(text);
    } else drop(`assistant.${part.type}`);
  }
  const content = texts.join("");
  if (content === "" && calls.length === 0) return null;
  const result = { role: "assistant", content: content === "" ? null : content };
  if (reasoning.length > 0) result.reasoning_content = reasoning.join("\n");
  if (calls.length > 0) result.tool_calls = calls;
  return result;
}

const asParts = (content) =>
  typeof content === "string" ? [{ type: "text", text: content }] : content;
const systemTag = (text) => ({ type: "text", text: `<system>\n${text}\n</system>` });

/** Appends a message; adjacent user messages are merged (strict templates alternate). */
function pushMessage(messages, message) {
  const last = messages.at(-1);
  if (message.role === "user" && last?.role === "user") {
    last.content = [...asParts(last.content), ...asParts(message.content)];
  } else messages.push(message);
}

/**
 * Chat messages for the IR. Mid-conversation system messages are kept in place only with
 * `capabilities.systemMessages: "inline"`; by default ("merge") their text moves into the
 * next user turn as a leading `<system>` part (many chat templates reject a system message
 * that is not first, and OpenAI rejects one between tool calls and their results).
 */
function buildMessages(ir, ctx, drop) {
  const replay = ctx.capabilities?.reasoningReplay === true;
  const inline = ctx.capabilities?.systemMessages === "inline";
  const messages = [];
  let pending = [];
  const leading = systemMessage(ir.system, drop, "system");
  if (leading) messages.push(leading);
  for (const message of ir.messages) {
    if (message.role === "system") {
      const system = systemMessage(message.parts, drop, "system");
      if (!system) continue;
      if (inline) messages.push(system);
      else if (messages.every((entry) => entry.role === "system")) {
        if (messages.length > 0) messages[0].content += `\n\n${system.content}`;
        else messages.push(system);
      } else pending.push(systemTag(system.content));
    } else if (message.role === "user") {
      const converted = userMessages(message, ctx.ids, drop);
      if (pending.length > 0) {
        const user = converted.find((entry) => entry.role === "user");
        if (user) user.content = [...pending, ...asParts(user.content)];
        else converted.push({ role: "user", content: pending });
        pending = [];
      }
      for (const entry of converted) pushMessage(messages, entry);
    } else {
      const assistant = assistantMessage(message, ctx, replay, drop);
      if (assistant) messages.push(assistant);
    }
  }
  if (pending.length > 0) pushMessage(messages, { role: "user", content: pending });
  return messages;
}

function reasoningEffort(thinking, adjust) {
  if (!thinking || (thinking.mode !== "enabled" && thinking.mode !== "adaptive")) {
    return undefined;
  }
  if (present(thinking.effort)) return resolveEffort(thinking.effort, adjust);
  if (present(thinking.budgetTokens)) return effortForBudget(thinking.budgetTokens);
  return resolveEffort(undefined);
}

function applySampling(body, sampling, ctx, adjust) {
  if (present(sampling.maxOutputTokens)) {
    const field =
      ctx.capabilities?.maxTokensField === "max_completion_tokens"
        ? "max_completion_tokens"
        : "max_tokens";
    body[field] = clampMaxTokens(sampling.maxOutputTokens, ctx.model, adjust);
  }
  if (present(sampling.temperature)) body.temperature = sampling.temperature;
  if (present(sampling.topP)) body.top_p = sampling.topP;
  if (Array.isArray(sampling.stop) && sampling.stop.length > 0)
    body.stop = [...sampling.stop];
}

function responseFormat(output) {
  if (output?.format !== "json_schema") return undefined;
  const schema = { name: output.name, schema: output.schema };
  if (output.strict !== undefined) schema.strict = output.strict;
  return { type: "json_schema", json_schema: schema };
}

/**
 * Chat Completions request for an IR request. Keys are inserted in a fixed order and
 * schemas pass through in client order (property order is meaningful to the model and
 * already stable per client), so identical prefixes serialize identically (prefix caching).
 * IR hints and hosted tools are never sent; they are listed in `dropped`.
 */
export function buildChatRequest(ir, ctx) {
  const capabilities = ctx.capabilities ?? {};
  const dropped = new Set();
  const adjustments = [];
  const drop = (name) => dropped.add(name);
  const adjust = (name) => adjustments.push(name);
  dropHints(ir, drop);

  const body = {
    model: upstreamModel(ir, ctx.model),
    messages: buildMessages(ir, ctx, drop),
  };
  const tools = buildTools(ir, ctx.names, drop);
  if (tools.length > 0) {
    body.tools = tools;
    let choice = ir.toolChoice;
    // Hosted tools are dropped here, so a choice naming one would name a missing tool.
    if (chosenTool(ir, choice)?.kind === "hosted") {
      choice = "auto";
      adjust("toolChoice.hostedToolDropped");
    }
    body.tool_choice = toolChoice(choice, ctx.names);
    if (
      capabilities.parallelToolCalls === true &&
      typeof ir.parallelToolCalls === "boolean"
    ) {
      body.parallel_tool_calls = ir.parallelToolCalls;
    }
  }
  applySampling(body, ir.sampling ?? {}, ctx, adjust);
  if (capabilities.reasoningEffort === true) {
    const effort = reasoningEffort(ir.thinking, adjust);
    if (effort !== undefined) body.reasoning_effort = effort;
  }
  const format = responseFormat(ir.output);
  if (format) body.response_format = format;
  const cacheKey = ir.cache?.key ?? ctx.sessionKey;
  if (
    capabilities.promptCacheKey === true &&
    typeof cacheKey === "string" &&
    cacheKey !== ""
  ) {
    body.prompt_cache_key = cacheKey;
  }
  body.stream = ir.stream === true;
  if (body.stream && capabilities.streamUsage !== false) {
    body.stream_options = { include_usage: true };
  }
  return { path: "/chat/completions", body, dropped: [...dropped], adjustments };
}
