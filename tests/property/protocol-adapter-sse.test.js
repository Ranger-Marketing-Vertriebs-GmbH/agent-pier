import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { check } from "../helpers/property.js";
import { fixtureList, loadFixture, splitChunks } from "../helpers/protocol-adapter.js";
import { createSseParser } from "../../server/features/protocol-adapter/sse.js";

const parseChunks = (chunks) => {
  const parser = createSseParser();
  return [...chunks.flatMap((chunk) => parser.push(chunk)), ...parser.end()];
};

const files = ["messages", "responses", "chat"]
  .flatMap((dir) => fixtureList(`upstreams/${dir}`))
  .filter((file) => file.endsWith(".sse"));

test("every upstream SSE fixture is covered", () => {
  assert.ok(files.length >= 20);
});

for (const file of files) {
  const rewrites = { LF: "\n", CRLF: "\r\n", CR: "\r" };
  for (const [label, terminator] of Object.entries(rewrites)) {
    test(`${label} rewrite splits at random chunk boundaries like one push: ${file}`, () => {
      const original = loadFixture(file);
      const whole = parseChunks([original]);
      assert.ok(whole.length > 0);
      const text = original.replace(/\n/g, terminator);
      assert.deepEqual(parseChunks([text]), whole);
      check(
        fc.property(
          fc.array(fc.integer({ min: 1, max: 64 }), { maxLength: 400 }),
          (sizes) => {
            assert.deepEqual(parseChunks(splitChunks(text, sizes)), whole);
          },
        ),
        { numRuns: 50 },
      );
    });
  }
}
