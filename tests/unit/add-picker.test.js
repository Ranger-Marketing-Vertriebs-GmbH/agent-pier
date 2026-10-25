import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultRowLimit,
  filterCandidates,
  initialPickerState,
  isSelectable,
  itemsToAdd,
  keyIntent,
  markGranted,
  moveActive,
  pickerReducer,
  visibleRows,
} from "../../web/components/add-picker.js";
import { addPickerCopy as de } from "../../web/lib/i18n/de/components.js";
import { addPickerCopy as en } from "../../web/lib/i18n/en/components.js";

// The inline add field (docs/ui-guide.md#rows-and-controls, handoff 5.5): filtering,
// already granted items, selection, mode and keyboard intents.
const hosts = [
  { id: "web1", name: "prod-web-01", sub: "deploy@10.0.4.21", group: "Global" },
  { id: "web2", name: "prod-web-02", sub: "deploy@10.0.4.22", group: "Global" },
  { id: "db2", name: "prod-db-02", sub: "deploy@10.0.4.12", group: "api-server" },
  { id: "nas", name: "backup-nas", sub: "backup@10.0.9.2" },
];
const run = (actions, state = initialPickerState("approval")) =>
  actions.reduce(pickerReducer, state);

test("filtering matches name, sub line and group, every word, ignoring case", () => {
  assert.deepEqual(
    filterCandidates(hosts, "PROD").map((host) => host.id),
    ["web1", "web2", "db2"],
  );
  assert.deepEqual(
    filterCandidates(hosts, "10.0.9").map((host) => host.id),
    ["nas"],
  );
  assert.deepEqual(
    filterCandidates(hosts, "api-server").map((host) => host.id),
    ["db2"],
  );
  assert.deepEqual(
    filterCandidates(hosts, "prod 22").map((host) => host.id),
    ["web2"],
  );
  assert.equal(filterCandidates(hosts, "  "), hosts);
  assert.deepEqual(filterCandidates(hosts, "nothing"), []);
});

test("already granted items are marked and cannot be chosen", () => {
  const marked = markGranted(hosts, ["web1"]);
  assert.equal(marked[0].granted, true);
  assert.equal(marked[1].granted, undefined);
  assert.equal(markGranted(hosts, []), hosts);
  assert.equal(markGranted(hosts, new Set(["nas"]))[3].granted, true);
  assert.equal(isSelectable(marked[0]), false);
  assert.equal(isSelectable(marked[1]), true);
  assert.equal(isSelectable(undefined), false);
  const state = run([{ type: "toggle", candidate: marked[0] }]);
  assert.deepEqual(state.selected, []);
});

test("toggling selects and deselects, across filter changes", () => {
  const state = run([
    { type: "query", query: "prod" },
    { type: "toggle", candidate: hosts[1] },
    { type: "toggle", candidate: hosts[2] },
    { type: "query", query: "nas" },
    { type: "toggle", candidate: hosts[3] },
  ]);
  assert.deepEqual(
    state.selected.map((host) => host.id),
    ["web2", "db2", "nas"],
  );
  const again = pickerReducer(state, { type: "toggle", candidate: hosts[2] });
  assert.deepEqual(
    again.selected.map((host) => host.id),
    ["web2", "nas"],
  );
});

test("typing opens the list and clears the active option", () => {
  const state = run([{ type: "query", query: "p" }]);
  assert.equal(state.open, true);
  assert.equal(state.active, -1);
  assert.equal(state.query, "p");
  const moved = run([{ type: "move", intent: "next", rows: hosts }], state);
  assert.equal(moved.active, 0);
  assert.equal(run([{ type: "query", query: "pr" }], moved).active, -1);
});

test("arrow moves open the list first, then skip granted rows and stop at the ends", () => {
  const rows = markGranted(hosts, ["web1", "db2"]);
  let state = run([{ type: "move", intent: "next", rows }]);
  assert.deepEqual([state.open, state.active], [true, -1]);
  state = run([{ type: "move", intent: "next", rows }], state);
  assert.equal(state.active, 1);
  state = run([{ type: "move", intent: "next", rows }], state);
  assert.equal(state.active, 3);
  state = run([{ type: "move", intent: "next", rows }], state);
  assert.equal(state.active, 3);
  state = run([{ type: "move", intent: "previous", rows }], state);
  assert.equal(state.active, 1);
  state = run([{ type: "move", intent: "previous", rows }], state);
  assert.equal(state.active, 1);
  assert.equal(moveActive(rows, -1, "previous"), 3);
  assert.equal(moveActive(rows, 3, "first"), 1);
  assert.equal(moveActive(rows, 1, "last"), 3);
  assert.equal(
    moveActive(markGranted(hosts, ["web1", "web2", "db2", "nas"]), 0, "next"),
    -1,
  );
});

