import test from "node:test";
import assert from "node:assert/strict";
import { agentsOf, ownsAgents } from "../../web/features/users/owner-users-api.js";

const own = (id, userId, extra = {}) => ({
  id,
  name: id,
  userAccess: { mode: "own", members: [{ userId, level: "chat" }] },
  ...extra,
});

test("an archived own agent still asks what happens to it when she is deleted", () => {
  const assistants = [
    own("lotta", "u-1", { archivedAt: "2026-10-20T00:00:00.000Z" }),
    {
      id: "family",
      name: "family",
      userAccess: { mode: "shared", members: [{ userId: "u-2", level: "chat" }] },
    },
  ];
  // Her list leaves the archived agent out; deleting her still needs a choice.
  assert.deepEqual(agentsOf(assistants, "u-1"), []);
  assert.equal(ownsAgents(assistants, "u-1"), true);
  assert.equal(ownsAgents(assistants, "u-2"), false);
});
