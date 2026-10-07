// Claude Code client (Anthropic Messages wire format): parses requests into the adapter
// IR. Fields the IR cannot carry are reported in `dropped` instead of failing.

import { assertIrRequest, THINKING_DISPLAYS } from "./ir.js";
import { normalizeEffortWithInfo } from "./mapping.js";

const KNOWN_FIELDS = new Set([
  "model",
  "messages",
  "system",
  "tools",
  "tool_choice",
  "disable_parallel_tool_use",
  "metadata",
  "max_tokens",
  "temperature",
  "top_p",
  "stop_sequences",
  "stream",
  "thinking",
  "output_config",
  "context_management",
  "service_tier",
]);
const TOOL_FIELDS = new Set([
  "name",
  "description",
  "input_schema",
  "type",
  "cache_control",
  "strict",
]);
const CACHE_TTLS = ["5m", "1h"];
const MESSAGE_ROLES = ["user", "assistant", "system"];
const IMAGE_TYPES = Object.freeze({
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
});

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

/** IR cache mark; a known `ttl` is kept as `cacheTtl` (only Messages upstreams use it). */
function cacheOf(block, drop) {
  const control = block.cache_control;
  if (isAbsent(control)) return {};
  if (control.type !== "ephemeral") {
    drop("cache_control");
    return {};
  }
  if (isAbsent(control.ttl)) return { cache: "ephemeral" };
  if (CACHE_TTLS.includes(control.ttl))
    return { cache: "ephemeral", cacheTtl: control.ttl };
  drop("cache_control.ttl");
  return { cache: "ephemeral" };
}

function textPart(block, path, drop) {
  const text = requireString(block.text, `${path}.text`);
  if (Array.isArray(block.citations) && block.citations.length > 0)
    drop("text.citations");
  if (text === "") return null;
  return { type: "text", text, ...cacheOf(block, drop) };
}

/** Media type of a data URL, or a guess from the file extension of a plain URL. */
export function mediaTypeFromUrl(url) {
  const dataUrl = /^data:([^;,]+)[;,]/i.exec(url);
  if (dataUrl) return dataUrl[1].toLowerCase();
  const extension = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase();
  return IMAGE_TYPES[extension] ?? "application/octet-stream";
}

function imagePart(block, path, drop) {
  const source = block.source;
  if (!isObject(source)) shapeError(`${path}.source`, "an object");
  const cache = cacheOf(block, drop);
  if (source.type === "base64") {
    return {
      type: "image",
      mediaType: requireString(source.media_type, `${path}.source.media_type`),
      data: requireString(source.data, `${path}.source.data`),
      ...cache,
    };
  }
  if (source.type === "url") {
    const url = requireString(source.url, `${path}.source.url`);
    return { type: "image", mediaType: mediaTypeFromUrl(url), url, ...cache };
  }
  drop(`image.${source.type}`);
  return null;
}

function toolResultParts(content, path, drop) {
  if (isAbsent(content)) return [];
  if (typeof content === "string")
    return content === "" ? [] : [{ type: "text", text: content }];
  if (!Array.isArray(content)) shapeError(path, "a string or an array");
  return content
    .map((block, index) => {
      const itemPath = `${path}[${index}]`;
      if (!isObject(block)) shapeError(itemPath, "an object");
      if (block.type === "text") return textPart(block, itemPath, drop);
      if (block.type === "image") return imagePart(block, itemPath, drop);
      drop(`tool_result.${block.type}`);
      return null;
    })
    .filter(Boolean);
}

const BLOCK_PARSERS = {
  text: textPart,
  image: imagePart,
  tool_use(block, path, drop) {
    if (!isAbsent(block.input) && !isObject(block.input)) {
      shapeError(`${path}.input`, "an object");
    }
    return {
      type: "toolCall",
      id: requireString(block.id, `${path}.id`),
      name: requireString(block.name, `${path}.name`),
      kind: "function",
      input: JSON.stringify(block.input ?? {}),
      ...cacheOf(block, drop),
    };
  },
  tool_result(block, path, drop) {
    return {
      type: "toolResult",
      callId: requireString(block.tool_use_id, `${path}.tool_use_id`),
      parts: toolResultParts(block.content, `${path}.content`, drop),
      isError: block.is_error === true,
      ...cacheOf(block, drop),
    };
  },
  thinking(block, path, drop) {
    const part = {
      type: "reasoning",
      text: requireString(block.thinking, `${path}.thinking`),
    };
    if (!isAbsent(block.signature)) {
      part.carrier = requireString(block.signature, `${path}.signature`);
    }
    return { ...part, ...cacheOf(block, drop) };
  },
  redacted_thinking(block, path, drop) {
    return {
      type: "reasoning",
      redacted: true,
      carrier: requireString(block.data, `${path}.data`),
      ...cacheOf(block, drop),
    };
  },
};