test("Space toggles the active row and Enter adds the checked items or the active one", () => {
  const rows = markGranted(hosts, ["web1"]);
  let state = run([
    { type: "open" },
    { type: "move", intent: "next", rows },
    { type: "toggleActive", rows },
  ]);
  assert.deepEqual(
    state.selected.map((host) => host.id),
    ["web2"],
  );
  state = run([{ type: "move", intent: "next", rows }], state);
  assert.deepEqual(
    itemsToAdd(state, rows).map((host) => host.id),
    ["web2"],
  );
  const none = run([{ type: "open" }]);
  assert.deepEqual(itemsToAdd(none, rows), []);
  const activeOnly = run([{ type: "move", intent: "next", rows }], none);
  assert.deepEqual(
    itemsToAdd(activeOnly, rows).map((host) => host.id),
    ["web2"],
  );
  assert.deepEqual(itemsToAdd({ ...activeOnly, active: 0 }, rows), []);
});

test("the mode applies to new items and survives a reset", () => {
  let state = run([
    { type: "mode", mode: "trusted" },
    { type: "query", query: "prod" },
    { type: "toggle", candidate: hosts[1] },
  ]);
  assert.equal(state.mode, "trusted");
  state = pickerReducer(state, { type: "reset" });
  assert.deepEqual(state, initialPickerState("trusted"));
  assert.equal(pickerReducer(state, { type: "unknown" }), state);
});

test("closing keeps the checked items for the next opening", () => {
  const state = run([
    { type: "query", query: "prod" },
    { type: "toggle", candidate: hosts[1] },
    { type: "close" },
  ]);
  assert.equal(state.open, false);
  assert.equal(state.selected.length, 1);
  assert.equal(run([{ type: "open" }], state).selected.length, 1);
});

test("keys map to intents; Space and Home/End act on the list only with an active row", () => {
  const closed = { open: false, active: -1 };
  const typing = { open: true, active: -1 };
  const inList = { open: true, active: 2 };
  assert.equal(keyIntent("ArrowDown", closed), "next");
  assert.equal(keyIntent("ArrowUp", typing), "previous");
  assert.equal(keyIntent("Home", inList), "first");
  assert.equal(keyIntent("End", inList), "last");
  assert.equal(keyIntent("Home", typing), null);
  assert.equal(keyIntent(" ", inList), "toggle");
  assert.equal(keyIntent(" ", typing), null);
  assert.equal(keyIntent("Enter", typing), "add");
  assert.equal(keyIntent("Enter", closed), null);
  assert.equal(keyIntent("Escape", inList), "close");
  assert.equal(keyIntent("Escape", closed), "clear");
  assert.equal(keyIntent("a", inList), null);
});

test("long lists render a capped number of rows and count the rest", () => {
  const many = Array.from({ length: 600 }, (_, index) => ({
    id: String(index),
    name: `host-${index}`,
  }));
  const { rows, hidden } = visibleRows(many);
  assert.equal(rows.length, defaultRowLimit);
  assert.equal(hidden, 600 - defaultRowLimit);
  assert.deepEqual(visibleRows(hosts, 10), { rows: hosts, hidden: 0 });
  const started = performance.now();
  for (let index = 0; index < 50; index += 1) filterCandidates(many, `host-${index}`);
  assert.ok(performance.now() - started < 200, "filtering 600 items stays fast");
});

test("the copy pluralises the count and the add button in both languages", () => {
  assert.equal(de.add(0), "Hinzufügen");
  assert.equal(de.add(3), "3 hinzufügen");
  assert.equal(en.add(0), "Add");
  assert.equal(en.add(1), "Add 1");
  assert.equal(en.add(3), "Add 3");
  assert.equal(de.matches(1), "1 Treffer");
  assert.equal(en.matches(1), "1 match");
  assert.equal(en.matches(9), "9 matches");
  assert.equal(de.placeholder("SSH-Zugang"), "SSH-Zugang hinzufügen …");
  assert.equal(en.placeholder("SSH access"), "Add SSH access …");
  assert.equal(de.alreadyGranted, "hat er schon");
  assert.equal(en.alreadyGranted, "already granted");
});
