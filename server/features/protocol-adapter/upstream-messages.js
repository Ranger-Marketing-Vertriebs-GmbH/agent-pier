// Anthropic Messages upstream: builds `/v1/messages` request bodies from the IR (Codex is
// the only client that reaches a Messages upstream through the adapter). Stream and
// response parsing live in upstream-messages-parse.js and are re-exported here.

import { decodeCarrier } from "./carrier.js";
import { maxTokensFor, resolveThinkingForMessages } from "./mapping.js";
import { REDACTED_PREFIX } from "./upstream-messages-parse.js";

export { parseMessagesResponse, parseMessagesStream } from "./upstream-messages-parse.js";

const CUSTOM_SCHEMA = Object.freeze({
  properties: { input: { type: "string" } },
  required: ["input"],
  type: "object",
});
const MAX_GRAMMAR_CHARS = 4000;
const MAX_BREAKPOINTS = 4;
const EPHEMERAL = Object.freeze({ type: "ephemeral" });
const MISSING_RESULT = "[no tool result was recorded for this call]";

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

function grammarNote(grammar) {
  if (!isObject(grammar) || typeof grammar.definition !== "string") {
    return 'Call this tool with {"input": "<raw tool input>"}.';
  }
  const definition =
    grammar.definition.length > MAX_GRAMMAR_CHARS
      ? `${grammar.definition.slice(0, MAX_GRAMMAR_CHARS)}\n[grammar truncated]`
      : grammar.definition;
  const syntax = typeof grammar.syntax === "string" ? `${grammar.syntax} ` : "";
  return (
    'Call this tool with {"input": "<raw tool input>"}; the string "input" carries ' +
    `the raw text that must match this ${syntax}grammar:\n${definition}`
  );
}

// --- tools -------------------------------------------------------------------------

function messagesTool(tool, names) {
  const custom = tool.kind === "custom";
  const description = custom
    ? [tool.description, grammarNote(tool.grammar)].filter(Boolean).join("\n\n")
    : tool.description;
  const result = { name: names.toUpstream(tool.name, tool.namespace) };
  if (typeof description === "string" && description !== "") {
    result.description = description;
  }
  const schema = isObject(tool.schema) ? tool.schema : { properties: {} };
  result.input_schema = sortKeys(custom ? CUSTOM_SCHEMA : { ...schema, type: "object" });
  if (tool.cache) result.cache_control = { ...EPHEMERAL };
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
  part.cache ? { ...block, cache_control: { ...EPHEMERAL } } : block;

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
  const body = part.parts
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
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
  if (carrier?.origin !== "messages" || !carrier.payload) return null;
  if (carrier.payload.startsWith(REDACTED_PREFIX)) {
    return {
      type: "redacted_thinking",
      data: carrier.payload.slice(REDACTED_PREFIX.length),
    };
  }
  const text = part.text ?? part.summary ?? "";
  return { type: "thinking", thinking: text, signature: carrier.payload };
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
  return [
    ...(body.tools ?? []),
    ...(body.system ?? []),
    ...body.messages.flatMap((message) => message.content),
  ].filter(isObject);
}

/**
 * Keeps at most four breakpoints (dropping the oldest) and, unless disabled, marks the
 * last system block and the last block of the last user message when room is left.
 */
function applyCache(body, capabilities, drop, adjust) {
  const marked = cacheSlots(body).filter((block) => block.cache_control);
  const excess = marked.length - MAX_BREAKPOINTS;
  for (const block of marked.slice(0, Math.max(0, excess))) {
    delete block.cache_control;
    drop("cache.breakpoints");
  }
  if (capabilities.promptCache === false) return;
  let used = Math.min(marked.length, MAX_BREAKPOINTS);
  const lastUser = body.messages.findLast((message) => message.role === "user");
  const targets = [body.system?.at(-1), lastUser?.content.at(-1)];
  for (const block of targets) {
    if (!isObject(block) || block.cache_control || used >= MAX_BREAKPOINTS) continue;
    if (block.type === "thinking" || block.type === "redacted_thinking") continue;
    block.cache_control = { ...EPHEMERAL };
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

function outputConfig(effort, output) {
  const config = {};
  if (effort) config.effort = effort;
  if (output?.format === "json_schema") {
    config.format = { type: "json_schema", schema: sortKeys(output.schema) };
  }
  return Object.keys(config).length > 0 ? config : undefined;
}

/**
 * Messages request for an IR request. Keys are inserted in a fixed order and tool
 * schemas are key-sorted so identical prefixes serialize identically (prompt caching).
 * IR hints, hosted tools and the cache key are never sent; they are listed in `dropped`
 * together with the thinking adjustments. `adjustments` lists additions such as the
 * automatic cache breakpoints.
 */
export function buildMessagesRequest(ir, ctx) {
  const capabilities = ctx.capabilities ?? {};
  const dropped = [];
  const adjustments = [];
  const drop = (name) => dropped.push(name);
  for (const key of Object.keys(ir.hints ?? {})) drop(`hints.${key}`);
  if (typeof ir.cache?.key === "string" && ir.cache.key !== "") drop("cache.key");

  const sampling = ir.sampling ?? {};
  const maxTokens = maxTokensFor({ sampling, model: ctx.model });
  const resolved = resolveThinkingForMessages({
    thinking: messagesThinking(ir.thinking, capabilities),
    maxTokens,
    temperature: sampling.temperature,
    topP: sampling.topP,
    topK: sampling.topK,
    toolChoice: ir.toolChoice,
  });
  dropped.push(...resolved.adjustments);

  const { system, messages } = buildConversation(ir, ctx, drop);
  const body = { model: upstreamModel(ir, ctx.model), max_tokens: maxTokens };
  if (system.length > 0) body.system = system;
  body.messages = messages;
  const tools = buildTools(ir, ctx.names, drop);
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = toolChoice(resolved.toolChoice, ctx.names, ir.parallelToolCalls);
  }
  if (resolved.thinking) body.thinking = resolved.thinking;
  const config = outputConfig(resolved.thinking ? resolved.effort : undefined, ir.output);
  if (config) body.output_config = config;
  if (Array.isArray(sampling.stop) && sampling.stop.length > 0) {
    body.stop_sequences = [...sampling.stop];
  }
  body.stream = ir.stream === true;
  applyCache(body, capabilities, drop, (name) => adjustments.push(name));
  return {
    path: "/v1/messages",
    body,
    headers: { "anthropic-version": "2023-06-01" },
    dropped: [...new Set(dropped)],
    adjustments: [...new Set(adjustments)],
  };
}
