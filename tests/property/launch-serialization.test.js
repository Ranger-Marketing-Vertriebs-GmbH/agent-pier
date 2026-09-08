import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fc from "fast-check";
import { check } from "../helpers/property.js";
import { parse } from "smol-toml";
import { shellQuote, tomlValue } from "../../server/lib/launch-serialization.js";

test("shell quoting preserves arbitrary text as one literal argument", () => {
  check(
    fc.property(
      fc.string({ maxLength: 80 }).filter((value) => !value.includes("\0")),
      (value) => {
        assert.equal(
          execFileSync("/bin/sh", ["-c", `printf '%s' ${shellQuote(value)}`], {
            encoding: "utf8",
          }),
          value,
        );
      },
    ),
    { numRuns: 75 },
  );
});

test("TOML launch values round-trip nested data without creating extra config keys", () => {
  const scalar = fc.oneof(fc.string(), fc.boolean(), fc.integer());
  const value = fc.oneof(
    scalar,
    fc.array(scalar),
    fc.dictionary(fc.string({ minLength: 1, maxLength: 40 }), scalar),
  );
  check(
    fc.property(value, (input) => {
      assert.deepEqual(parse(`configuration = ${tomlValue(input)}`), {
        configuration: JSON.parse(JSON.stringify(input)),
      });
    }),
    { numRuns: 250 },
  );
});
