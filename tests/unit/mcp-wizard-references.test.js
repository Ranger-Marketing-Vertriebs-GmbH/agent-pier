import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fc from "fast-check";
import { hasReference as serverHas } from "../../server/features/mcp-servers/value-references.js";
import {
  hasReference,
  referenceName,
  referenceOpeners,
} from "../../web/features/mcp-servers/wizard/value-references.js";

test("the browser openers are the server's openers", () => {
  const source = fs.readFileSync(
    new URL("../../server/features/mcp-servers/value-references.js", import.meta.url),
    "utf8",
  );
  const declared = /const openers = (\[[^\]]*\]);/.exec(source)[1];
  assert.deepEqual(referenceOpeners, JSON.parse(declared));
});

test("browser and server agree on every value", () => {
  const pieces = fc.constantFrom(
    "${",
    "{env:",
    "{file:",
    "}",
    "$",
    "{",
    "a",
    "VAR",
    ":-x",
    " ",
  );
  fc.assert(
    fc.property(
      fc.array(pieces, { maxLength: 12 }).map((parts) => parts.join("")),
      (value) => assert.equal(hasReference(value), serverHas(value), value),
    ),
    { numRuns: 2000 },
  );
});

test("the reference's variable name is named, never the rest of the value", () => {
  assert.equal(referenceName("Bearer ${API_TOKEN}"), "API_TOKEN");
  assert.equal(referenceName("${VAR:-fallback}"), "VAR");
  assert.equal(referenceName("${env:HOME}"), "HOME");
  assert.equal(referenceName("${input:apiKey}"), "apiKey");
  assert.equal(referenceName("{file:/etc/secret}"), "/etc/secret");
  assert.equal(referenceName("plain"), null);
});
