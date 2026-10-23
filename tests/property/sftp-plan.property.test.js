import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { planTransfer } from "../../server/features/sftp/sftp-plan.js";
import { insideRoot, remotePath } from "../../server/features/sftp/sftp-remote-paths.js";
import { excluded, excludeList } from "../../server/features/sftp/sftp-excludes.js";

const name = fc.constantFrom("a", "b", "c", "d.txt", "e f", "ü");
const relative = fc.array(name, { minLength: 1, maxLength: 3 }).map((p) => p.join("/"));
const entries = fc.uniqueArray(
  fc.record({
    path: relative,
    size: fc.nat({ max: 50 }),
    mtimeMs: fc.integer({ min: 0, max: 20_000 }),
  }),
  { selector: (e) => e.path, maxLength: 12 },
);
const options = fc.record({ sync: fc.boolean(), deleteExtra: fc.boolean() });

test("create, update and unchanged partition the source", () => {
  fc.assert(
    fc.property(entries, entries, options, (source, target, flags) => {
      const plan = planTransfer({ source, target, ...flags });
      const planned = [...plan.create, ...plan.update].map((e) => e.path);
      assert.equal(new Set(planned).size, planned.length);
      assert.equal(planned.length + plan.unchanged, source.length);
      const targets = new Set(target.map((e) => e.path));
      assert.ok(plan.create.every((e) => !targets.has(e.path)));
      assert.ok(plan.update.every((e) => targets.has(e.path)));
      if (!flags.sync) assert.equal(plan.unchanged, 0);
      assert.equal(plan.files, planned.length);
      assert.equal(plan.overwrites, plan.update.length);
    }),
  );
});

test("applying a plan and planning again leaves nothing to do", () => {
  fc.assert(
    fc.property(entries, entries, options, (source, target, flags) => {
      const plan = planTransfer({ source, target, ...flags });
      const after = new Map(target.map((e) => [e.path, e]));
      for (const e of [...plan.create, ...plan.update]) after.set(e.path, { ...e });
      for (const e of plan.delete) after.delete(e.path);
      const again = planTransfer({
        source,
        target: [...after.values()],
        sync: true,
        deleteExtra: flags.sync && flags.deleteExtra,
      });
      assert.deepEqual([again.create, again.update, again.delete], [[], [], []]);
    }),
  );
});

test("no deletes without deleteExtra", () => {
  fc.assert(
    fc.property(entries, entries, fc.boolean(), (source, target, sync) => {
      const plan = planTransfer({ source, target, sync, deleteExtra: false });
      assert.equal(plan.deletes, 0);
      assert.deepEqual(plan.delete, []);
    }),
  );
});

test("the digest changes when any planned entry changes", () => {
  fc.assert(
    fc.property(
      entries.filter((e) => e.length > 0),
      fc.nat(),
      fc.constantFrom("size", "mtimeMs", "path"),
      (source, pick, field) => {
        const before = planTransfer({ source, target: [] });
        const index = pick % source.length;
        const changed = source.map((e, i) =>
          i !== index
            ? e
            : { ...e, [field]: field === "path" ? `${e.path}~` : e[field] + 1 },
        );
        const after = planTransfer({ source: changed, target: [] });
        assert.notEqual(after.digest, before.digest);
        assert.equal(
          planTransfer({ source: [...source].reverse(), target: [] }).digest,
          before.digest,
        );
      },
    ),
  );
});

const segment = fc.constantFrom("a", "b", ".", "..", "", "ü x");
test("remote paths stay absolute, normalised and never climb above /", () => {
  fc.assert(
    fc.property(fc.array(segment, { maxLength: 8 }), fc.boolean(), (parts, absolute) => {
      const raw = (absolute ? "/" : "") + parts.join("/");
      let result;
      try {
        result = remotePath(raw, "/www");
      } catch (error) {
        assert.equal(error.code, "SFTP_PATH_REFUSED");
        return;
      }
      assert.ok(result.startsWith("/"));
      assert.ok(!result.split("/").some((p) => p === "." || p === ".."));
      assert.ok(result === "/" || !result.endsWith("/"));
      assert.ok(!result.includes("//"));
      if (!raw.startsWith("/") && !parts.includes(".."))
        assert.ok(insideRoot("/www", result));
    }),
  );
});

test("a segment pattern excludes every path below a matching segment", () => {
  fc.assert(
    fc.property(
      fc.array(name, { maxLength: 3 }),
      name,
      fc.array(name, { maxLength: 3 }),
      (head, hit, tail) => {
        const list = excludeList([hit], { defaults: false });
        assert.equal(excluded([...head, hit, ...tail].join("/"), list), true);
        const other = [...head, ...tail].filter((p) => p !== hit);
        if (other.length) assert.equal(excluded(other.join("/"), list), false);
      },
    ),
  );
});
