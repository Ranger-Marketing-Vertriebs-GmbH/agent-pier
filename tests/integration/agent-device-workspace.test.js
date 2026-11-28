import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { agentDevicesFixture } from "../helpers/agent-devices-fixture.js";
import { WORKSPACE_CHANGED } from "../../server/features/assistants/agent-devices.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import { setAgentDeviceAccess } from "../../server/features/devices/agent-device-access.js";
import { WORKSPACE_MISPLACED } from "../../server/features/devices/agent-device-grants.js";

// Which folder counts as an agent's workspace for files to and from a device
// (agent-device-grants.js `area`), through the owner's route function and the real
// bridge: only the workspace folder itself, at its place below the workspaces root.
const save = (f, agent, device) =>
  setAgentDeviceAccess(f.services, agent, {
    devices: [{ deviceId: device.id, manage: false }],
    create: false,
  });
const recorded = (f, agent) => f.grants.entries.get(agent.id)?.area ?? null;
const push = (f, file) =>
  f
    .call({ action: "push", device: "Pixel", path: file, devicePath: "/sdcard/x" })
    .then(() => null, toolError);
const pushes = (f) => f.adb.filter(({ args }) => args[0] === "push").length;

test("a link in the workspace's place is never recorded, by the owner's save or a first transfer", async (t) => {
  const f = await agentDevicesFixture(t);
  const pixel = await f.device("Pixel");
  const agent = f.lead();
  const workspace = path.join(f.dataDir, "workspaces", agent.id);
  fs.writeFileSync(path.join(f.dataDir, "host-secret.txt"), "TOKEN");
  // The owner saves the devices before the agent has a workspace: nothing to record.
  save(f, agent, pixel);
  assert.equal(recorded(f, agent), null);
  // Then a link to AgentPier's data folder stands where the workspace belongs.
  fs.mkdirSync(path.dirname(workspace), { recursive: true });
  fs.symlinkSync(f.dataDir, workspace);
  for (const file of ["host-secret.txt", "devices/agent-grants.json"]) {
    const error = await push(f, file);
    assert.equal(error?.code, "DEVICE_PATH_OUTSIDE", file);
    assert.ok(error.reason.includes(WORKSPACE_MISPLACED), error.reason);
  }
  assert.equal(recorded(f, agent), null);
  // The owner's save does not take the link for the workspace either.
  save(f, agent, pixel);
  assert.equal(recorded(f, agent), null);
  assert.equal((await push(f, "host-secret.txt"))?.code, "DEVICE_PATH_OUTSIDE");
  // Nor a link to a folder outside AgentPier.
  const outside = fs.mkdtempSync(path.join(fs.realpathSync(f.dataDir), "..", "outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "id_rsa"), "KEY");
  fs.rmSync(workspace);
  fs.symlinkSync(outside, workspace);
  save(f, agent, pixel);
  assert.equal(recorded(f, agent), null);
  assert.equal((await push(f, "id_rsa"))?.code, "DEVICE_PATH_OUTSIDE");
  assert.equal(pushes(f), 0);
  // The workspace folder itself is recorded and used.
  fs.rmSync(workspace);
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "a.txt"), "x");
  assert.equal(await push(f, "a.txt"), null);
  assert.equal(recorded(f, agent).path, fs.realpathSync(workspace));
  assert.equal(pushes(f), 1);
});

test("a folder recorded elsewhere than the workspace's place is refused at every use", async (t) => {
  const f = await agentDevicesFixture(t);
  const pixel = await f.device("Pixel");
  const agent = f.lead();
  const workspace = f.workspace(agent);
  fs.writeFileSync(path.join(workspace, "a.txt"), "x");
  fs.writeFileSync(path.join(f.dataDir, "host-secret.txt"), "TOKEN");
  save(f, agent, pixel);
  const own = recorded(f, agent);
  assert.equal(own.path, fs.realpathSync(workspace));
  // A record as an earlier version could have written it through a link: the data
  // folder itself, which still is that very folder.
  const stat = fs.statSync(f.dataDir, { bigint: true });
  const elsewhere = {
    path: fs.realpathSync(f.dataDir),
    dev: String(stat.dev),
    ino: String(stat.ino),
  };
  f.grants.entries.set(agent.id, { ...f.grants.entries.get(agent.id), area: elsewhere });
  for (const file of ["host-secret.txt", "workspaces/" + agent.id + "/a.txt"]) {
    const error = await push(f, file);
    assert.equal(error?.code, "DEVICE_PATH_OUTSIDE", file);
    assert.ok(error.reason.includes(WORKSPACE_CHANGED), error.reason);
  }
  assert.equal(pushes(f), 0);
  // The owner's save records the workspace folder again: the repair.
  save(f, agent, pixel);
  assert.deepEqual(recorded(f, agent), own);
  assert.equal(await push(f, "a.txt"), null);
});

test("the owner's save keeps the recorded workspace and records a restored one", async (t) => {
  const f = await agentDevicesFixture(t);
  const pixel = await f.device("Pixel");
  const agent = f.lead();
  const workspace = f.workspace(agent);
  fs.writeFileSync(path.join(workspace, "a.txt"), "x");
  save(f, agent, pixel);
  const first = recorded(f, agent);
  // A save while the folder is the recorded one changes nothing of the record.
  save(f, agent, pixel);
  assert.deepEqual(recorded(f, agent), first);
  // The workspace is restored from a backup: another folder at the same place.
  fs.renameSync(workspace, `${workspace}.old`);
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "a.txt"), "restored");
  const error = await push(f, "a.txt");
  assert.equal(error?.code, "DEVICE_PATH_OUTSIDE");
  assert.ok(error.reason.includes(WORKSPACE_CHANGED));
  // No use records it; the owner's next save of the agent's devices does.
  assert.deepEqual(recorded(f, agent), first);
  save(f, agent, pixel);
  assert.notDeepEqual(recorded(f, agent), first);
  assert.equal(recorded(f, agent).path, first.path);
  assert.equal(await push(f, "a.txt"), null);
  // A save while a link stands in the workspace's place keeps the earlier record,
  // which then refuses.
  const second = recorded(f, agent);
  fs.renameSync(workspace, `${workspace}.kept`);
  fs.symlinkSync(`${workspace}.kept`, workspace);
  save(f, agent, pixel);
  assert.deepEqual(recorded(f, agent), second);
  assert.equal((await push(f, "a.txt"))?.code, "DEVICE_PATH_OUTSIDE");
});
