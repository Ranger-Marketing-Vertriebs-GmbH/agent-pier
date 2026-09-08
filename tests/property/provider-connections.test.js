import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { ProviderConnections } from "../../server/features/providers/provider-connections.js";
test("arbitrary central key rotations never enter public connection or metadata projections", (t) => {
  const dataDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-connection-property-")),
  );
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const connections = new ProviderConnections({ dataDir });
  const connection = connections.create({ name: "Property", providerId: "openrouter" });
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: 33, max: 126 }), { minLength: 1, maxLength: 100 }),
      (chars) => {
        const apiKey = `fixture-private-${String.fromCharCode(...chars)}`;
        const result = connections.update(connection.id, { apiKey });
        assert.equal(Object.hasOwn(result, "apiKey"), false);
        assert.equal(Object.hasOwn(connections.list()[0], "apiKey"), false);
        assert.equal(
          fs
            .readFileSync(path.join(dataDir, "provider-connections.json"), "utf8")
            .includes("fixture-private-"),
          false,
        );
        assert.equal(
          new ProviderConnections({ dataDir }).secret(connection.id).apiKey,
          apiKey,
        );
      },
    ),
    {
      seed: Number(process.env.FC_SEED || 260907),
      numRuns: Number(process.env.FC_RUNS || 100),
    },
  );
});
