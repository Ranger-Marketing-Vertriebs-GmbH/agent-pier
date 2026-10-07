// Anthropic Messages upstream: builds `/v1/messages` request bodies from the IR (Codex is
// the only client that reaches a Messages upstream through the adapter). Stream and
// response parsing live in upstream-messages-parse.js and are re-exported here.

import { decodeCarrier } from "./carrier.js";
import { maxTokensFor, resolveThinkingForMessages } from "./mapping.js";
import {
  chosenTool,
  customToolDescription,
  customToolSchema,
  dropHints,
  isObject,
  present,
  textOf,
  upstreamModel,
} from "./shared.js";
import { thinkingBlockFromPayload } from "./upstream-messages-parse.js";

export { parseMessagesResponse, parseMessagesStream } from "./upstream-messages-parse.js";

const MAX_BREAKPOINTS = 4;
const EPHEMERAL = Object.freeze({ type: "ephemeral" });
// Sampling values removed for Messages upstreams are feature drops; the other
// thinking resolutions (effort, budget, tool choice) are adjustments.
const SAMPLING_DROPS = new Set(["temperatureDropped", "topPDropped", "topKDropped"]);
const MISSING_RESULT = "[no tool result was recorded for this call]";

/** `cache_control` for a marked IR part or tool; the client's TTL is kept. */
function cacheControl(part) {
  return part.cacheTtl ? { ...EPHEMERAL, ttl: part.cacheTtl } : { ...EPHEMERAL };
}

// --- tools -------------------------------------------------------------------------

function messagesTool(tool, names) {
  const custom = tool.kind === "custom";
  const description = custom ? customToolDescription(tool) : tool.description;
  const result = { name: names.toUpstream(tool.name, tool.namespace) };
  if (typeof description === "string" && description !== "") {
    result.description = description;
  }
  // Schemas pass through in client order (property order is meaningful to the model and
  // already stable per client); only `type: "object"` is enforced.
  const schema = isObject(tool.schema) ? tool.schema : { properties: {} };
  result.input_schema = custom ? customToolSchema() : { ...schema, type: "object" };
  if (tool.cache) result.cache_control = cacheControl(tool);
  return result;
}

function buildTools(ir, names, drop) {
  const tools = [];
  for (const tool of ir.tools) {
    if (tool.kind === "hosted") drop(`tools.${tool.hostedType ?? tool.name}`);
    else tools.push(messagesTool(tool, names));
  }
  return tools;
}

function toolChoice(choice, names, parallel) {
  let result;
  if (isObject(choice)) {
    result = { type: "tool", name: names.toUpstream(choice.name, choice.namespace) };
  } else if (choice === "required") result = { type: "any" };
  else if (choice === "none") result = { type: "none" };
  else result = { type: "auto" };
  if (parallel === false && result.type !== "none") {
    result.disable_parallel_tool_use = true;
  }
  return result;
}

// --- content blocks ----------------------------------------------------------------

const withCache = (block, part) =>
  part.cache ? { ...block, cache_control: cacheControl(part) } : block;

function imageBlock(part) {
  const source = present(part.data)
    ? { type: "base64", media_type: part.mediaType, data: part.data }
    : { type: "url", url: part.url };
  return withCache({ type: "image", source }, part);
}

/** Text or image block; empty text yields null (Anthropic rejects empty text blocks). */
function contentBlock(part) {
  if (part.type === "image") return imageBlock(part);
  if (part.text === "") return null;
  return withCache({ type: "text", text: part.text }, part);
}

const contentBlocks = (parts) => parts.map(contentBlock).filter(Boolean);

function toolResultBlock(part, ids) {
  const block = { type: "tool_result", tool_use_id: ids.toUpstream(part.callId) };
  const content = contentBlocks(part.parts);
  if (content.length > 0) block.content = content;
  if (part.isError) block.is_error = true;
  return withCache(block, part);
}