function contentParts(content, path, drop, allowed) {
  if (typeof content === "string")
    return content === "" ? [] : [{ type: "text", text: content }];
  if (!Array.isArray(content)) shapeError(path, "a string or an array");
  return content
    .map((block, index) => {
      const blockPath = `${path}[${index}]`;
      if (!isObject(block)) shapeError(blockPath, "an object");
      if (!allowed.includes(block.type)) {
        drop(`content.${block.type}`);
        return null;
      }
      return BLOCK_PARSERS[block.type](block, blockPath, drop);
    })
    .filter(Boolean);
}

const ALL_BLOCKS = Object.keys(BLOCK_PARSERS);

function parseMessages(messages, drop) {
  if (!Array.isArray(messages)) shapeError("messages", "an array");
  return messages
    .map((message, index) => {
      const path = `messages[${index}]`;
      if (!isObject(message)) shapeError(path, "an object");
      if (!MESSAGE_ROLES.includes(message.role))
        shapeError(`${path}.role`, "user|assistant|system");
      const allowed = message.role === "system" ? ["text"] : ALL_BLOCKS;
      const parts = contentParts(message.content, `${path}.content`, drop, allowed);
      return { role: message.role, parts };
    })
    .filter((message) => message.parts.length > 0);
}

function parseSystem(system, drop) {
  if (isAbsent(system)) return [];
  return contentParts(system, "system", drop, ["text"]);
}

function parseTool(tool, index, drop) {
  const path = `tools[${index}]`;
  if (!isObject(tool)) shapeError(path, "an object");
  const name = requireString(tool.name, `${path}.name`);
  const cache = cacheOf(tool, drop);
  if (!isAbsent(tool.type) && tool.type !== "custom") {
    if (/^web_search_/.test(tool.type)) {
      // `raw` keeps the versioned type and its configuration (max_uses, domains, …).
      return { name, kind: "hosted", hostedType: "web_search", raw: tool, ...cache };
    }
    drop(`tools.${tool.type}`);
    return null;
  }
  for (const key of Object.keys(tool)) if (!TOOL_FIELDS.has(key)) drop(`tools.${key}`);
  const parsed = {
    name,
    kind: "function",
    schema: tool.input_schema ?? { type: "object" },
  };
  if (!isAbsent(tool.description)) {
    parsed.description = requireString(tool.description, `${path}.description`);
  }
  if (typeof tool.strict === "boolean") parsed.strict = tool.strict;
  else if (!isAbsent(tool.strict)) drop("tools.strict");
  return { ...parsed, ...cache };
}

function parseTools(tools, drop) {
  if (isAbsent(tools)) return [];
  if (!Array.isArray(tools)) shapeError("tools", "an array");
  return tools.map((tool, index) => parseTool(tool, index, drop)).filter(Boolean);
}

function parseToolChoice(choice, drop) {
  if (isAbsent(choice)) return { toolChoice: "auto" };
  if (!isObject(choice)) shapeError("tool_choice", "an object");
  const parallel =
    typeof choice.disable_parallel_tool_use === "boolean"
      ? { parallelToolCalls: !choice.disable_parallel_tool_use }
      : {};
  if (choice.type === "auto") return { toolChoice: "auto", ...parallel };
  if (choice.type === "any") return { toolChoice: "required", ...parallel };
  if (choice.type === "none") return { toolChoice: "none", ...parallel };
  if (choice.type === "tool") {
    return {
      toolChoice: { name: requireString(choice.name, "tool_choice.name") },
      ...parallel,
    };
  }
  drop("tool_choice");
  return { toolChoice: "auto", ...parallel };
}

function parseEffort(outputConfig, drop) {
  if (isAbsent(outputConfig?.effort)) return null;
  const { effort, unknown } = normalizeEffortWithInfo(outputConfig.effort);
  if (unknown) drop("output_config.effort");
  return effort;
}

