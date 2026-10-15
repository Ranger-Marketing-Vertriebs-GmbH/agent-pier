import test from "node:test";
import assert from "node:assert/strict";
import {
  refusalField,
  showsPath,
} from "../../web/features/mcp-servers/mcp-package-labels.js";

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

test("only nested copies of one name show their lock path", () => {
  const list = [
    { name: "extra", version: "2.0.0", path: "extra" },
    { name: "extra", version: "2.0.0", path: "helper > extra" },
    { name: "helper", version: "1.0.0", path: "helper" },
  ];
  assert.equal(showsPath(list[0], list), false);
  assert.equal(showsPath(list[1], list), true);
  assert.equal(showsPath(list[2], list), false);
  assert.equal(
    showsPath({ name: "x", version: "1" }, [{ name: "x" }, { name: "x" }]),
    false,
  );
});
