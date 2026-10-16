import test from "node:test";
import assert from "node:assert/strict";
import { saveWork } from "../../server/features/assistants/assistant-work.js";

test("saveWork reports when an agent gains its first or loses its last SSH grant", () => {
  let stored = { revision: 0, sshAccesses: [] };
  const access = {
    get: () => stored,
    prepare: (_id, input, revision) => ({ ...stored, ...input, revision: revision + 1 }),
    write: (_id, next) => (stored = next),
    auditSsh() {},
  };
  const teams = { transaction: (fn) => fn(), policy: () => null };
  const assistants = { changed() {} };
  const save = (sshAccesses) =>
    saveWork({ assistants, access, teams }, "a", {
      access: { revision: stored.revision, sshAccesses },
    });
  assert.equal(save([{ accessId: "h", mode: "trusted" }]).sshToolChanged, true);
  assert.equal(save([{ accessId: "h", mode: "approval" }]).sshToolChanged, false);
  assert.equal(save([]).sshToolChanged, true);
  assert.equal(save([]).sshToolChanged, false);
});
