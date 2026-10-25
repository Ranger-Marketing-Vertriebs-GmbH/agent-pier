import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mirrorLeadMemory } from "../../server/features/assistants/member-memory.js";

test("the lead mirror leaves out the lead's dream notes", async (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "lead-mirror-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lead = path.join(root, "lead");
  const own = path.join(root, "member");
  fs.mkdirSync(path.join(lead, "memory", "dreaming", "light"), { recursive: true });
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(lead, "MEMORY.md"), "Lead facts");
  fs.writeFileSync(path.join(lead, "memory", "2026-10-24.md"), "Day note");
  fs.writeFileSync(
    path.join(lead, "memory", "dreaming", "light", "2026-10-24.md"),
    "Candidate: User: a line",
  );
  await mirrorLeadMemory(root, { id: "member", parentAssistantId: "lead" }, true);
  const mirrored = fs.readdirSync(path.join(own, "memory", "lead")).sort();
  assert.ok(mirrored.includes("MEMORY.md"));
  assert.ok(mirrored.some((name) => name.includes("2026-10-24")));
  assert.equal(
    mirrored.some((name) => name.includes("dreaming")),
    false,
    mirrored.join(", "),
  );
});
