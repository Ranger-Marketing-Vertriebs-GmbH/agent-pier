import test from "node:test";
import assert from "node:assert/strict";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import { agentSshFixture, hostId } from "../helpers/agent-ssh-fixture.js";

test("a routine refused on a host that is not trusted for routines records a note", async (t) => {
  const f = await agentSshFixture(t);
  const notes = [];
  f.assistants.routines = { noteRefusal: (key, note) => notes.push([key, note]) };
  f.grant([{ accessId: hostId, mode: "trusted" }]);
  const inv = f.routineTurn();
  const error = await f.execute(inv, "process.exit(0)").catch((e) => e);
  assert.equal(toolError(error).code, "SSH_ROUTINE_NOT_TRUSTED");
  assert.deepEqual(notes, [[inv.sessionKey, "ssh_refused"]]);
});
