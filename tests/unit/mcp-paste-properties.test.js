import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { parsePaste } from "../../web/features/mcp-servers/wizard/paste-parser.js";
import { hasReference } from "../../web/features/mcp-servers/wizard/value-references.js";

const strings = (draft) =>
  [
    draft.url,
    draft.command,
    draft.cwd,
    ...(draft.argRows ?? []),
    ...(draft.env ?? []).map((row) => row.value),
    ...(draft.headers ?? []).map((row) => row.value),
  ].filter((value) => typeof value === "string");

const valueArb = fc.oneof(
  fc.string({ maxLength: 40 }),
  fc.constantFrom(
    "${A}",
    "${env:B}",
    "{env:C}",
    "{file:/x}",
    "${input:id}",
    "your-key-here",
    "<token>",
  ),
  fc.integer(),
  fc.boolean(),
);
const entryArb = fc.record(
  {
    command: fc.oneof(
      fc.constantFrom("npx", "uvx", "node", "docker", "pipx"),
      fc.string({ maxLength: 12 }),
    ),
    args: fc.array(
      fc.oneof(fc.string({ maxLength: 20 }), fc.constantFrom("-y", "pkg@1.0.0", "${X}")),
      { maxLength: 6 },
    ),
    env: fc.dictionary(fc.string({ maxLength: 12 }), valueArb, { maxKeys: 6 }),
    url: fc.constantFrom("https://x.test/mcp", "http://h/sse", "${URL}"),
    headers: fc.dictionary(fc.string({ maxLength: 12 }), valueArb, { maxKeys: 4 }),
    cwd: fc.constantFrom("/abs", "rel", "${HOME}"),
  },
  { requiredKeys: [] },
);

test("never throws and stays inside its limits for any text", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 2000 }), (text) => {
      const result = parsePaste(text);
      assert.equal(typeof result.ok, "boolean");
    }),
    { numRuns: 500 },
  );
  fc.assert(
    fc.property(
      fc.dictionary(fc.string({ maxLength: 20 }), entryArb, { maxKeys: 25 }),
      (servers) => {
        const result = parsePaste(JSON.stringify({ mcpServers: servers }));
        if (!result.ok) return;
        assert.ok(result.servers.length <= 20);
        for (const server of result.servers) {
          assert.ok(
            server.name === "" || /^[A-Za-z][A-Za-z0-9_-]{0,29}$/.test(server.name),
          );
          if (!server.draft) continue;
          assert.ok(server.draft.argRows.length <= 100);
          assert.ok((server.draft.env ?? []).length <= 100);
          for (const value of strings(server.draft))
            assert.equal(hasReference(value), false, value);
        }
      },
    ),
  );
});

test("unknown keys are named, their values never appear", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 12 }), fc.uuid(), (key, secret) => {
      fc.pre(
        ![
          "command",
          "args",
          "env",
          "environment",
          "url",
          "serverUrl",
          "headers",
          "cwd",
          "type",
          "transport",
          "transportType",
        ].includes(key),
      );
      const text = JSON.stringify({
        mcpServers: { x: { command: "node", [key]: `SECRET-${secret}` } },
      });
      const result = parsePaste(text);
      assert.doesNotMatch(JSON.stringify(result), new RegExp(`SECRET-${secret}`));
    }),
  );
});

test("the same text always gives the same result", () => {
  fc.assert(
    fc.property(
      fc.dictionary(fc.string({ maxLength: 10 }), entryArb, { maxKeys: 4 }),
      (servers) => {
        const text = JSON.stringify({ mcpServers: servers });
        assert.deepEqual(
          JSON.parse(JSON.stringify(parsePaste(text))),
          JSON.parse(JSON.stringify(parsePaste(text))),
        );
      },
    ),
  );
});
