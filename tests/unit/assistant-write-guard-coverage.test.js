import test from "node:test";
import assert from "node:assert/strict";
import {
  profileTools,
  routineTools,
  shellTools,
} from "../../server/features/assistants/native-capabilities.js";
import {
  patchPaths,
  writeTools,
} from "../../server/features/assistants/team-plugin/tool-guard.js";

// Tools AgentPier grants that never change a file. A new granted tool must be put
// here, behind the write guard (writeTools), or behind shell approvals.
const readOnly = [
  "session_status",
  "memory_search",
  "memory_get",
  "read",
  "web_search",
  "web_fetch",
  "browser",
  "view_image",
];
const everything = {
  memory: true,
  reminders: true,
  webSearch: true,
  webFetch: true,
  browser: true,
  documents: true,
};

test("every file tool an agent can be granted is behind the write guard", () => {
  const granted = new Set([
    ...profileTools({ capabilities: everything, shell: "full" }, true, true, true),
    ...routineTools,
    // OpenClaw grants apply_patch wherever write is allowed (writeAllowsApplyPatch).
    "apply_patch",
  ]);
  for (const tool of granted) {
    if (tool.includes("__") || tool.startsWith("agentpier_")) continue;
    assert.ok(
      readOnly.includes(tool) || writeTools.includes(tool) || shellTools.includes(tool),
      `${tool} is unaccounted for`,
    );
  }
  for (const tool of ["write", "edit", "apply_patch"])
    assert.ok(writeTools.includes(tool), tool);
});

test("a patch's paths include every hunk header OpenClaw would apply", () => {
  const envelope = (...lines) =>
    ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
  assert.deepEqual(
    patchPaths(
      envelope(
        "*** Add File: a.md",
        "+x",
        "  *** Update File: b.md",
        "*** Move to: c.md",
        "@@",
        "-y",
        "+z",
        "*** Delete File: d.md",
      ),
    ),
    ["a.md", "b.md", "c.md", "d.md"],
  );
  assert.deepEqual(patchPaths(`<<EOF\n${envelope("*** Add File: e.md", "+x")}\nEOF`), [
    "e.md",
  ]);
  assert.equal(patchPaths(envelope("nothing")), null);
  assert.equal(patchPaths(undefined), null);
});
