import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  centralFromNative,
  cliEntry,
  entryHash,
  proposeName,
} from "../../server/features/mcp-servers/cli-native.js";
import { namePattern } from "../../server/features/mcp-servers/command-resolution.js";

const headerName = fc
  .stringMatching(/^[A-Za-z][A-Za-z0-9-]{0,15}$/)
  .filter((name) => !["constructor", "prototype"].includes(name));
const headerValue = fc.stringMatching(/^[ -~]{0,40}$/);

test("any proposed name is valid and not taken", () => {
  fc.assert(
    fc.property(
      fc.string({ maxLength: 60 }),
      fc.array(fc.stringMatching(/^[a-z][a-z0-9_-]{0,29}$/), { maxLength: 20 }),
      (name, list) => {
        const taken = new Set(list);
        const proposed = proposeName(name, taken);
        assert.match(proposed, namePattern);
        assert.equal(taken.has(proposed.toLowerCase()), false);
      },
    ),
  );
});

test("an HTTP header server survives projection and parsing in every CLI", () => {
  fc.assert(
    fc.property(
      fc.dictionary(headerName, headerValue, { maxKeys: 5 }),
      fc.constantFrom("claude", "codex", "opencode"),
      (headers, cli) => {
        const definition = {
          transport: "http",
          url: "https://mcp.example.test/mcp?k=v",
          args: [],
          cwd: null,
          auth: "headers",
          oauthScope: null,
        };
        const native = cliEntry(cli, definition, { headers, env: {} });
        const parsed = centralFromNative(cli, native);
        assert.equal(parsed.ok, true);
        assert.equal(
          entryHash(cliEntry(cli, parsed.definition, parsed.secrets)),
          entryHash(native),
        );
      },
    ),
  );
});
