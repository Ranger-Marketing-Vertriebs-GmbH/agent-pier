// Moving a project's ticket sequence to a new project id (a rebind or a merge):
// inside the queue locks, without stepping, and keeping the copy of a ticket that is
// further along. Fake sessions and GitHub, temp dirs only.
import test from "node:test";
import assert from "node:assert/strict";
import { TicketRuleStore } from "../../server/features/tickets/rule-store.js";
import { ticketProjectMoves } from "../../server/features/tickets/project-moves.js";
import { KEY, sequenceFixture } from "../helpers/sequence-fixture.js";

const entry = (key) => ({
  source: "github",
  key,
  title: `Fix ${key}`,
  url: "",
  kind: "session",
  options: { allowMerge: false, session: { tool: "claude", accountId: "a1" } },
});
const until = async (check) => {
  for (let i = 0; i < 400 && !check(); i += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check());
};

function movesFor(f, engine) {
  return ticketProjectMoves({
    ticketStore: f.ticketStore,
    rules: new TicketRuleStore({ dataDir: f.dataDir }),
    store: f.store,
    engine,
    live: () => null,
  });
}

test("a move before the engine starts launches and parks nothing", async (t) => {
  const f = await sequenceFixture(t);
  const engine = f.build({ intervalMs: 60_000, initialDelayMs: 0 });
  f.store.append("p9", f.repoPath, [entry(KEY)]);
  await movesFor(f, engine).moveProject("p9", "p1");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(
    f.items().map((item) => [item.key, item.state]),
    [[KEY, "waiting"]],
  );
  assert.equal(f.launched.length, 0);
  assert.equal(f.store.queue("p9"), null);
  // Once started, the engine's first pass takes it on.
  engine.start();
  await until(() => f.launched.length === 1);
});

test("a move after the engine started nudges the moved queue", async (t) => {
  const f = await sequenceFixture(t);
  const engine = f.build({ intervalMs: 60_000, initialDelayMs: 0 });
  engine.start();
  await until(() => engine.started);
  f.store.append("p9", f.repoPath, [entry(KEY)]);
  await movesFor(f, engine).moveProject("p9", "p1");
  await until(() => f.launched.length === 1);
});

test("a ticket active in both queues keeps the copy that is further along", async (t) => {
  const f = await sequenceFixture(t);
  const engine = f.build({ intervalMs: 60_000, initialDelayMs: 0 });
  // p9 runs #12 with a session and waits for #14; p1 has #12 and #14 waiting, plus #13.
  f.store.append("p9", f.repoPath, [entry(KEY), entry("acme/app#14")]);
  const running = f.store.queue("p9").items[0];
  f.store.patch("p9", running.id, { state: "running", sessionId: "s-live" });
  f.store.append("p1", f.repoPath, [
    entry(KEY),
    entry("acme/app#13"),
    entry("acme/app#14"),
  ]);
  const waiting14 = f.store.queue("p1").items[2];
  await movesFor(f, engine).moveProject("p9", "p1");
  const items = f.items();
  assert.deepEqual(
    items.map((item) => [item.key, item.state]),
    [
      [KEY, "running"],
      ["acme/app#13", "waiting"],
      ["acme/app#14", "waiting"],
    ],
  );
  // The running copy replaced the waiting one; on a tie the target's copy stays.
  assert.equal(items[0].id, running.id);
  assert.equal(items[0].sessionId, "s-live");
  assert.equal(items[2].id, waiting14.id);
  for (const key of [KEY, "acme/app#13", "acme/app#14"])
    assert.equal(
      items.filter((item) => item.key === key && item.state !== "done").length,
      1,
    );
  assert.equal(f.launched.length, 0);
});
