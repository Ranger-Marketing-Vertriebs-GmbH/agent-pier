import test from "node:test";
import assert from "node:assert/strict";
import { groupedMembers } from "../../web/features/assistants/member-group-view.js";
import {
  groupMenuItems,
  memberMenuItems,
} from "../../web/features/assistants/settings/member-group-menu.js";
import { internalTurnText } from "../../web/features/assistants/internal-turn-text.js";
import { assistantTeamCopy as en } from "../../web/lib/i18n/en/assistant-team.js";
import { assistantTeamCopy as de } from "../../web/lib/i18n/de/assistant-team.js";

const agent = (id) => ({ id, name: id.toUpperCase() });
const permanent = [agent("a"), agent("b"), agent("c")];
const members = permanent.map((a) => ({ id: `m-${a.id}`, assistantId: a.id }));

test("permanent members sit under their lead's groups, the rest without a group", () => {
  const groups = [
    { id: "g1", parentAssistantId: "lead", name: "Research", memberIds: ["m-b", "m-a"] },
    { id: "g2", parentAssistantId: "lead", name: "Empty", memberIds: ["m-gone"] },
    { id: "g3", parentAssistantId: "other", name: "Other", memberIds: ["m-c"] },
  ];
  const view = groupedMembers("lead", permanent, members, groups);
  assert.deepEqual(
    view.groups.map(({ group, children }) => [group.name, children.map((c) => c.id)]),
    [
      ["Research", ["b", "a"]],
      ["Empty", []],
    ],
  );
  assert.deepEqual(
    view.ungrouped.map((c) => c.id),
    ["c"],
  );
  // A member named twice is shown once, under its first group.
  const twice = groupedMembers("lead", permanent, members, [
    groups[0],
    { ...groups[1], memberIds: ["m-a"] },
  ]);
  assert.deepEqual(twice.groups[1].children, []);
});

test("a member's menu moves it between groups and out of its group", () => {
  const moves = [];
  const groups = [
    { id: "g1", name: "Research" },
    { id: "g2", name: "Build" },
  ];
  const items = memberMenuItems({
    groups,
    current: groups[0],
    onMove: (id) => moves.push(id),
    onNewGroup: () => moves.push("new"),
  });
  const [move, , remove] = items;
  assert.deepEqual(
    move.items.map((i) => [i.label, i.checked]),
    [
      ["Research", true],
      ["Build", false],
      [move.items[2].label, undefined],
    ],
  );
  move.items[0].run();
  move.items[1].run();
  move.items[2].run();
  remove.run();
  assert.deepEqual(moves, ["g2", "new", null]);
  // Without a group there is nothing to remove it from.
  const ungrouped = memberMenuItems({
    groups,
    current: null,
    onMove() {},
    onNewGroup() {},
  });
  assert.equal(ungrouped.length, 1);
  assert.deepEqual(
    groupMenuItems({ onRename() {}, onDelete() {} }).map((i) => i.id),
    ["rename", "separator", "delete"],
  );
});

test("a group's results turn names the group in both languages", () => {
  for (const copy of [en, de]) {
    const line = internalTurnText({ team: copy }, "member-result", undefined, "Research");
    assert.match(line, /Research/);
    assert.notEqual(line, copy.internalTurns["member-result"]);
  }
});
