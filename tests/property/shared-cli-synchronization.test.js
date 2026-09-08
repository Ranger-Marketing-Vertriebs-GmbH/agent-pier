import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { check } from "../helpers/property.js";
import {
  fingerprint,
  synchronize,
} from "../../server/features/cli-profiles/synchronization.js";

const definitions = fc
  .dictionary(
    fc.stringMatching(/^[a-z][a-z0-9]{0,12}$/),
    fc.record({
      command: fc.string(),
      env: fc.dictionary(fc.stringMatching(/^[A-Z]{1,12}$/), fc.string()),
    }),
  )
  .map((value) => JSON.parse(JSON.stringify(value)));
test("unchanged account snapshots never undo concurrent shared edits or deletions", () => {
  check(
    fc.property(definitions, definitions, (previous, current) => {
      const baseline = { mcp_servers: previous },
        shared = { mcp_servers: current };
      assert.deepEqual(synchronize(shared, baseline, fingerprint(baseline), []), shared);
    }),
    { numRuns: 200 },
  );
});
test("an account's edits synchronize exactly when the shared configuration has not changed", () => {
  check(
    fc.property(definitions, definitions, (previous, next) => {
      const baseline = { mcpServers: previous },
        incoming = { mcpServers: next },
        conflicts = [];
      assert.deepEqual(
        synchronize(baseline, incoming, fingerprint(baseline), conflicts),
        incoming,
      );
      assert.deepEqual(conflicts, []);
      assert.deepEqual(
        synchronize(incoming, incoming, fingerprint(incoming), []),
        incoming,
      );
    }),
    { numRuns: 200 },
  );
});
test("concurrent changes retain the shared definition as a whole and report a name only", () => {
  const baseline = { mcp: { fixture: { command: ["before"] } } };
  const shared = {
    mcp: { fixture: { command: ["shared"], environment: { SECRET: "host" } } },
  };
  const incoming = {
    mcp: { fixture: { command: ["account"], environment: { SECRET: "account" } } },
  };
  const conflicts = [];
  assert.deepEqual(
    synchronize(shared, incoming, fingerprint(baseline), conflicts),
    shared,
  );
  assert.deepEqual(conflicts, ["mcp.fixture"]);
});