function orphanResultText(part) {
  const body = textOf(part.parts, "\n");
  const label = part.isError ? "Tool error" : "Tool result";
  return { type: "text", text: `[${label} for call ${part.callId}]\n${body}` };
}

function toolInput(part, drop) {
  if (part.kind === "custom") return { input: part.input };
  if (part.input.trim() === "") return {};
  try {
    const parsed = JSON.parse(part.input);
    if (isObject(parsed)) return parsed;
  } catch {
    // fall through
  }
  drop("assistant.toolCall.invalidInput");
  return {};
}

/** Signed thinking from a Messages upstream; null for every other reasoning part. */
function thinkingBlock(part) {
  const carrier = decodeCarrier(part.carrier);
  if (carrier?.origin !== "messages") return null;
  // The carrier holds the exact upstream text; the IR text/summary may be edited.
  return thinkingBlockFromPayload(carrier.payload);
}

/**
 * Assistant content in IR order. Replayed thinking keeps its position: it came from a
 * Messages upstream in that order, and Anthropic requires the blocks unmodified.
 */
function assistantBlocks(entry, ctx, drop) {
  const blocks = [];
  for (const part of entry.parts) {
    if (part.type === "text") {
      if (part.text === "") continue;
      const last = blocks.at(-1);
      if (last?.type === "text" && !last.cache_control && !part.cache)
        last.text += part.text;
      else blocks.push(contentBlock(part));
    } else if (part.type === "toolCall") {
      blocks.push({
        type: "tool_use",
        id: ctx.ids.toUpstream(part.id),
        name: ctx.names.toUpstream(part.name, part.namespace),
        input: toolInput(part, drop),
      });
    } else if (part.type === "reasoning") {
      const block = thinkingBlock(part);
      if (block) blocks.push(block);
      else drop("assistant.reasoning");
    } else drop(`assistant.${part.type}`);
  }
  return blocks;
}

// --- messages ----------------------------------------------------------------------

function systemTextBlocks(parts, drop) {
  if (parts.some((part) => part.type !== "text")) drop("system.image");
  return parts.filter((part) => part.type === "text" && part.text !== "");
}

const systemTag = (parts) => ({
  type: "text",
  text: `<system>\n${parts.map((part) => part.text).join("\n\n")}\n</system>`,
});

/**
 * Builds alternating user/assistant turns. A user turn is `{ results, content }` until it
 * is finished, so tool results always lead the turn that follows the tool uses.
 */
function createTurns(ctx, drop) {
  const turns = [];
  let pendingSystem = [];

  const userTurn = () => {
    const last = turns.at(-1);
    if (last?.role === "user") return last;
    const turn = { role: "user", results: [], content: [] };
    turns.push(turn);
    return turn;
  };

  const expectedIds = () => {
    const previous = turns.at(-1)?.role === "user" ? turns.at(-2) : turns.at(-1);
    if (previous?.role !== "assistant") return new Set();
    return new Set(
      previous.content.filter((block) => block.type === "tool_use").map((b) => b.id),
    );
  };

  const flushSystem = (turn) => {
    if (pendingSystem.length === 0) return;
    turn.content.push(systemTag(pendingSystem));
    pendingSystem = [];
  };

  return {
    system(parts) {
      pendingSystem.push(...parts);
    },
    user(entry) {
      const expected = expectedIds();
      const results = [];
      const content = [];
      for (const part of entry.parts) {
        if (part.type === "toolResult") {
          const block = toolResultBlock(part, ctx.ids);
          if (expected.has(block.tool_use_id)) results.push(block);
          else {
            drop("user.toolResult.orphan");
            content.push(orphanResultText(part));
          }
        } else if (part.type === "text" || part.type === "image") {
          const block = contentBlock(part);
          if (block) content.push(block);
        } else drop(`user.${part.type}`);
      }
      if (results.length === 0 && content.length === 0 && pendingSystem.length === 0) {
        return;
      }
      const turn = userTurn();
      turn.results.push(...results);
      flushSystem(turn);
      turn.content.push(...content);
    },
    assistant(entry) {
      const blocks = assistantBlocks(entry, ctx, drop);
      if (blocks.length === 0) return;
      if (pendingSystem.length > 0) flushSystem(userTurn());
      const last = turns.at(-1);
      if (last?.role === "assistant") last.content.push(...blocks);
      else turns.push({ role: "assistant", content: blocks });
    },
    finish() {
      if (pendingSystem.length > 0) flushSystem(userTurn());
      return turns.map((turn, index) => {
        if (turn.role === "assistant") return turn;
        const results = [...turn.results];
        const previous = turns[index - 1];
        const answered = new Set(results.map((block) => block.tool_use_id));
        for (const block of previous?.content ?? []) {
          if (block.type === "tool_use" && !answered.has(block.id)) {
            drop("assistant.toolCall.missingResult");
            results.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: MISSING_RESULT,
              is_error: true,
            });
          }
        }
        return { role: "user", content: [...results, ...turn.content] };
      });
    },
  };
}

