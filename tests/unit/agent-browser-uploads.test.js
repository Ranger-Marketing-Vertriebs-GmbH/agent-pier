import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AgentBrowserUploads,
  turnDetails,
} from "../../server/features/assistants/agent-browser-uploads.js";
import { BrowserUploads } from "../../server/features/assistants/browser-upload-staging.js";

// A temporary task member with its lead's browser grant, staged through the real
// staging below disposable folders.
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-uploads-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.mkdirSync(path.join(base, "openclaw"), { mode: 0o700 });
  fs.mkdirSync(path.join(base, "project"));
  fs.writeFileSync(path.join(base, "project", "cut.mp4"), "cut");
  const member = {
    id: "m1",
    runtimeAgentId: "ap-m1",
    teamMemberId: "tm1",
    lifetime: "task",
    parentAssistantId: "lead",
    inherited: { capabilities: { browser: true }, skills: [], shell: "off", ssh: false },
  };
  const records = new Map([[member.id, member]]);
  const w = {
    a: {
      store: {
        getAssistant: (id) => {
          if (!records.has(id)) throw Error("gone");
          return records.get(id);
        },
        listAssistants: () => [...records.values()],
      },
    },
    s: { audit: { append() {} } },
    now: Date.now,
  };
  const uploads = new AgentBrowserUploads(w);
  uploads.files = new BrowserUploads({
    tmp: base,
    dataRoot: base,
    uploadDir: path.join(base, "openclaw", "uploads"),
  });
  const stage = () =>
    uploads.files.stage(member.id, { root: path.join(base, "project"), raw: "cut.mp4" });
  return { member, records, uploads, stage };
}

test("an ended temporary member's staged files go and stop passing at once", async (t) => {
  const { member, records, uploads, stage } = fixture(t);
  const entry = await stage();
  assert.equal(uploads.admit({ agentId: "ap-m1", paths: [entry.path] }), null);
  uploads.sweep();
  assert.equal(fs.existsSync(entry.path), true);
  // The member ended: archived with its team.
  records.set(member.id, { ...member, archivedAt: "2026-10-25T00:00:00Z" });
  assert.equal(
    uploads.admit({ agentId: "ap-m1", paths: [entry.path] }),
    "uploadNotStaged",
  );
  assert.equal(fs.existsSync(entry.path), false);
  // Removed entirely, its next file goes with the next sweep too.
  records.set(member.id, member);
  const next = await stage();
  records.delete(member.id);
  uploads.sweep();
  assert.equal(fs.existsSync(next.path), false);
  assert.equal(uploads.admit({ agentId: "ap-m1", paths: [next.path] }), "notGranted");
});

test("the audit names the turn a file was staged in", () => {
  assert.deepEqual(
    turnDetails({
      attemptId: "a1",
      requestedBy: "tm1",
      routine: { bindingId: "r1" },
      leadRequest: { id: "lr1", leadId: "lead" },
    }),
    {
      sourceAttemptId: "a1",
      requestedBy: "tm1",
      routineId: "r1",
      leadAssistantId: "lead",
      leadRequestId: "lr1",
    },
  );
  assert.deepEqual(turnDetails({ execContinuation: { attemptId: "a" } }), {
    via: "exec-completion",
  });
});
