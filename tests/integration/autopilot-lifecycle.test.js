import test from "node:test";
import "../helpers/composer-writes.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { AutopilotOrders } from "../../server/features/autopilot/autopilot-orders.js";
import { projectScope } from "../../server/features/memory/project-scope.js";
import { OrderStore } from "../../server/features/autopilot/order-store.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ap-order-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.email=t@example.test",
    "-c",
    "user.name=test",
    "commit",
    "--allow-empty",
    "-qm",
    "initial",
  ]);
  const project = await projectScope(repo);
  const input = {
    requestId: "one",
    projectId: project.id,
    session: { tool: "codex" },
    title: "Same",
    brief: "Plan a migration",
  };
  const sessions = new Map();
  const starts = [],
    notifications = [];
  let failCleanup = false,
    refuseCleanup = false;
  const resources = {
    async start(ctx, { notify }) {
      if (!ctx.resources?.sessionId) {
        starts.push(ctx.id);
        await ctx.saveResources({ sessionId: ctx.id });
        sessions.set(ctx.id, { id: ctx.id, status: "running" });
      }
      if (notify) notifications.push(ctx.resumeId);
    },
    inspectSession: async (ctx) => sessions.get(ctx.id) ?? null,
    async cleanup(_ctx, { begin }) {
      if (refuseCleanup) throw new Error("busy");
      await begin();
      if (failCleanup) throw new Error("interrupted");
    },
  };
  function open() {
    const store = new OrderStore({
      dataDir: path.join(root, "data"),
      projects: () => [project],
    });
    t.after(() => store.close());
    const orders = new AutopilotOrders({
      store,
      resources,
      view: ({ ref, document, session, limitations }) => ({
        limitations,
        ...document,
        id: ref.id,
        cleanup: !!ref.cleanup,
        session,
      }),
    });
    return { store, orders, resources };
  }
  return {
    open,
    repo,
    input,
    starts,
    notifications,
    refuse: (value) => (refuseCleanup = value),
    interrupt: (value) => (failCleanup = value),
  };
}

test("two request identities own independent orders, policy and pause survive retry and restart", async (t) => {
  const f = await fixture(t);
  const { orders, store } = f.open();
  const [one, retry, two] = await Promise.all([
    orders.create(f.input),
    orders.create(f.input),
    orders.create({ ...f.input, requestId: "two" }),
  ]);
  assert.equal(one.id, retry.id);
  assert.notEqual(one.id, two.id);
  assert.equal(f.starts.length, 2);
  assert.equal(one.implementationAuthorized, false);
  await orders.policy(one.id, { allowMerge: true });
  await orders.pause(one.id);
  assert.equal((await orders.create(f.input)).manualPaused, true);
  store.close();
  const restarted = f.open().orders;
  assert.equal((await restarted.get(one.id)).allowMerge, true);
  assert.equal((await restarted.get(two.id)).allowMerge, false);
  assert.equal((await restarted.get(two.id)).manualPaused, false);
  await Promise.all([restarted.resume(one.id, {}), restarted.resume(one.id, {})]);
  assert.equal(f.notifications.length, 1);
  assert.equal(f.starts.length, 2);
  assert.equal((await restarted.get(one.id)).implementationAuthorized, false);
});

test("cleanup checks completion, journals after preflight and can finish on retry", async (t) => {
  const f = await fixture(t);
  const { orders, store } = f.open();
  const { id } = await orders.create(f.input);
  await assert.rejects(orders.remove(id), { code: "AUTOPILOT_CLEANUP_UNAVAILABLE" });
  await store.update(id, (doc) => ({ ...doc, status: "completed" }));
  f.refuse(true);
  await assert.rejects(orders.remove(id), /busy/);
  assert.equal(Boolean((await store.get(id)).ref.cleanup), false);
  f.refuse(false);
  f.interrupt(true);
  await assert.rejects(orders.remove(id), /interrupted/);
  assert.ok((await store.get(id)).ref.cleanup);
  await assert.rejects(orders.resume(id, {}));
  store.close();
  f.interrupt(false);
  const restarted = f.open().orders;
  await restarted.remove(id);
  assert.deepEqual(await restarted.list(), { orders: [] });
  await assert.rejects(restarted.create(f.input), { status: 410 });
});

test("a mismatched session is reported on its own order and cannot hide other orders", async (t) => {
  const f = await fixture(t);
  const { orders, resources } = f.open();
  const first = await orders.create(f.input);
  const second = await orders.create({ ...f.input, requestId: "two" });
  const inspect = resources.inspectSession;
  resources.inspectSession = (ctx) => {
    if (ctx.id === first.id)
      throw Object.assign(new Error("different cwd"), {
        code: "AUTOPILOT_OWNERSHIP_MISMATCH",
      });
    return inspect(ctx);
  };
  const { orders: listed } = await orders.list();
  const mismatch = listed.find((o) => o.id === first.id);
  assert.equal(mismatch.session, null);
  assert.ok(mismatch.limitations.includes("sessionOwnershipMismatch"));
  assert.equal(listed.find((o) => o.id === second.id).session.id, second.session.id);
});
