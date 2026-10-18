import test from "node:test";
import assert from "node:assert/strict";
import { SCAN_RULES, scanSkill } from "../../server/features/extensions/skill-scan.js";
import { ruleCases } from "../fixtures/skill-scan-cases.js";

test("every scan rule has positive and negative fixtures", () => {
  assert.deepEqual(Object.keys(ruleCases).sort(), [...SCAN_RULES].sort());
  for (const [rule, { positive, negative }] of Object.entries(ruleCases)) {
    assert.ok(positive.length > 0, `${rule} needs a positive fixture`);
    assert.ok(negative.length > 0, `${rule} needs a negative fixture`);
  }
});

for (const [rule, { positive, negative }] of Object.entries(ruleCases)) {
  positive.forEach(({ file, severity, line }, index) => {
    test(`${rule} finds positive fixture ${index + 1}`, () => {
      const scan = scanSkill([file]);
      const found = scan.findings.filter((finding) => finding.rule === rule);
      assert.ok(found.length > 0, `${rule} missed ${JSON.stringify(String(file[1]))}`);
      assert.equal(found[0].severity, severity);
      if (line !== undefined) assert.equal(found[0].line, line);
      assert.ok(scan.rules.includes(rule));
      assert.equal(scan.verdict, severity === "block" ? "block" : scan.verdict);
      assert.notEqual(scan.verdict, "ok");
    });
  });
  negative.forEach((file, index) => {
    test(`${rule} leaves negative fixture ${index + 1} alone`, () => {
      const scan = scanSkill([file]);
      assert.deepEqual(
        scan.findings.filter((finding) => finding.rule === rule),
        [],
      );
      assert.equal(scan.rules.includes(rule), false);
    });
  });
}
