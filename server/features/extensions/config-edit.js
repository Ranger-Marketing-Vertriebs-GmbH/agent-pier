import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import {
  createScanner,
  findNodeAtLocation,
  parse as parseJsonc,
  parseTree,
} from "jsonc-parser";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { parseForESLint } from "toml-eslint-parser";

export const CLI_CONFIG_LAYOUT = "CLI_CONFIG_LAYOUT";

const layout = () =>
  Object.assign(problem(serverMessages.extensions.cliConfigLayout, 409), {
    code: CLI_CONFIG_LAYOUT,
  });

// jsonc-parser's SyntaxKind is a TypeScript const enum, absent at runtime.
const COMMA = 5;
const TRIVIA = new Set([12, 13, 14, 15]); // line comment, block comment, line break, blanks

const lineStart = (text, at) => text.lastIndexOf("\n", at - 1) + 1;
const blank = (value) => /^[ \t]*$/.test(value);
const indentOf = (text, at) => /^[ \t]*/.exec(text.slice(lineStart(text, at)))[0];

/** `[start, end]` widened to whole lines when only blanks (or `trailing`) share them. */
function wholeLines(text, start, end, trailing = /^[ \t]*$/) {
  const from = lineStart(text, start);
  let eol = text.indexOf("\n", end);
  if (eol < 0) eol = text.length;
  if (!blank(text.slice(from, start)) || !trailing.test(text.slice(end, eol)))
    return [start, end];
  return [from, Math.min(eol + 1, text.length)];
}

/**
 * Applies non-overlapping `[start, end, content]` replacements; insertions at one
 * offset keep their listed order.
 */
function splice(text, spans) {
  let out = text;
  const order = spans.map(([start, end, content = ""], index) => [
    start,
    end,
    content,
    index,
  ]);
  order.sort((a, b) => b[0] - a[0] || b[3] - a[3]);
  for (const [start, end, content] of order)
    out = out.slice(0, start) + content + out.slice(end);
  return out;
}

// ---- JSON and JSONC: only the member's own span and one separating comma change.

const pretty = (value, indent) =>
  JSON.stringify(value, null, 2).replace(/\n/g, `\n${indent}`);

/** Offset of the comma that is the next token after `offset`, or -1. */
function commaAfter(text, offset) {
  const scanner = createScanner(text, false);
  scanner.setPosition(offset);
  let kind = scanner.scan();
  while (TRIVIA.has(kind)) kind = scanner.scan();
  return kind === COMMA ? scanner.getTokenOffset() : -1;
}

/** Blanks (spaces, tabs) directly before `offset` on its line. */
const blanksBefore = (text, offset) => /[ \t]*$/.exec(text.slice(0, offset))[0].length;
/** Whether `member` starts its own line, else it shares one with other JSON. */
const ownLine = (text, member) =>
  blank(text.slice(lineStart(text, member.offset), member.offset));
const interior = (object) => [object.offset + 1, object.offset + object.length - 1];

function removeMember(text, object, member) {
  const end = member.offset + member.length;
  const [open, close] = interior(object);
  // The only member, among nothing but blanks: the object returns to `{}`.
  if (
    object.children.length === 1 &&
    /^\s*$/.test(text.slice(open, member.offset) + text.slice(end, close))
  )
    return splice(text, [[open, close]]);
  const after = commaAfter(text, end);
  if (after >= 0) {
    if (!blank(text.slice(end, after)))
      return splice(text, [wholeLines(text, member.offset, end), [after, after + 1]]);
    const [from, to] = wholeLines(text, member.offset, after + 1);
    return splice(text, [
      [from === member.offset ? from - blanksBefore(text, from) : from, to],
    ]);
  }
  const index = object.children.indexOf(member);
  const previous = object.children[index - 1];
  const comma = previous ? commaAfter(text, previous.offset + previous.length) : -1;
  if (comma >= 0 && blank(text.slice(comma + 1, member.offset)))
    return splice(text, [[comma, end]]);
  const spans = [wholeLines(text, member.offset, end)];
  if (comma >= 0) spans.push([comma, comma + 1]);
  return splice(text, spans);
}

function insertMember(text, object, name, value) {
  const [open, close] = interior(object);
  const last = object.children?.at(-1);
  const key = JSON.stringify(name);
  if (!last && /^\s*$/.test(text.slice(open, close))) {
    const outer = indentOf(text, object.offset);
    return splice(text, [
      [open, close, `\n${outer}  ${key}: ${pretty(value, `${outer}  `)}\n${outer}`],
    ]);
  }
  const lastEnd = last ? last.offset + last.length : open;
  const trailing = last ? commaAfter(text, lastEnd) : -1;
  // A trailing-comma style keeps its comma after the new member, so removing it
  // later restores the file exactly.
  const comma = trailing >= 0 ? "," : "";
  const closeLine = lineStart(text, close);
  if (blank(text.slice(closeLine, close)) && closeLine > Math.max(lastEnd, trailing)) {
    const indent = last
      ? indentOf(text, last.offset)
      : `${indentOf(text, object.offset)}  `;
    const member = `${indent}${key}: ${pretty(value, indent)}${comma}\n`;
    return splice(text, [
      ...(last && trailing < 0 ? [[lastEnd, lastEnd, ","]] : []),
      [closeLine, closeLine, member],
    ]);
  }
  // An object on one line takes a compact member on that line.
  const member = `${key}: ${JSON.stringify(value)}`;
  if (!last) return splice(text, [[close, close, member]]);
  if (trailing >= 0) return splice(text, [[trailing + 1, trailing + 1, ` ${member},`]]);
  return splice(text, [[lastEnd, lastEnd, `, ${member}`]]);
}