/** Assistant tool uses at the very end get a following user turn with error results. */
function closeTrailingToolUses(messages, drop) {
  const last = messages.at(-1);
  if (last?.role !== "assistant") return messages;
  const uses = last.content.filter((block) => block.type === "tool_use");
  if (uses.length === 0) return messages;
  for (let i = 0; i < uses.length; i += 1) drop("assistant.toolCall.missingResult");
  return [
    ...messages,
    {
      role: "user",
      content: uses.map((use) => ({
        type: "tool_result",
        tool_use_id: use.id,
        content: MISSING_RESULT,
        is_error: true,
      })),
    },
  ];
}

/**
 * System blocks and messages. System messages before any other message join `system`;
 * later ones become a `<system>…</system>` text block in the next user turn (after its
 * tool results), because Messages only accepts `role: "system"` inside `messages` behind
 * a beta (facts §2.7) and strict alternation forbids a standalone turn.
 */
function buildConversation(ir, ctx, drop) {
  const system = systemTextBlocks(ir.system, drop);
  const turns = createTurns(ctx, drop);
  let leading = true;
  for (const entry of ir.messages) {
    if (entry.role === "system") {
      const parts = systemTextBlocks(entry.parts, drop);
      if (leading) system.push(...parts);
      else turns.system(parts);
      continue;
    }
    leading = false;
    if (entry.role === "user") turns.user(entry);
    else turns.assistant(entry);
  }
  const messages = closeTrailingToolUses(turns.finish(), drop);
  return {
    system: system.map((part) => withCache({ type: "text", text: part.text }, part)),
    messages,
  };
}

// --- caching -----------------------------------------------------------------------

/** Every block that may carry `cache_control`, in Anthropic's prefix order. */
function cacheSlots(body) {
  // Blocks nested in a tool_result precede the result's own mark in the prefix.
  const nested = (block) =>
    block?.type === "tool_result" && Array.isArray(block.content)
      ? [...block.content, block]
      : [block];
  return [
    ...(body.tools ?? []),
    ...(body.system ?? []),
    ...body.messages.flatMap((message) => message.content.flatMap(nested)),
  ].filter(isObject);
}

/**
 * Keeps at most four breakpoints (dropping the oldest) and, unless disabled, marks the
 * last system block and the last block of the last user message when room is left. An
 * auto mark is "1h" when a later client mark is, else the default 5m (TTL ordering).
 */
