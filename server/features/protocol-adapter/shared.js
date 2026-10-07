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

// --- request bookkeeping ---------------------------------------------------------------

/** Lists every IR hint as `hints.<key>` in `drop`; no upstream sends hints. */
export function dropHints(ir, drop) {
  for (const key of Object.keys(ir.hints ?? {})) drop(`hints.${key}`);
}
