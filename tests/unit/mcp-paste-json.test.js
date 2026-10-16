import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  maxDepth,
  parseRelaxedJson,
  PasteJsonError,
} from "../../web/features/mcp-servers/wizard/paste-json.js";

const plain = (value) => JSON.parse(JSON.stringify(value));

test("strict JSON reads as JSON.parse does", () => {
  const text = '{"a":[1,-2.5e3,true,false,null,"x\\n\\u00e4"],"b":{}}';
  assert.deepEqual(plain(parseRelaxedJson(text).value), JSON.parse(text));
});

test("comments and trailing commas are allowed outside strings only", () => {
  const text = `{
    // a line comment
    "args": ["--flag,other", "// not a comment", "/* nor this */",], /* block */
  }`;
  assert.deepEqual(plain(parseRelaxedJson(text).value), {
    args: ["--flag,other", "// not a comment", "/* nor this */"],
  });
});

test("objects have no prototype and dangerous keys are dropped", () => {
  const { value } = parseRelaxedJson(
    '{"__proto__":{"x":1},"constructor":2,"prototype":3,"ok":4}',
  );
  assert.equal(Object.getPrototypeOf(value), null);
  assert.deepEqual(Object.keys(value), ["ok"]);
  assert.equal({}.x, undefined);
});

test("duplicate keys keep the last value and are reported", () => {
  const { value, duplicates } = parseRelaxedJson('{"a":1,"a":2,"b":{"c":1,"c":3}}');
  assert.equal(value.a, 2);
  assert.equal(value.b.c, 3);
  assert.deepEqual(duplicates, ["a", "c"]);
});

test("errors carry a line and column; depth is capped", () => {
  assert.throws(
    () => parseRelaxedJson('{\n  "a": 1\n  "b": 2\n}'),
    (error) =>
      error instanceof PasteJsonError &&
      error.code === "invalidJson" &&
      error.line === 3 &&
      error.column === 3,
  );
  for (const bad of [
    "",
    "{",
    '{"a":}',
    "[1 2]",
    "{'a':1}",
    '{"a":1}x',
    '"\u0001"',
    "{,}",
    "/* open",
  ])
    assert.throws(() => parseRelaxedJson(bad), PasteJsonError, JSON.stringify(bad));
  const deep = "[".repeat(maxDepth + 2) + "]".repeat(maxDepth + 2);
  assert.throws(
    () => parseRelaxedJson(deep),
    (error) => error.code === "tooDeep",
  );
  const ok = "[".repeat(maxDepth + 1) + "]".repeat(maxDepth + 1);
  assert.doesNotThrow(() => parseRelaxedJson(ok));
});

test("property: valid JSON round-trips; any text either parses or throws PasteJsonError", () => {
  fc.assert(
    fc.property(fc.jsonValue({ maxDepth: 8 }), (value) => {
      const text = JSON.stringify(value);
      const expected = JSON.parse(text, (key, item) =>
        ["__proto__", "constructor", "prototype"].includes(key) ? undefined : item,
      );
      assert.deepEqual(plain(parseRelaxedJson(text).value), plain(expected));
    }),
  );
  fc.assert(
    fc.property(fc.string({ maxLength: 300 }), (text) => {
      try {
        parseRelaxedJson(text);
      } catch (error) {
        assert.ok(error instanceof PasteJsonError);
      }
    }),
  );
});
