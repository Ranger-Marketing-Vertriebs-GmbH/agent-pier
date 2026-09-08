import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { capture } from "../../server/features/operations/snapshot.js";

test("logical backups omit MCP grants tokens and start capabilities even with credentials", async (t) => {
  const fixture = await applicationFixture(t);
  await fs.writeFile(
    path.join(fixture.dataDir, "mcp-access", "marker"),
    "private MCP authorization fixture",
  );
  for (const withCredentials of [false, true]) {
    const snapshot = capture({
      dataDir: fixture.dataDir,
      includeHistory: true,
      withCredentials,
      audit: fixture.application.audit,
    });
    const members = [...snapshot.files, ...snapshot.credentials];
    assert.ok(!members.some((member) => /^mcp-(access|requests)\//.test(member.path)));
    assert.doesNotMatch(JSON.stringify(members), /private MCP authorization fixture/);
  }
});
