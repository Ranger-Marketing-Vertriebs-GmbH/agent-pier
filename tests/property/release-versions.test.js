import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { check } from "../helpers/property.js";
import { compareReleaseVersions } from "../../server/features/operations/version.js";

const core = fc.tuple(fc.nat(30), fc.nat(30), fc.nat(30)).map((parts) => parts.join("."));
const identifier = fc.oneof(
  fc.nat(20).map(String),
  fc.constantFrom("rc", "alpha", "beta", "x"),
);
const version = fc
  .tuple(core, fc.option(fc.array(identifier, { minLength: 1, maxLength: 3 })))
  .map(([base, pre]) => (pre ? `${base}-${pre.join(".")}` : base));
const sign = (value) => Math.sign(value);

test("release version order is antisymmetric and reflexive", () => {
  check(
    fc.property(version, version, (left, right) => {
      assert.equal(compareReleaseVersions(left, left), 0);
      assert.equal(
        sign(compareReleaseVersions(left, right)),
        -sign(compareReleaseVersions(right, left)),
      );
    }),
  );
});

test("release version order is transitive", () => {
  check(
    fc.property(version, version, version, (a, b, c) => {
      // Every triple has at least one ordering whose premise holds.
      for (const [x, y, z] of [
        [a, b, c],
        [a, c, b],
        [b, a, c],
        [b, c, a],
        [c, a, b],
        [c, b, a],
      ])
        if (compareReleaseVersions(x, y) <= 0 && compareReleaseVersions(y, z) <= 0)
          assert.ok(compareReleaseVersions(x, z) <= 0, `${x} <= ${y} <= ${z}`);
    }),
  );
});

test("a release candidate precedes its final release and the next candidate", () => {
  check(
    fc.property(core, fc.nat(1000), (base, number) => {
      const candidate = `${base}-rc.${number}`;
      assert.ok(compareReleaseVersions(candidate, base) < 0);
      assert.ok(compareReleaseVersions(base, candidate) > 0);
      assert.ok(compareReleaseVersions(candidate, `${base}-rc.${number + 1}`) < 0);
    }),
  );
});
