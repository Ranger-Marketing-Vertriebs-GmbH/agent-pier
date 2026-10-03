// Reads the literal `meta` object of a Claude Workflow script as text. The
// script is never evaluated: only top-level string properties of the object
// right after `meta =` count, and the scan ends with that object.
const scriptLimit = 65536;
const objectLimit = 16384;
const escapes = { n: " ", r: "", t: " ", b: "", f: "", v: "", 0: "" };

function readString(source, start, end) {
  const quote = source[start];
  let value = "";
  for (let i = start + 1; i < end; i++) {
    const char = source[i];
    if (char === quote) return { value, next: i + 1 };
    if (char === "\n" && quote !== "`") return null;
    // Interpolation makes the value dynamic: not a literal summary.
    if (quote === "`" && char === "$" && source[i + 1] === "{") return null;
    if (char !== "\\") {
      value += char;
      continue;
    }
    const escaped = source[++i];
    if (escaped === undefined) return null;
    if (escaped === "u") {
      const hex = /^\{([0-9a-fA-F]{1,6})\}|^([0-9a-fA-F]{4})/.exec(source.slice(i + 1));
      if (!hex) return null;
      const code = parseInt(hex[1] ?? hex[2], 16);
      value += code <= 0x10ffff ? String.fromCodePoint(code) : "";
      i += hex[0].length;
    } else if (escaped === "\n") {
      // Line continuation.
    } else value += escapes[escaped] ?? escaped;
  }
  return null;
}

export function workflowMeta(script) {
  if (typeof script !== "string") return undefined;
  const source = script.slice(0, scriptLimit);
  const match = /\bmeta\s*=\s*\{/.exec(source);
  if (!match) return undefined;
  const end = Math.min(source.length, match.index + match[0].length + objectLimit);
  const result = {};
  let depth = 1,
    key = null,
    i = match.index + match[0].length;
  while (i < end && depth > 0) {
    const char = source[i];
    if (char === '"' || char === "'" || char === "`") {
      const string = readString(source, i, end);
      if (!string) break;
      // A quoted property name is a key, a quoted value after `key:` a value.
      const after = source.slice(string.next, string.next + 200).match(/^\s*:/);
      if (depth === 1 && !key && after) {
        key = string.value;
        i = string.next + after[0].length;
        continue;
      }
      if (depth === 1 && key && !(key in result)) result[key] = string.value;
      key = null;
      i = string.next;
      continue;
    }
    if (char === "/" && source[i + 1] === "/") {
      const next = source.indexOf("\n", i);
      i = next < 0 ? end : next;
      continue;
    }
    if (char === "/" && source[i + 1] === "*") {
      const next = source.indexOf("*/", i + 2);
      i = next < 0 ? end : next + 2;
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      const word = /^[A-Za-z_$][\w$]*/.exec(source.slice(i, i + 200))[0];
      const after = source.slice(i + word.length, i + word.length + 200).match(/^\s*:/);
      if (depth === 1 && !key && after) {
        key = word;
        i += word.length + after[0].length;
        continue;
      }
      // An identifier value (variable, call, …) is not a literal.
      key = null;
      i += word.length;
      continue;
    }
    if ("{[(".includes(char)) {
      depth++;
      key = null;
    } else if ("}])".includes(char)) depth--;
    else if (char === ",") key = null;
    i++;
  }
  return result;
}
