// ⌘K finds the groups inside an agent's tabs under their own names (AGENTPIER-445):
// hooks, reminders, routines, check-ins, shell access and member groups, in German and
// English, each opening the tab that shows it.
import test from "node:test";
import assert from "node:assert/strict";
import { routePath } from "../../web/app/routes.js";
import { buildSearchIndex } from "../../web/app/search-entries.js";
import { searchEntries } from "../../web/app/search-index.js";

const index = buildSearchIndex({
  agents: [
    { id: "ops", name: "Ops-Wache", capabilities: { memory: true } },
    { id: "usr", name: "Mias Agent", userAccess: { mode: "own", members: [] } },
    { id: "tmp", name: "Helfer", teamMemberId: "m-1", lifetime: "permanent" },
  ],
  agentsEnabled: true,
});
const hits = (query) =>
  searchEntries(index, query).flatMap((group) => group.items.map((item) => item.id));
const entry = (id) => index.find((item) => item.id === id);

test("each group is found by its own name in both languages", () => {
  for (const [group, queries, path] of [
    ["hooks", ["Ops Hooks"], "/agents/ops/settings?tab=automation"],
    [
      "reminders",
      ["Ops Reminders", "Ops Erinnerungen"],
      "/agents/ops/settings?tab=automation",
    ],
    ["routines", ["Ops Routines", "Ops Routinen"], "/agents/ops/settings?tab=automation"],
    [
      "check-ins",
      ["Ops check in on its own", "Ops sich von selbst melden"],
      "/agents/ops/settings?tab=automation",
    ],
    [
      "shell",
      [
        "Ops shell access",
        "Ops Shell-Zugriff",
        "Ops automatic review",
        "Ops automatische Prüfung",
      ],
      "/agents/ops/settings?tab=capabilities",
    ],
    [
      "member-groups",
      ["Ops member groups", "Ops Mitgliedergruppen", "Ops Gruppen"],
      "/agents/ops/settings?tab=team",
    ],
  ]) {
    const id = `agent:ops:group:${group}`;
    for (const query of queries) assert.ok(hits(query).includes(id), `${query} → ${id}`);
    assert.equal(routePath(entry(id).target.route), path, group);
  }
});

test("Routines is a name of its own, not only a former one", () => {
  const routines = entry("agent:ops:group:routines");
  assert.equal(routines.label.en, "Ops-Wache · Routines");
  assert.equal(routines.label.de, "Ops-Wache · Routinen");
  assert.equal(routines.path.en, "Agents › Ops-Wache › Automation › Routines");
});

test("a group shows only where its agent has it", () => {
  // A user's own agent: her reminders, routines and hooks are hers; no shell; no team.
  for (const group of ["routines", "reminders", "hooks", "shell", "member-groups"])
    assert.equal(entry(`agent:usr:group:${group}`), undefined, group);
  assert.ok(entry("agent:usr:group:check-ins"));
  // A team member has no Team tab of its own.
  assert.equal(entry("agent:tmp:group:member-groups"), undefined);
});

test("an agent's Android devices are found while the host offers devices", () => {
  const agents = [
    { id: "ops", name: "Ops-Wache" },
    { id: "usr", name: "Mias Agent", userAccess: { mode: "own", members: [] } },
    { id: "perm", name: "Helfer", teamMemberId: "m-1", lifetime: "permanent" },
    { id: "task", name: "Kurier", teamMemberId: "m-2", lifetime: "temporary" },
    { id: "old", name: "Altlast", archivedAt: "2026-01-01T00:00:00Z" },
  ];
  const offered = buildSearchIndex({
    agents,
    agentsEnabled: true,
    devicesAvailable: true,
  });
  const found = (query) =>
    searchEntries(offered, query).flatMap((group) => group.items.map((item) => item.id));
  const own = offered.find((item) => item.id === "agent:ops:group:devices");
  assert.equal(own.label.en, "Ops-Wache · Android devices");
  assert.equal(own.label.de, "Ops-Wache · Android-Geräte");
  assert.equal(own.path.en, "Agents › Ops-Wache › Access › Android devices");
  assert.equal(own.path.de, "Agenten › Ops-Wache › Zugriffe › Android-Geräte");
  assert.equal(routePath(own.target.route), "/agents/ops/settings?tab=access");
  for (const query of [
    "Ops Android devices",
    "Ops Android-Geräte",
    "Ops emulator",
    "Ops Handy",
    "Ops Gerät zuweisen",
  ])
    assert.ok(found(query).includes(own.id), query);
  // A member's devices are set on its own Access tab, permanent or temporary.
  for (const id of ["perm", "task"])
    assert.equal(
      routePath(
        offered.find((item) => item.id === `agent:${id}:group:devices`).target.route,
      ),
      `/agents/${id}/settings?tab=access`,
    );
  // Never for an agent of restricted users or an archived one.
  for (const id of ["usr", "old"])
    assert.equal(
      offered.find((item) => item.id === `agent:${id}:group:devices`),
      undefined,
      id,
    );
  // Without devices on this host, or with agents off, there is no such entry.
  for (const options of [
    { agentsEnabled: true },
    { agentsEnabled: true, devicesAvailable: false },
    { agentsEnabled: false, devicesAvailable: true },
  ])
    assert.ok(
      !buildSearchIndex({ agents, ...options }).some((item) =>
        item.id.endsWith(":group:devices"),
      ),
    );
});
