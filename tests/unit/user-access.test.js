import test from "node:test";
import assert from "node:assert/strict";
import {
  isShared,
  isUserAgent,
  memberLevel,
  userLevels,
  validateUserAccess,
} from "../../server/features/users/user-access.js";

const users = {
  get(id) {
    if (!["anna", "ben"].includes(id))
      throw Object.assign(new Error("missing"), { status: 404 });
    return { id };
  },
};
const own = { mode: "own", members: [{ userId: "anna", level: "chat" }] };
const refused = (value) =>
  assert.throws(() => validateUserAccess(value, users), {
    status: 400,
    code: "USER_AGENT_ACCESS_INVALID",
  });

test("an own agent serves exactly one known user", () => {
  assert.deepEqual(validateUserAccess(own, users), { ...own, released: [] });
  refused({ ...own, members: [...own.members, { userId: "ben", level: "chat" }] });
  refused({ ...own, members: [] });
  refused({ ...own, members: [{ userId: "carla", level: "chat" }] });
});

test("a shared agent takes several users once each", () => {
  const shared = {
    mode: "shared",
    members: [
      { userId: "anna", level: "extended" },
      { userId: "ben", level: "personalize" },
    ],
    released: ["webSearch", "browser"],
  };
  assert.deepEqual(validateUserAccess(shared, users), {
    ...shared,
    released: ["browser", "webSearch"],
  });
  refused({ ...shared, members: [shared.members[0], shared.members[0]] });
  refused({ ...shared, mode: "family" });
  refused({ ...shared, extra: true });
});

test("levels are validated", () => {
  assert.deepEqual(userLevels, ["chat", "personalize", "extended"]);
  refused({ ...own, members: [{ userId: "anna", level: "admin" }] });
  refused({ ...own, members: [{ userId: "anna", level: "chat", role: "owner" }] });
});

test("released capabilities are web capabilities only", () => {
  refused({ ...own, released: ["shell"] });
  refused({ ...own, released: ["memory"] });
  refused({ ...own, released: ["webSearch", "webSearch"] });
  refused({ ...own, released: "webSearch" });
});

test("membership helpers read the assignment", () => {
  const agent = { userAccess: { mode: "shared", members: own.members, released: [] } };
  assert.equal(isUserAgent(agent), true);
  assert.equal(isUserAgent({}), false);
  assert.equal(isShared(agent), true);
  assert.equal(isShared({ userAccess: own }), false);
  assert.equal(memberLevel(agent, "anna"), "chat");
  assert.equal(memberLevel(agent, "ben"), null);
  assert.equal(memberLevel({}, "anna"), null);
});
