import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuditStore } from "../../server/features/audit/audit-store.js";
import { sshLastUse } from "../../server/features/accounts/connection-last-use.js";

const lab = "11111111-1111-4111-8111-111111111111";
const files = "33333333-3333-4333-8333-333333333333";

test("last use is the newest audited SSH command or SFTP transfer per host", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-last-use-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let now = Date.parse("2026-10-20T10:00:00.000Z");
  const audit = new AuditStore({ dataDir, clock: { now: () => now } });
  t.after(() => audit.close());
  const append = (action, resourceId, outcome = "success") => {
    audit.append({ action, resourceType: "ssh", resourceId, source: "system", outcome });
    now += 60_000;
  };
  append("ssh.executed", lab);
  append("ssh.executed", lab);
  append("sftp.failed", files, "failure");
  // Neither a test nor a creation is a use.
  append("ssh.tested", lab);
  append("ssh.created", files);
  const uses = sshLastUse(audit);
  assert.deepEqual(Object.fromEntries(uses), {
    [lab]: "2026-10-20T10:01:00.000Z",
    [files]: "2026-10-20T10:02:00.000Z",
  });
  assert.equal(sshLastUse(null), null);
  assert.equal(
    sshLastUse({
      latestByResource: () => {
        throw new Error("closed");
      },
    }),
    null,
  );
});
