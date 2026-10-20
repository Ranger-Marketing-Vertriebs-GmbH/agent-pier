import test from "node:test";
import assert from "node:assert/strict";
import {
  SessionLedger,
  absoluteDuration,
  idleDuration,
} from "../../server/features/login/session-ledger.js";
const day = 24 * 60 * 60 * 1000;
function fixture() {
  let time = Date.UTC(2026, 0, 1);
  let saves = 0;
  const rows = [];
  const ledger = new SessionLedger({ rows, save: () => saves++, now: () => time });
  return {
    rows,
    ledger,
    saves: () => saves,
    advance: (duration) => {
      time += duration;
    },
    now: () => time,
  };
}
test("ledger caps sessions per principal", () => {
  const f = fixture();
  const owner = f.ledger.issue();
  f.advance(1000);
  const tokens = [];
  for (let i = 0; i < 21; i++) {
    tokens.push(f.ledger.issue({ userId: "u1" }));
    f.advance(1000);
  }
  assert.equal(f.rows.filter((row) => row.userId === "u1").length, 20);
  assert.ok(f.ledger.find(owner));
  assert.equal(f.ledger.find(tokens[0]), null);
  assert.ok(f.ledger.find(tokens[1]));
  assert.ok(f.ledger.find(tokens[20]));
});
test("revokeWhere closes every watcher of matching rows", (t) => {
  const f = fixture();
  const closed = [];
  const watch = (token, name) => {
    const cleanup = f.ledger.watch(f.ledger.find(token), () => closed.push(name));
    t.after(cleanup);
  };
  watch(f.ledger.issue({ userId: "u1" }), "a");
  watch(f.ledger.issue({ userId: "u1" }), "b");
  const owner = f.ledger.issue();
  watch(owner, "owner");
  f.ledger.revokeWhere((row) => row.userId === "u1");
  assert.deepEqual(closed.sort(), ["a", "b"]);
  assert.ok(f.ledger.find(owner));
  assert.equal(f.rows.length, 1);
});
test("renew never passes the absolute cap", () => {
  const f = fixture();
  const token = f.ledger.issue();
  const created = f.now();
  const row = f.ledger.find(token);
  assert.equal(row.expires, created + idleDuration);
  f.advance(idleDuration / 2 - 1000);
  assert.equal(f.ledger.renew(row), null);
  f.advance(-(idleDuration / 2 - 1000));
  for (let elapsed = 0; elapsed < 80 * day; elapsed += 10 * day) {
    f.advance(10 * day);
    f.ledger.renew(f.ledger.find(token));
  }
  assert.equal(f.ledger.find(token).expires, created + absoluteDuration);
  f.advance(day / 2);
  assert.equal(f.ledger.renew(f.ledger.find(token)), null);
  f.advance(created + absoluteDuration - f.now());
  assert.equal(f.ledger.find(token), null);
});
test("expired rows are pruned on issue", () => {
  const f = fixture();
  f.ledger.issue({ userId: "u1" });
  f.advance(idleDuration);
  f.ledger.issue();
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0].userId, undefined);
});