function applyCache(body, capabilities, adjust) {
  const marked = cacheSlots(body).filter((block) => block.cache_control);
  const excess = marked.length - MAX_BREAKPOINTS;
  for (const block of marked.slice(0, Math.max(0, excess))) {
    delete block.cache_control;
    adjust("cache.breakpoints");
  }
  if (capabilities.promptCache === false) return;
  let used = Math.min(marked.length, MAX_BREAKPOINTS);
  const lastUser = body.messages.findLast((message) => message.role === "user");
  const targets = [body.system?.at(-1), lastUser?.content.at(-1)];
  const slots = cacheSlots(body);
  for (const block of targets) {
    if (!isObject(block) || block.cache_control || used >= MAX_BREAKPOINTS) continue;
    if (block.type === "thinking" || block.type === "redacted_thinking") continue;
    // Anthropic requires longer TTLs before shorter ones: an auto mark followed by a
    // client "1h" mark takes "1h" itself.
    const later = slots.slice(slots.indexOf(block) + 1);
    const longest = later.some((slot) => slot.cache_control?.ttl === "1h");
    block.cache_control = longest ? { ...EPHEMERAL, ttl: "1h" } : { ...EPHEMERAL };
    used += 1;
    adjust("cache.autoBreakpoints");
  }
}

// --- settings ----------------------------------------------------------------------

/**
 * Codex sends effort only (`mode: "enabled"` without a budget). Current Claude models
 * reject manual thinking, so effort-only requests become adaptive thinking with
 * `output_config.effort`; `capabilities.thinkingBudget` opts into the budget table for
 * models that only support `enabled`. Codex `summary: "auto"` asks for summarized text.
 */
function messagesThinking(thinking, capabilities) {
  if (!thinking) return thinking;
  const effortOnly =
    thinking.mode === "enabled" &&
    !present(thinking.budgetTokens) &&
    capabilities.thinkingBudget !== true;
  const result = effortOnly ? { ...thinking, mode: "adaptive" } : { ...thinking };
  if (result.mode === "adaptive" && !present(result.display)) {
    if (thinking.summary === "auto") result.display = "summarized";
    else if (thinking.summary === "none") result.display = "omitted";
  }
  if (result.mode === "enabled") delete result.display;
  return result;
}

// Keywords whose value is one subschema, a list of subschemas, or a map of subschemas.
const SUBSCHEMA = [
  "items",
  "additionalProperties",
  "not",
  "if",
  "then",
  "else",
  "contains",
];
const SUBSCHEMA_LISTS = ["anyOf", "oneOf", "allOf", "prefixItems", "items"];
const SUBSCHEMA_MAPS = [
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
];

const isObjectSchema = (schema) =>
  schema.type === "object" ||
  (Array.isArray(schema.type) && schema.type.includes("object")) ||
  isObject(schema.properties);

/**
 * Copy of a JSON schema in which every object schema without `additionalProperties`
 * gets `additionalProperties: false` (appended, so key order is kept): Anthropic
 * structured outputs require closed objects. Calls `adjust` once when a schema changed.
 */
function closedSchema(schema, adjust) {
  let changed = false;
  const visit = (node) => {
    if (Array.isArray(node)) return node.map(visit);
    if (!isObject(node)) return node;
    const copy = { ...node };
    for (const key of SUBSCHEMA) {
      if (isObject(copy[key])) copy[key] = visit(copy[key]);
    }
    for (const key of SUBSCHEMA_LISTS) {
      if (Array.isArray(copy[key])) copy[key] = copy[key].map(visit);
    }
    for (const key of SUBSCHEMA_MAPS) {
      if (!isObject(copy[key])) continue;
      copy[key] = Object.fromEntries(
        Object.entries(copy[key]).map(([name, value]) => [name, visit(value)]),
      );
    }
    if (isObjectSchema(copy) && copy.additionalProperties === undefined) {
      copy.additionalProperties = false;
      changed = true;
    }
    return copy;
  };
  const result = visit(schema);
  if (changed) adjust("output.additionalPropertiesClosed");
  return result;
}

function outputConfig(effort, output, adjust) {
  const config = {};
  if (effort) config.effort = effort;
  if (output?.format === "json_schema") {
    config.format = { type: "json_schema", schema: closedSchema(output.schema, adjust) };
  }
  return Object.keys(config).length > 0 ? config : undefined;
}

