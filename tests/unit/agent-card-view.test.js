import test from "node:test";
import assert from "node:assert/strict";
import {
  tickKey,
  withPendingTicks,
  withoutAdjacentMarkers,
} from "../../web/features/assistants/cards/card-view.js";
import {
  shownHistory,
  withLive,
  emptyHistoryView,
} from "../../web/features/assistants/agent-history-view.js";
import { agentCardsCopy as en } from "../../web/lib/i18n/en/agent-cards.js";
import { agentCardsCopy as de } from "../../web/lib/i18n/de/agent-cards.js";

const moved = (id, n) => ({ id: `card:${id}:${n}`, cardMoved: { id, title: "T" } });
const card = (id, n) => ({ id: `card:${id}:${n}`, card: { id } });
const say = (id) => ({ id, role: "user", text: id });

test("a marker the card follows directly is left out; one with messages between stays", () => {
  const rows = [
    say("a"),
    moved("c1", 1),
    say("b"),
    moved("c1", 2),
    moved("c1", 3),
    card("c1", 4),
    moved("c2", 1),
    card("c1", 5),
  ];
  assert.deepEqual(
    withoutAdjacentMarkers(rows).map((m) => m.id),
    ["a", "card:c1:1", "b", "card:c1:4", "card:c2:1", "card:c1:5"],
  );
});

test("the shown history leaves such markers out", () => {
  const view = withLive(emptyHistoryView, {
    messages: [moved("c1", 1), card("c1", 2)],
    requests: [],
    nextBefore: null,
  });
  assert.deepEqual(
    shownHistory(view).messages.map((m) => m.id),
    ["card:c1:2"],
  );
});

test("pending ticks show on their version only", () => {
  const shown = {
    version: 2,
    blocks: [
      {
        type: "checklist",
        id: "c",
        items: [{ id: "milk", text: "Milk", checked: false }],
      },
    ],
  };
  assert.equal(
    withPendingTicks(shown, new Map([[tickKey(2, 0, "milk"), true]]))[0].items[0].checked,
    true,
  );
  assert.equal(
    withPendingTicks(shown, new Map([[tickKey(1, 0, "milk"), true]]))[0].items[0].checked,
    false,
  );
});

test("German and English card copy have the same keys", () => {
  const keys = (copy) => Object.keys(copy).sort();
  assert.deepEqual(keys(de), keys(en));
  assert.deepEqual(keys(de.states), keys(en.states));
  assert.match(en.moved("Plan"), /Plan/);
});
