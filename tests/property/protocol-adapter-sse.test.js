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
  test(`random chunk splits parse like a single push: ${file}`, () => {
    const text = loadFixture(file);
    const whole = parseChunks([text]);
    assert.ok(whole.length > 0);
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

  test(`CRLF rewrite parses identically: ${file}`, () => {
    const text = loadFixture(file);
    assert.deepEqual(parseChunks([text.replace(/\n/g, "\r\n")]), parseChunks([text]));
  });
}
