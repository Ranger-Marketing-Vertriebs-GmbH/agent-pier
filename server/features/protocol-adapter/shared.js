// Small helpers shared by the upstream builders and parsers. Pure.

export const isObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const present = (value) => value !== undefined && value !== null;
export const nonEmpty = (value) => typeof value === "string" && value !== "";

/** Upstream model id from `ctx.model` (record with `id`, or a string), else the IR's. */
export function upstreamModel(ir, model) {
  if (nonEmpty(model)) return model;
  if (isObject(model) && nonEmpty(model.id)) return model.id;
  return ir.model;
}

/** Model name for a `start` event when the upstream did not report one. */
export function modelName(model) {
  if (nonEmpty(model)) return model;
  return isObject(model) && nonEmpty(model.id) ? model.id : "unknown";
}

/** JSON of one SSE `data` field: `{ ok: true, value }` or `{ ok: false }`. */
export function parseData(data) {
  try {
    return { ok: true, value: JSON.parse(data) };
  } catch {
    return { ok: false };
  }
}

/** Text of the text parts, joined. */
export function textOf(parts, separator) {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join(separator);
}

/** OpenAI image URL for an IR image part: a data URL for base64 data, else its URL. */
export function imageUrl(part) {
  return present(part.data) ? `data:${part.mediaType};base64,${part.data}` : part.url;
}

// --- custom (freeform) tools as function tools (Messages and Chat upstreams) -------------

const CUSTOM_SCHEMA = Object.freeze({
  properties: Object.freeze({ input: Object.freeze({ type: "string" }) }),
  required: Object.freeze(["input"]),
  type: "object",
});
const MAX_GRAMMAR_CHARS = 4000;

/** Fresh JSON schema `{ input: string }` of a custom tool mapped to a function tool. */
export const customToolSchema = () => structuredClone(CUSTOM_SCHEMA);

/** Description note telling the model how to call a custom tool through `input`. */
export function grammarNote(grammar) {
  if (!isObject(grammar) || typeof grammar.definition !== "string") {
    return 'Call this tool with the JSON arguments {"input": "<raw tool input>"}.';
  }
  const definition =
    grammar.definition.length > MAX_GRAMMAR_CHARS
      ? `${grammar.definition.slice(0, MAX_GRAMMAR_CHARS)}\n[grammar truncated]`
      : grammar.definition;
  const syntax = typeof grammar.syntax === "string" ? `${grammar.syntax} ` : "";
  return (
    'Call this tool with the JSON arguments {"input": "<raw tool input>"}; the string ' +
    `"input" carries the raw text that must match this ${syntax}grammar:\n${definition}`
  );
}

/** Custom tool description: the client's description followed by the grammar note. */
export const customToolDescription = (tool) =>
  [tool.description, grammarNote(tool.grammar)].filter(Boolean).join("\n\n");

/** The IR tool a named tool choice (`{ name, namespace? }`) points at, if any. */
export function chosenTool(ir, choice) {
  if (!isObject(choice)) return undefined;
  return ir.tools.find(
    (tool) => tool.name === choice.name && tool.namespace === choice.namespace,
  );
}

// --- OpenAI strict mode --------------------------------------------------------------

// Keywords OpenAI strict mode rejects (structured outputs "supported schemas").
const STRICT_UNSUPPORTED = [
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "patternProperties",
  "dependentRequired",
  "dependentSchemas",
];

function strictCompatible(schema) {
  if (!isObject(schema)) return false;
  if (STRICT_UNSUPPORTED.some((key) => Object.hasOwn(schema, key))) return false;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const properties = schema.properties ?? {};
  if (!isObject(properties)) return false;
  if (types.includes("object") || Object.hasOwn(schema, "properties")) {
    if (schema.additionalProperties !== false) return false;
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (!Object.keys(properties).every((key) => required.includes(key))) return false;
  }
  const children = [...Object.values(properties)];
  if (Object.hasOwn(schema, "items")) children.push(schema.items);
  if (Object.hasOwn(schema, "anyOf")) {
    if (!Array.isArray(schema.anyOf)) return false;
    children.push(...schema.anyOf);
  }
  for (const key of ["$defs", "definitions"]) {
    if (!Object.hasOwn(schema, key)) continue;
    if (!isObject(schema[key])) return false;
    children.push(...Object.values(schema[key]));
  }
  return children.every(strictCompatible);
}

/**
 * True when a tool schema meets OpenAI strict-mode rules recursively: an object root,
 * every object with `additionalProperties: false` and all properties `required`, and no
 * unsupported keywords (`allOf`, `not`, `if`/`then`/`else`, ...). Claude Code's `strict`
 * carries no such guarantee, so a failing schema is sent non-strict instead of 400ing.
 */
export function openAIStrictSchema(schema) {
  return isObject(schema) && schema.type === "object" && strictCompatible(schema);
}

/**
 * The `strict` flag for an OpenAI function tool: true only when the tool asks for it and
 * its schema qualifies; a downgrade is counted as `tools.strictDowngraded`.
 */
export function strictFlag(tool, adjust) {
  if (tool.strict !== true) return false;
  if (openAIStrictSchema(tool.schema)) return true;
  adjust("tools.strictDowngraded");
  return false;
}

// --- request bookkeeping ---------------------------------------------------------------

// Hints the adapter honors itself on every route: `store` (always false upstream) and
// `include` (encrypted reasoning toward Codex, `include` toward Responses upstreams).
const CONSUMED_HINTS = new Set(["store", "include"]);

/** Lists every IR hint the adapter does not consume as `hints.<key>` in `drop`. */
export function dropHints(ir, drop) {
  for (const key of Object.keys(ir.hints ?? {})) {
    if (!CONSUMED_HINTS.has(key)) drop(`hints.${key}`);
  }
}

/**
 * Call id for an upstream tool call that came without one: unique per request (the
 * exchange's `ctx.requestId`, reduced to the id alphabet) and per call (`position`).
 */
export function fallbackCallId(ctx, position) {
  const request = typeof ctx?.requestId === "string" ? ctx.requestId : "";
  const safe = request.replace(/[^a-zA-Z0-9_-]+/g, "_");
  return safe === "" ? `call_${position}` : `call_${safe}_${position}`;
}
