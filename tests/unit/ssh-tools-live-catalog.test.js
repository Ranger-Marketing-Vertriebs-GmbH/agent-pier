import test from "node:test";
import assert from "node:assert/strict";
import { watchSshCatalog } from "../../server/features/ssh/live-topics.js";
import { sshManagementFixture } from "../helpers/ssh-management.js";

function recordingHub() {
  const calls = [];
  return { calls, invalidate: (...args) => calls.push(args) };
}

test("a management-socket write refreshes every session's SSH panel", async (t) => {
  const f = await sshManagementFixture(t);
  const hub = recordingHub();
  let live = null;
  const stop = watchSshCatalog(f.management.catalog, () => live);
  t.after(stop);
  const one = await f.session("one");
  // Before the live hub exists a write is simply not announced.
  await one.call("ssh_generate_key", { name: "Early", requestId: "early" });
  live = hub;
  await one.call("ssh_generate_key", { name: "Deploy", requestId: "deploy" });
  // No session id: the topic of every session, not just the writer's.
  assert.deepEqual(hub.calls, [["job.ssh-tools"]]);
  // A read changes nothing.
  await one.call("ssh_list_keys", {});
  assert.equal(hub.calls.length, 1);
  // Owner edits through the same catalog are announced the same way.
  await f.management.ui("createKey", { name: "Owner", projectId: null });
  assert.deepEqual(hub.calls, [["job.ssh-tools"], ["job.ssh-tools"]]);
  stop();
  await one.call("ssh_generate_key", { name: "Later", requestId: "later" });
  assert.equal(hub.calls.length, 2);
});
