import test from "node:test";
import assert from "node:assert/strict";
import { groupLead } from "../helpers/member-group-fixture.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";

const refused = (promise, key, code) =>
  assert.rejects(promise, (error) => {
    assert.equal(error.key, key);
    if (code) assert.equal(toolError(error).code, code);
    return true;
  });

test("a lead creates, renames and deletes groups with unique names", async (t) => {
  const f = await groupLead(t);
  const research = await f.create("Research");
  const listed = await f.groups({ action: "list" });
  assert.deepEqual(
    listed.groups.map((g) => [g.name, g.members]),
    [["Research", []]],
  );
  // Every permanent member starts without a group; the temporary one is not listed.
  assert.deepEqual(
    listed.ungrouped.map((m) => m.memberId).sort(),
    f.permanents.map((m) => m.id).sort(),
  );
  await refused(f.create("research"), "memberGroupNameTaken", "GROUP_NAME_TAKEN");
  await refused(f.create("   "), "memberGroupName", "GROUP_NAME_INVALID");
  await refused(f.create("x".repeat(61)), "memberGroupName", "GROUP_NAME_INVALID");
  const renamed = await f.groups({ action: "rename", groupId: research, name: "Build" });
  assert.equal(renamed.groups[0].name, "Build");
  const deleted = await f.groups({ action: "delete", groupId: research });
  assert.equal(deleted.deleted, research);
  assert.deepEqual(deleted.groups, []);
  await refused(
    f.groups({ action: "rename", groupId: research, name: "Again" }),
    "memberGroupNotFound",
    "GROUP_NOT_FOUND",
  );
});

test("a retried create tool call makes one group", async (t) => {
  const f = await groupLead(t);
  const inv = f.turn();
  const first = await f.service.groups(inv, { action: "create", name: "Research" });
  const again = await f.service.groups(inv, { action: "create", name: "Research" });
  assert.equal(again.groupId, first.groupId);
  assert.equal(f.stored().length, 1);
});

test("members move into a group, between groups and out of one, always in one group at most", async (t) => {
  const f = await groupLead(t);
  const [a, b] = f.permanents;
  const research = await f.create("Research");
  const build = await f.create("Build");
  // Ungrouped → group: an existing member, created long before the group.
  let view = await f.move(a.id, research);
  assert.deepEqual(view.moved, { memberId: a.id, groupId: research });
  assert.deepEqual(f.groupOf(a.id), [research]);
  assert.ok(!view.ungrouped.some((m) => m.memberId === a.id));
  await f.move(b.id, research);
  // Group A → group B directly: one step, never in both and never in none.
  view = await f.move(a.id, build);
  assert.deepEqual(f.groupOf(a.id), [build]);
  assert.deepEqual(
    view.groups.map((g) => [g.name, g.members.map((m) => m.memberId)]),
    [
      ["Research", [b.id]],
      ["Build", [a.id]],
    ],
  );
  // Moving it where it already is changes nothing.
  await f.move(a.id, build);
  assert.deepEqual(f.groupOf(a.id), [build]);
  // Group → ungrouped.
  view = await f.ungroup(a.id);
  assert.deepEqual(f.groupOf(a.id), []);
  assert.ok(view.ungrouped.some((m) => m.memberId === a.id));
  // An empty group stays until deleted.
  assert.deepEqual(view.groups.find((g) => g.groupId === build).members, []);
});

test("a move to a group that does not exist is refused and changes nothing", async (t) => {
  const f = await groupLead(t);
  const [a] = f.permanents;
  const research = await f.create("Research");
  await f.move(a.id, research);
  await refused(f.move(a.id, "no-such-group"), "memberGroupNotFound", "GROUP_NOT_FOUND");
  assert.deepEqual(f.groupOf(a.id), [research]);
  // Another lead's group is not this lead's either.
  const other = f.store.createAssistant({
    name: "Other",
    instructions: "",
    model: { connectionId: "c", modelId: "m" },
  });
  const foreign = f.service.ownerGroups("create", other.id, "Elsewhere");
  await refused(f.move(a.id, foreign.id), "memberGroupNotFound");
  assert.deepEqual(f.groupOf(a.id), [research]);
});

