import test from "node:test";
import assert from "node:assert/strict";
import { refusalField } from "../../web/features/mcp-servers/mcp-package-labels.js";

test("refusals belong to the field the owner can fix", () => {
  const key = (messageKey) => ({ messageKey });
  assert.equal(
    refusalField(key("mcpPackages.invalidConstraints"), "pypi"),
    "packageConstraints",
  );
  assert.equal(
    refusalField(key("mcpPackages.unsatisfiable"), "pypi"),
    "packageConstraints",
  );
  assert.equal(refusalField(key("mcpPackages.unsatisfiable"), "npm"), "packageVersion");
  assert.equal(
    refusalField(key("mcpPackages.pythonUnsupported"), "pypi"),
    "packageVersion",
  );
  assert.equal(refusalField(key("mcpPackages.versionYanked"), "pypi"), "packageVersion");
  assert.equal(refusalField(key("mcpPackages.previewFailed"), "pypi"), null);
  assert.equal(refusalField(null, "npm"), null);
});