function editJson(text, key, name, entry) {
  if (!text.trim())
    return entry === undefined
      ? text
      : `${JSON.stringify({ [key]: { [name]: entry } }, null, 2)}\n`;
  const root = parseTree(text);
  if (root?.type !== "object") throw layout();
  const container = findNodeAtLocation(root, [key]);
  if (container && container.type !== "object") throw layout();
  const member = container?.children.find((item) => item.children[0].value === name);
  if (entry === undefined) return member ? removeMember(text, container, member) : text;
  if (member) {
    const value = member.children[1];
    const content = ownLine(text, member)
      ? pretty(entry, indentOf(text, member.offset))
      : JSON.stringify(entry);
    return splice(text, [[value.offset, value.offset + value.length, content]]);
  }
  if (container) return insertMember(text, container, name, entry);
  return insertMember(text, root, key, { [name]: entry });
}

// ---- TOML: only the entry's own tables and key/values change.

const keyPath = (key) => key.keys.map((part) => part.name ?? part.value);
const append = (text, block) =>
  text.trim() ? `${text.endsWith("\n") ? text : `${text}\n`}\n${block}` : block;

/** Line spans of every node that defines `key.name`; `tables` whether all are headers. */
function tomlSpans(text, key, name) {
  const top = parseForESLint(text).ast.body[0];
  const nodes = [];
  let tables = true;
  const mine = (path) => path[0] === key && path[1] === name;
  for (const node of top.body) {
    if (node.type === "TOMLKeyValue") {
      const path = keyPath(node.key);
      // `mcp_servers = { … }` cannot take a `[mcp_servers.name]` table beside it.
      if (path[0] === key && path.length < 2) throw layout();
      if (mine(path)) {
        nodes.push(node);
        tables = false;
      }
      continue;
    }
    const path = node.resolvedKey;
    if (path[0] !== key) continue;
    if (path.length < 2 && node.kind === "array") throw layout();
    if (mine(path)) nodes.push(node);
    else if (path.length === 1)
      for (const value of node.body)
        if (keyPath(value.key)[0] === name) {
          nodes.push(value);
          tables = false;
        }
  }
  const spans = nodes
    .map((node) => wholeLines(text, node.range[0], node.range[1], /^[ \t]*(#.*)?$/))
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const span of spans) {
    const previous = merged.at(-1);
    if (previous && /^\s*$/.test(text.slice(previous[1], span[0]))) previous[1] = span[1];
    else merged.push([...span]);
  }
  return { merged, tables };
}

function editToml(text, key, name, entry) {
  const { merged, tables } = tomlSpans(text, key, name);
  const block = entry === undefined ? "" : stringifyToml({ [key]: { [name]: entry } });
  if (block && merged.length === 1 && tables && merged[0][1] > merged[0][0])
    return splice(text, [[merged[0][0], merged[0][1], block]]);
  // A removed block that sat between blank lines leaves one blank line, not two.
  const removed = splice(
    text,
    merged.map(([start, end]) => [
      start > 1 &&
      text.slice(start - 2, start) === "\n\n" &&
      (end === text.length || text[end] === "\n")
        ? start - 1
        : start,
      end,
    ]),
  );
  return block ? append(removed, block) : removed;
}

// ---- Verification: the edit must change exactly the one entry.

function canonical(value) {
  if (typeof value?.toJSON === "function") return JSON.stringify(value.toJSON());
  if (typeof value === "bigint") return `${value}n`;
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .filter((item) => value[item] !== undefined)
      .sort()
      .map((item) => `${JSON.stringify(item)}:${canonical(value[item])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}

function parsed(text, tool) {
  if (!text.trim()) return {};
  if (tool === "codex") return parseToml(text);
  const errors = [];
  const data = parseJsonc(text, errors, {
    allowTrailingComma: tool === "opencode",
    disallowComments: tool === "claude",
  });
  if (errors.length) throw new Error("invalid JSON after edit");
  return data;
}

/**
 * `config.text` with only `config.data[key][name]` set to `entry` (or removed when
 * undefined). Every other byte stays: comments, order and number or date formatting.
 * Throws CLI_CONFIG_LAYOUT when the entry cannot be edited in place without
 * changing anything else; the caller then writes nothing.
 */
export function editConfig(config, tool, key, name, entry) {
  let after;
  let actual;
  try {
    after =
      tool === "codex"
        ? editToml(config.text, key, name, entry)
        : editJson(config.text, key, name, entry);
    actual = parsed(after, tool);
  } catch (error) {
    if (error?.code === CLI_CONFIG_LAYOUT) throw error;
    throw layout();
  }
  const expected = { ...config.data, [key]: { ...(config.data[key] || {}) } };
  if (entry === undefined) delete expected[key][name];
  else expected[key][name] = entry;
  // TOML has no empty implicit table: removing its last entry removes `key` too.
  if (actual[key] === undefined && !Object.keys(expected[key]).length)
    delete expected[key];
  if (canonical(actual) !== canonical(expected)) throw layout();
  return after;
}
