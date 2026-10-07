import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { check } from "../helpers/property.js";
import {
  collect,
  fixtureList,
  fromChunks,
  loadFixture,
  splitChunks,
} from "../helpers/protocol-adapter.js";
import {
  DIRECTIONS,
  clientBody,
  translator,
} from "../helpers/protocol-adapter-directions.js";

const BASE_REQUEST = {
  messages: "clients/claude-code/text.json",
  responses: "clients/codex/text.json",
};

/** Client output of one translated upstream stream, delivered as the given chunks. */
async function translate(client, upstream, chunks) {
  const instance = translator(client, upstream);
  const built = instance.buildUpstream(
    clientBody(BASE_REQUEST[client]),
    {},
    { requestId: "req_property", now: 1791331200000 },
  );
  assert.equal(built.ok, true);
  return (await collect(built.exchange.translateStream(fromChunks(chunks)))).join("");
}

// Chunk sizes 1–64 characters; seeded through tests/helpers/property.js (FC_SEED).
const sizes = fc.array(fc.integer({ min: 1, max: 64 }), { maxLength: 300 });

for (const { client, upstream } of DIRECTIONS) {
  for (const file of fixtureList(`upstreams/${upstream}`)) {
    if (!file.endsWith(".sse")) continue;
    test(`${client} ← ${upstream}: ${file} output is independent of chunk boundaries`, async () => {
      const text = loadFixture(file);
      const whole = await translate(client, upstream, [text]);
      assert.ok(whole.length > 0);
      await check(
        fc.asyncProperty(sizes, async (split) => {
          assert.equal(
            await translate(client, upstream, splitChunks(text, split)),
            whole,
          );
        }),
        { numRuns: 25 },
      );
    });
  }
}
