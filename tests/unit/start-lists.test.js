import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  agentFilters,
  agentRank,
  agentState,
  filterList,
  matchesWords,
  searchWords,
  sessionFilters,
  sessionItems,
  sessionProject,
  sessionTime,
  shownRows,
  SESSION_LIMIT,
} from "../../web/features/dashboard/start-lists.js";
import { longListSessions } from "../fixtures/long-lists.js";

const names = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };
const items = () => sessionItems(longListSessions(), (tool) => names[tool] || tool);

test("running sessions sort waiting, working, ready, unknown, then by latest activity", () => {
  const { rows, counts } = filterList(items(), {
    filters: sessionFilters,
    filter: "running",
    query: "",
  });
  assert.deepEqual(counts, {
    running: 18,
    waiting: 2,
    working: 5,
    ready: 10,
    stopped: 6,
  });
  assert.deepEqual(
    rows.slice(0, 8).map((row) => row.session.name),
    [
      "Kanji-Quiz",
      "Migration prüfen",
      "Systemstatus",
      "Tilemap-Export",
      "Refactoring Auth",
      "Offline-Karten Tests",
      "Rechnungsmodul",
      "Shell",
    ],
  );
  assert.equal(rows.at(-1).session.name, "CI-Pipeline", "unknown comes last");
  assert.ok(rows.every((row) => row.state !== "stopped"));
});

test("each chip keeps only its states; stopped sessions show only under Stopped", () => {
  const all = items();
  const pick = (filter) =>
    filterList(all, { filters: sessionFilters, filter, query: "" }).rows.map(
      (row) => row.state,
    );
  assert.deepEqual(new Set(pick("waiting")), new Set(["waiting"]));
  assert.deepEqual(new Set(pick("ready")), new Set(["idle", "terminal"]));
  assert.deepEqual(new Set(pick("stopped")), new Set(["stopped"]));
  assert.equal(pick("stopped").length, 6);
});

test("search matches every word against name, project and tool, and the counts follow", () => {
  const all = items();
  const { rows, counts } = filterList(all, {
    filters: sessionFilters,
    filter: "running",
    query: "  bilen CLAUDE ",
  });
  assert.deepEqual(
    rows.map((row) => row.session.name),
    ["Migration prüfen", "Rechnungsmodul"],
  );
  assert.deepEqual(counts, { running: 2, waiting: 1, working: 1, ready: 0, stopped: 0 });
  const none = filterList(all, {
    filters: sessionFilters,
    filter: "running",
    query: "zzz",
  });
  assert.deepEqual(none.rows, []);
  assert.equal(none.counts.running, 0);
});

test("projects come from the repository, else the folder; a shell names none", () => {
  assert.equal(sessionProject({ repositoryName: "repo", cwd: "/a/b" }), "repo");
  assert.equal(sessionProject({ cwd: "/work/agent-pier/" }), "agent-pier");
  assert.equal(sessionProject({ cwd: "C:\\work\\epochs" }), "epochs");
  assert.equal(sessionProject({ tool: "shell", cwd: "/work" }), "");
  assert.equal(sessionProject({}), "");
});

test("the activity time falls back to the session record", () => {
  assert.equal(
    sessionTime({ activity: { since: "2026-10-27T10:00:00Z" } }),
    Date.parse("2026-10-27T10:00:00Z"),
  );
  assert.equal(
    sessionTime({ updatedAt: "2026-10-27T09:00:00Z" }),
    Date.parse("2026-10-27T09:00:00Z"),
  );
  assert.equal(sessionTime({ createdAt: "bad" }), 0);
});

test("a card shows its limit until expanded", () => {
  const rows = Array.from({ length: 18 }, (_, index) => index);
  assert.equal(shownRows(rows, SESSION_LIMIT, false).length, 6);
  assert.equal(shownRows(rows, SESSION_LIMIT, true).length, 18);
  assert.equal(shownRows(rows.slice(0, 3), SESSION_LIMIT, false).length, 3);
});

test("agents sort as needs you, working, ready, offline", () => {
  const agent = (name, tone, time = 0) => {
    const state = agentState(tone);
    return { name, state, rank: agentRank(state), time, search: [name] };
  };
  const list = [
    agent("Offline", "muted"),
    agent("Ready", "ready"),
    agent("Busy", "working"),
    agent("Unclear", "attention"),
    agent("Missing", "missing"),
    agent("Approval", "waiting"),
  ];
  const { rows, counts } = filterList(list, {
    filters: agentFilters,
    filter: "all",
    query: "",
  });
  assert.deepEqual(
    rows.map((row) => row.name),
    ["Approval", "Unclear", "Busy", "Ready", "Missing", "Offline"],
  );
  assert.deepEqual(counts, { all: 6, needsYou: 2, working: 1, ready: 1 });
});

test("any filter is a subset of the search result and the search never adds rows", () => {
  const all = items();
  fc.assert(
    fc.property(
      fc.constantFrom(...Object.keys(sessionFilters)),
      fc.string({ maxLength: 6 }),
      (filter, query) => {
        const words = searchWords(query);
        const { rows, counts } = filterList(all, {
          filters: sessionFilters,
          filter,
          query,
        });
        assert.equal(rows.length, counts[filter]);
        for (const row of rows) assert.ok(matchesWords(row.search, words));
        const plain = filterList(all, { filters: sessionFilters, filter, query: "" });
        assert.ok(rows.length <= plain.rows.length);
      },
    ),
  );
});
