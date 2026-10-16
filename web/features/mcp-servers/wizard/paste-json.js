// A JSON reader for pasted setup blocks. It accepts exactly JSON plus what VS Code
// allows (// and /* */ comments, trailing commas) and nothing else. Objects are
// null-prototype maps without __proto__, constructor or prototype keys; nesting is
// capped. Nothing is evaluated.
export const maxDepth = 16;
const dropped = new Set(["__proto__", "constructor", "prototype"]);
const escapes = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};
const numberPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;

function position(text, index) {
  let line = 1;
  let column = 1;
  for (let at = 0; at < index && at < text.length; at += 1)
    if (text[at] === "\n") {
      line += 1;
      column = 1;
    } else column += 1;
  return { line, column };
}

export class PasteJsonError extends Error {
  constructor(code, index, text) {
    super(code);
    this.code = code;
    Object.assign(this, position(text, index));
  }
}

export function parseRelaxedJson(text) {
  let at = 0;
  const duplicates = [];
  const fail = (code = "invalidJson") => {
    throw new PasteJsonError(code, at, text);
  };
  const skip = () => {
    for (;;) {
      const char = text[at];
      if (
        char === " " ||
        char === "\t" ||
        char === "\n" ||
        char === "\r" ||
        char === "\uFEFF"
      ) {
        at += 1;
      } else if (char === "/" && text[at + 1] === "/") {
        const end = text.indexOf("\n", at);
        at = end === -1 ? text.length : end;
      } else if (char === "/" && text[at + 1] === "*") {
        const end = text.indexOf("*/", at + 2);
        if (end === -1) fail();
        at = end + 2;
      } else return;
    }
  };
  const string = () => {
    let out = "";
    at += 1;
    for (;;) {
      if (at >= text.length) fail();
      const char = text[at];
      if (char === '"') {
        at += 1;
        return out;
      }
      if (char === "\\") {
        const escape = text[at + 1];
        if (escape === "u") {
          const hex = text.slice(at + 2, at + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail();
          out += String.fromCharCode(Number.parseInt(hex, 16));
          at += 6;
          continue;
        }
        if (!Object.hasOwn(escapes, escape ?? "")) fail();
        out += escapes[escape];
        at += 2;
        continue;
      }
      // Raw control characters are not JSON.
      if (char < " ") fail();
      out += char;
      at += 1;
    }
  };
  const number = () => {
    const match = numberPattern.exec(text.slice(at, at + 400));
    if (!match) fail();
    at += match[0].length;
    return Number(match[0]);
  };
  const list = (close, depth, item) => {
    at += 1;
    skip();
    if (text[at] === close) {
      at += 1;
      return;
    }
    for (;;) {
      item(depth + 1);
      skip();
      if (text[at] === ",") {
        at += 1;
        skip();
        if (text[at] === close) {
          at += 1;
          return;
        }
        continue;
      }
      if (text[at] === close) {
        at += 1;
        return;
      }
      fail();
    }
  };
  const value = (depth) => {
    if (depth > maxDepth) fail("tooDeep");
    skip();
    const char = text[at];
    if (char === "{") {
      const out = Object.create(null);
      const seen = new Set();
      list("}", depth, (inner) => {
        skip();
        if (text[at] !== '"') fail();
        const key = string();
        skip();
        if (text[at] !== ":") fail();
        at += 1;
        const item = value(inner);
        if (dropped.has(key)) return;
        if (seen.has(key)) duplicates.push(key);
        seen.add(key);
        out[key] = item;
      });
      return out;
    }
    if (char === "[") {
      const out = [];
      list("]", depth, (inner) => out.push(value(inner)));
      return out;
    }
    if (char === '"') return string();
    if (char === "-" || (char >= "0" && char <= "9")) return number();
    for (const [word, result] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ])
      if (text.startsWith(word, at)) {
        at += word.length;
        return result;
      }
    return fail();
  };
  const result = value(0);
  skip();
  if (at < text.length) fail();
  return { value: result, duplicates };
}
