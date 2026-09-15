import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import YAML from "yaml";

test("manual tag dispatch builds artifacts without publishing a release or tap update", () => {
  const workflow = YAML.parse(
    fs.readFileSync(
      new URL("../../.github/workflows/release.yml", import.meta.url),
      "utf8",
    ),
  );
  // Evaluate the expression with GitHub's event fields, independently of YAML layout.
  for (const [event_name, ref, expected] of [
    ["workflow_dispatch", "refs/tags/v1.2.3", false],
    ["push", "refs/heads/main", false],
    ["push", "refs/tags/v1.2.3", true],
  ]) {
    for (const job of ["publish", "tap"]) {
      const condition = new Function(
        "github",
        "vars",
        "startsWith",
        `return (${workflow.jobs[job].if})`,
      );
      assert.equal(
        condition(
          { event_name, ref },
          { AGENTPIER_HOMEBREW_TAP_ENABLED: "true" },
          (text, prefix) => text.startsWith(prefix),
        ),
        expected,
        `${job} on ${event_name} ${ref}`,
      );
    }
  }
});
