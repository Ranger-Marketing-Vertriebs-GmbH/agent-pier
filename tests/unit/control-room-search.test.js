import test from "node:test";
import assert from "node:assert/strict";
import { buildSearchIndex } from "../../web/app/search-entries.js";
import { searchEntries } from "../../web/app/search-index.js";
import { routePath } from "../../web/app/routes.js";
import { buildUserSearchIndex } from "../../web/features/users/user-search-entries.js";

const find = (query, entries) =>
  searchEntries(entries, query).flatMap((group) => group.items);

test("Control Room aliases and creation are available in either language", () => {
  const entries = buildSearchIndex({});
  for (const query of ["Control Room", "Autopilot", "Composer", "Aufträge", "Orders"]) {
    assert.ok(
      find(query, entries).some((item) => item.target.route?.view === "control-room"),
      query,
    );
  }
  for (const query of ["New order", "Neuer Auftrag"]) {
    assert.equal(
      routePath(find(query, entries)[0].target.route),
      "/control-room/new",
      query,
    );
  }
});

test("quick open limits order actions to the owner and the controls on screen", () => {
  const offered = ["autopilot-policy", "autopilot-pause", "autopilot-remove"];
  const entries = buildSearchIndex({ offered });
  for (const [query, id] of [
    ["Edit permissions", offered[0]],
    ["Pause order", offered[1]],
    ["Remove order", offered[2]],
  ]) {
    assert.equal(find(query, entries)[0].target.pending, id);
    assert.ok(!buildSearchIndex({}).some((entry) => entry.target.pending === id));
  }
  assert.ok(
    !buildUserSearchIndex().some(
      (entry) =>
        entry.target.route?.view === "control-room" ||
        offered.includes(entry.target.pending),
    ),
  );
});
