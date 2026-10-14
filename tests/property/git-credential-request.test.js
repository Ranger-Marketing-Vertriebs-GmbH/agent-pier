import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { check } from "../helpers/property.js";
import { parseCredentialRequest } from "../../server/features/repositories/git-credential-request.js";
import { gitCredential } from "../../server/features/repositories/github-credentials.js";
import {
  credentialSession,
  gitCapabilityLines,
} from "../helpers/git-credential-session.js";

const singular = ["protocol=https", "host=github.com", "path=owner/repo.git"];
// Multi-valued attributes git may add, including future capabilities.
const multiValued = fc.oneof(
  fc.constantFrom(...gitCapabilityLines),
  fc
    .tuple(
      fc.stringMatching(/^[a-z][a-z_-]{0,12}$/),
      fc.string({ maxLength: 40 }).filter((value) => !/[\r\n\0]/.test(value)),
    )
    .map(([key, value]) => `${key}[]=${value}`),
);
// Inserts multi-valued lines between the singular ones without reordering them.
const interleaved = fc
  .array(fc.tuple(multiValued, fc.nat()), { maxLength: 12 })
  .chain((extras) => fc.tuple(fc.constant(extras), fc.boolean(), fc.boolean()))
  .map(([extras, crlf, terminated]) => {
    const lines = [...singular];
    for (const [line, at] of extras) lines.splice(at % (lines.length + 1), 0, line);
    const eol = crlf ? "\r\n" : "\n";
    return lines.join(eol) + (terminated ? eol + eol : "");
  });

test("multi-valued attributes never change a parsed credential request", () => {
  check(
    fc.property(interleaved, (input) => {
      assert.deepEqual(Object.fromEntries(parseCredentialRequest(input)), {
        protocol: "https",
        host: "github.com",
        path: "owner/repo.git",
      });
    }),
    { numRuns: 300 },
  );
});

test("the session helper returns its token for any interleaving of git extensions", (t) => {
  const { env, token } = credentialSession(t);
  check(
    fc.property(interleaved, (input) => {
      assert.equal(
        gitCredential(input, env),
        `username=x-access-token\npassword=${token}\n\n`,
      );
    }),
    { numRuns: 200 },
  );
});

test("a repeated singular key always rejects the request", () => {
  check(
    fc.property(
      interleaved,
      fc.constantFrom(...singular),
      fc.nat(),
      (input, duplicate, at) => {
        const lines = input.split(/\r?\n/).filter(Boolean);
        lines.splice(at % (lines.length + 1), 0, duplicate);
        assert.equal(parseCredentialRequest(lines.join("\n") + "\n\n"), null);
      },
    ),
    { numRuns: 300 },
  );
});