test("only permanent members of the lead can be grouped", async (t) => {
  const f = await groupLead(t);
  const research = await f.create("Research");
  await refused(
    f.move(f.temporary.id, research),
    "memberGroupNotPermanent",
    "GROUP_MEMBER_NOT_PERMANENT",
  );
  await assert.rejects(f.move("unknown-member", research), { status: 404 });
});

test("an archived member leaves its group for good; the group stays", async (t) => {
  const f = await groupLead(t);
  const [a, b] = f.permanents;
  const research = await f.create("Research");
  await f.move(a.id, research);
  await f.move(b.id, research);
  await f.service.lifecycle("archive", a.id, f.service.store.member(a.id).revision);
  assert.deepEqual(f.groupOf(a.id), []);
  assert.deepEqual(f.groupOf(b.id), [research]);
  // Restored, it comes back without a group.
  await f.service.lifecycle("restore", a.id, f.service.store.member(a.id).revision);
  assert.deepEqual(f.groupOf(a.id), []);
  // Once its last member is archived the group is empty, and still there.
  await f.service.lifecycle("archive", b.id, f.service.store.member(b.id).revision);
  assert.deepEqual(
    f.stored().map((g) => [g.id, g.memberIds]),
    [[research, []]],
  );
});

test("a member deleted from the store disappears from its group's list", async (t) => {
  const f = await groupLead(t);
  const [a] = f.permanents;
  const research = await f.create("Research");
  await f.move(a.id, research);
  f.service.store.db.prepare("DELETE FROM assistant_team_records WHERE id=?").run(a.id);
  const [group] = f.service.memberGroups.list(f.parent.id);
  assert.deepEqual(group.memberIds, []);
});

test("the owner manages the same groups, and the list carries them", async (t) => {
  const f = await groupLead(t);
  const [a] = f.permanents;
  const group = f.service.ownerGroups("create", f.parent.id, "Research");
  f.service.ownerGroups("move", f.parent.id, a.id, group.id);
  f.service.ownerGroups("rename", f.parent.id, group.id, "Scouts");
  const listed = f.service.list().groups;
  assert.deepEqual(
    listed.map((g) => [g.name, g.memberIds, g.parentAssistantId]),
    [["Scouts", [a.id], f.parent.id]],
  );
  // The lead sees the owner's change.
  const view = await f.groups({ action: "list" });
  assert.deepEqual(view.groups[0].members, [{ memberId: a.id, name: "Member 1" }]);
  f.service.ownerGroups("move", f.parent.id, a.id, null);
  f.service.ownerGroups("remove", f.parent.id, group.id);
  assert.deepEqual(f.service.list().groups, []);
});

test("a user's agent never groups members", async (t) => {
  const f = await groupLead(t);
  const user = f.store.createAssistant({
    name: "Hers",
    instructions: "",
    model: { connectionId: "c", modelId: "m" },
  });
  f.store.db
    .prepare(
      "UPDATE assistants SET body=json_set(body,'$.userAccess',json(?)) WHERE id=?",
    )
    .run(JSON.stringify({ userId: "u1", mode: "own" }), user.id);
  assert.throws(() => f.service.ownerGroups("create", user.id, "Research"), {
    code: "USER_AGENT_LOCKED",
  });
});

test("the members tool and the lead's roster name each member's group", async (t) => {
  const f = await groupLead(t);
  const [a] = f.permanents;
  const research = await f.create("Research");
  await f.move(a.id, research);
  const listed = f.service.members(f.turn(), {});
  assert.equal(listed.members.find((m) => m.memberId === a.id).group, "Research");
  assert.equal(
    listed.members.find((m) => m.memberId === f.temporary.id).group,
    undefined,
  );
  const roster = f.service.requests.roster(f.parent.id);
  assert.ok(roster.members.some((m) => m.group === "Research"));
});

test("the group tools refuse unknown actions and keys", async (t) => {
  const f = await groupLead(t);
  await assert.rejects(f.groups({ action: "explode" }), { status: 400 });
  await assert.rejects(f.groups({ action: "create", name: "A", extra: 1 }), {
    status: 400,
  });
  await assert.rejects(f.groups({ action: "move", memberId: f.permanents[0].id }), {
    status: 400,
  });
});