/**
 * True when the request continues a tool loop (last user turn starts with tool results)
 * whose assistant turn does not start with a thinking block. Manual (`enabled`) thinking
 * is rejected by Anthropic in that case; adaptive thinking degrades on its own.
 */
function toolLoopWithoutThinking(messages) {
  const [assistant, user] = messages.slice(-2);
  if (assistant?.role !== "assistant" || user?.content[0]?.type !== "tool_result") {
    return false;
  }
  const first = assistant.content[0]?.type;
  return first !== "thinking" && first !== "redacted_thinking";
}

function resolveThinking(ir, ctx, maxTokens, messages) {
  const sampling = ir.sampling ?? {};
  const options = {
    thinking: messagesThinking(ir.thinking, ctx.capabilities ?? {}),
    maxTokens,
    temperature: sampling.temperature,
    topP: sampling.topP,
    topK: sampling.topK,
    toolChoice: ir.toolChoice,
  };
  const resolved = resolveThinkingForMessages(options);
  if (resolved.thinking?.type !== "enabled" || !toolLoopWithoutThinking(messages)) {
    return resolved;
  }
  const omitted = resolveThinkingForMessages({ ...options, thinking: null });
  omitted.adjustments.push("thinking.omittedNoLeadingBlock");
  return omitted;
}

/**
 * Messages request for an IR request. Keys are inserted in a fixed order and schemas
 * pass through in client order, so identical prefixes serialize identically (prompt
 * caching). IR hints, hosted tools and the cache key are never sent; they are listed in
 * `dropped` together with removed sampling values. `adjustments` lists changes such as
 * thinking/effort resolutions, removed excess and added automatic cache breakpoints and
 * a clamped `max_tokens`. Throws a TypeError when no message is left to send.
 */
export function buildMessagesRequest(ir, ctx) {
  const capabilities = ctx.capabilities ?? {};
  const dropped = [];
  const adjustments = [];
  const drop = (name) => dropped.push(name);
  dropHints(ir, drop);
  if (typeof ir.cache?.key === "string" && ir.cache.key !== "") drop("cache.key");

  const sampling = ir.sampling ?? {};
  const maxTokens = maxTokensFor({ sampling, model: ctx.model }, (name) =>
    adjustments.push(name),
  );
  const { system, messages } = buildConversation(ir, ctx, drop);
  if (messages.length === 0) {
    throw new TypeError("request.messages: no message is left for the Messages upstream");
  }
  const resolved = resolveThinking(ir, ctx, maxTokens, messages);
  for (const name of resolved.adjustments) {
    (SAMPLING_DROPS.has(name) ? dropped : adjustments).push(name);
  }

  const body = { model: upstreamModel(ir, ctx.model), max_tokens: maxTokens };
  if (system.length > 0) body.system = system;
  body.messages = messages;
  const tools = buildTools(ir, ctx.names, drop);
  if (tools.length > 0) {
    body.tools = tools;
    let choice = resolved.toolChoice;
    // Hosted tools are dropped here, so a choice naming one would name a missing tool.
    if (chosenTool(ir, choice)?.kind === "hosted") {
      choice = "auto";
      adjustments.push("toolChoice.hostedToolDropped");
    }
    body.tool_choice = toolChoice(choice, ctx.names, ir.parallelToolCalls);
  }
  if (resolved.thinking) body.thinking = resolved.thinking;
  const config = outputConfig(
    resolved.thinking ? resolved.effort : undefined,
    ir.output,
    (name) => adjustments.push(name),
  );
  if (config) body.output_config = config;
  if (Array.isArray(sampling.stop) && sampling.stop.length > 0) {
    body.stop_sequences = [...sampling.stop];
  }
  body.stream = ir.stream === true;
  applyCache(body, capabilities, (name) => adjustments.push(name));
  return {
    path: "/v1/messages",
    body,
    headers: { "anthropic-version": "2023-06-01" },
    dropped: [...new Set(dropped)],
    adjustments: [...new Set(adjustments)],
  };
}