const THINKING_TYPES = {
  enabled(thinking) {
    const budget = thinking.budget_tokens;
    if (!Number.isInteger(budget) || budget < 0) {
      shapeError("thinking.budget_tokens", "a non-negative integer");
    }
    return { mode: "enabled", budgetTokens: budget };
  },
  adaptive: () => ({ mode: "adaptive" }),
  disabled: () => ({ mode: "disabled" }),
  between_tools: () => ({ mode: "between_tools" }),
};

function parseThinking(body, drop) {
  const effort = parseEffort(body.output_config, drop);
  const thinking = body.thinking;
  if (isAbsent(thinking)) {
    // Effort without thinking has no IR place (thinking stays off as the client asked).
    if (effort !== null) drop("output_config.effort.withoutThinking");
    return null;
  }
  if (!isObject(thinking)) shapeError("thinking", "an object");
  if (!Object.hasOwn(THINKING_TYPES, thinking.type)) {
    drop("thinking");
    return null;
  }
  const parsed = THINKING_TYPES[thinking.type](thinking);
  if (effort !== null) parsed.effort = effort;
  if (thinking.display !== undefined) {
    if (THINKING_DISPLAYS.includes(thinking.display)) parsed.display = thinking.display;
    else drop("thinking.display");
  }
  return parsed;
}

function parseOutput(outputConfig, drop) {
  if (isAbsent(outputConfig)) return null;
  if (!isObject(outputConfig)) shapeError("output_config", "an object");
  for (const key of Object.keys(outputConfig)) {
    if (key !== "effort" && key !== "format") drop(`output_config.${key}`);
  }
  const format = outputConfig.format;
  if (isAbsent(format)) return null;
  if (format.type === "json_schema" && isObject(format.schema)) {
    return { format: "json_schema", name: "output", schema: format.schema };
  }
  drop("output_config.format");
  return null;
}

function headerValue(headers, name) {
  if (!isObject(headers)) return undefined;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return entry?.[1];
}

function parseHints(body, headers) {
  const hints = {};
  if (!isAbsent(body.metadata)) hints.metadata = body.metadata;
  if (!isAbsent(body.context_management))
    hints.contextManagement = body.context_management;
  if (!isAbsent(body.service_tier)) hints.serviceTier = body.service_tier;
  const beta = headerValue(headers, "anthropic-beta");
  if (typeof beta === "string" && beta !== "") hints.anthropicBeta = beta;
  return hints;
}

function parseSampling(body) {
  return {
    maxOutputTokens: body.max_tokens ?? null,
    temperature: body.temperature ?? null,
    topP: body.top_p ?? null,
    stop: body.stop_sequences ?? [],
  };
}

/**
 * Parses a Claude Code `POST /v1/messages` body into an IrRequest. Throws a TypeError
 * naming the path for malformed input; unsupported fields are listed in `dropped`.
 */
export function parseMessagesRequest(body, headers = {}) {
  if (!isObject(body)) shapeError("body", "an object");
  const dropped = new Set();
  const drop = (name) => dropped.add(name);
  for (const key of Object.keys(body)) if (!KNOWN_FIELDS.has(key)) drop(key);

  const choice = parseToolChoice(body.tool_choice, drop);
  let parallelToolCalls = choice.parallelToolCalls ?? null;
  if (typeof body.disable_parallel_tool_use === "boolean") {
    parallelToolCalls = !body.disable_parallel_tool_use;
  }
  const ir = {
    model: requireString(body.model, "model"),
    system: parseSystem(body.system, drop),
    messages: parseMessages(body.messages, drop),
    tools: parseTools(body.tools, drop),
    toolChoice: choice.toolChoice,
    parallelToolCalls,
    sampling: parseSampling(body),
    thinking: parseThinking(body, drop),
    output: parseOutput(body.output_config, drop),
    cache: { key: null },
    stream: body.stream === true,
    hints: parseHints(body, headers),
  };
  return { ir: assertIrRequest(ir), dropped: [...dropped] };
}

export {
  AdapterUpstreamError,
  emitMessagesResponse,
  emitMessagesStream,
  emitMessagesStreamError,
  messagesPing,
} from "./client-messages-emit.js";
