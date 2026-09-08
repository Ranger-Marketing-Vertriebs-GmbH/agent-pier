import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { check, characters } from "../helpers/property.js";
import { ProjectMemory } from "../../server/features/memory/project-memory.js";

test("generated memory revisions preserve literal Unicode data and reject every stale update", async (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-memory-property-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const text = characters("abCD09 äöü世界🧭\n%_\\<>[]$`", {
    minLength: 1,
    maxLength: 80,
  }).filter((s) => Boolean(s.trim()));
  await check(
    fc.asyncProperty(fc.array(text, { minLength: 2, maxLength: 12 }), async (values) => {
      const folder = fs.mkdtempSync(path.join(root, "case-"));
      const memory = new ProjectMemory({ dataDir: folder });
      try {
        const p = await memory.register(folder);
        let current = memory.write(p.id, {
          title: "Generated literal",
          content: values[0],
        });
        for (const content of values.slice(1)) {
          const prior = current;
          current = memory.write(p.id, {
            id: current.id,
            title: "Generated literal",
            content,
            expectedRevision: current.revision,
          });
          assert.equal(current.content, content);
          assert.equal(current.revision, prior.revision + 1);
          assert.equal(
            memory.read(p.id, current.id, { revision: prior.revision }).content,
            prior.content,
          );
          assert.throws(
            () =>
              memory.write(p.id, {
                id: current.id,
                title: "Stale",
                content: "Stale",
                expectedRevision: prior.revision,
              }),
            { status: 409 },
          );
        }
        assert.equal(memory.revisions(p.id, current.id).total, values.length);
      } finally {
        memory.close();
        fs.rmSync(folder, { recursive: true, force: true });
      }
    }),
    { numRuns: 30 },
  );
});
